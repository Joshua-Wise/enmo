# Temperature Alarms

**Know a closet is in trouble before the equipment does.**

Live temperature and humidity monitoring for the network closets across a school district. A NodeMCU board with a DHT11 sensor (or a more accurate DHT22 or SHT31) sits in each closet and posts a Reading every 30 seconds. The backend works out which Conditions a closet is in (Hot, Cold, Dry, Mold risk, Sensor fault, Offline) and pushes every Reading to every open dashboard the moment it arrives.

![The dashboard on the demo, worst first: 24 closets across four campuses, three needing attention, led by a closet in Hot critical, then Mold risk high and Dry](docs/screenshots/dashboard-dark.png)

- **Live, not polled.** Cards update over Server-Sent Events. A Device that goes quiet reads as late, then Offline, with no reload.
- **Decided once, on the server.** Thresholds, Conditions, and Online or Offline are computed in one place, so every browser shows the same truth.
- **Worst first.** The Dashboard leads with the closet in the worst Condition, and a closet that worsens rises to the top as it happens; "By Campus" restores the familiar order.
- **What happened overnight.** The server records every incident (a Condition at warning or worse) as it starts, changes level, and ends. The Incidents page lays a night, a day, or a week out as a log on one shared ruler.
- **The district in one look.** The Campuses page puts every school on one row, worst first, with what it is in now, its worst closet, a week of daily highs against the Hot line, and the time since its last incident.
- **An email when it matters.** Optionally, the server emails your technicians, through the district's SMTP relay, when an incident starts, gets worse, or ends; a campus-wide outage arrives as one email ([Email notifications](DEPLOYMENT.md#email-notifications)).
- **A day of history per Device.** Min, max, and average for each measure, any day in the last 90.
- **Sign in, as an Admin or a Viewer.** Every page needs a username and password; Admins change things and manage users on Settings, Viewers look. A shared token stays for scripts, and another is flashed into every board.
- **One command to run it.** A Docker Compose stack: MySQL, the backend, and nginx on a single port, the same on a laptop and on the district server.

## Quick start

You need Docker (Docker Desktop on a laptop, Docker Engine with the Compose plugin on a server).

```bash
git clone https://github.com/HamzaQaz/Temperature-Alarms-React.git
cd Temperature-Alarms-React
cp .env.example .env        # set ADMIN_TOKEN, DEVICE_TOKEN, DB_PASSWORD, DB_ROOT_PASSWORD (openssl rand -hex 32 each)
docker compose up -d --build
```

Open `http://localhost/` and sign in as `admin` / `admin`; the site asks for a new password first. On **Settings**, add a Campus, and add a Device with the hostname `ESP_000001`. To see its card come alive without a board, run the virtual Device that ships in the stack as that hostname:

```bash
docker compose exec api node scripts/mock-device.mjs --hostname ESP_000001
```

The database lives on a named volume, so it survives `docker compose down`; `docker compose down -v` wipes it. The volume is named after the folder you cloned into (`temperature-alarms-react_db-data` here), so run the stack from the same folder, or pin the name with `COMPOSE_PROJECT_NAME` in `.env` as DEPLOYMENT.md explains. [`DEPLOYMENT.md`](DEPLOYMENT.md) covers upgrades, backups, TLS, and the manual install for a server that cannot run Docker.

## See it without hardware

One command brings up a living dashboard with no boards attached:

```bash
deploy/deploy.sh demo          # Windows: powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1 demo
```

Open `http://localhost:8080/` (`--web-port` picks another port). Four fictional schools and 24 closets appear, each with a week of history, and they keep reporting every 30 seconds. On a ten-minute loop one closet heats up through Hot warning to Hot critical and recovers, one dries out, one sits in Mold risk moderate then high, one goes cold, and one goes silent (late, then Offline) and comes back; the rest stay calm. Sign in as `admin` / `admin`; the site then asks for a new password. The script also prints the throwaway Admin token, for scripts.

The demo runs under its own Compose project, `temperature-alarms-demo`, with its own database volume and generated secrets in `.env.demo`, so it never touches a real install's data. `deploy/deploy.sh demo --down` removes it, volume and `.env.demo` included. The pieces are `compose.demo.yaml` and `backend/scripts/demo.mjs`.

## Screenshots

All taken on the demo above.

- [Dashboard, light theme](docs/screenshots/dashboard-light.png)
- [Incidents](docs/screenshots/incidents.png): the last 7 days as a log on one shared ruler, each incident segmented by level
- [Campuses](docs/screenshots/campuses.png): every Campus worst first, with its week of daily highs against the Hot warning line
- [Dashboard filtered to one Campus](docs/screenshots/dashboard-campus.png), with the Gym closet in Hot critical
- [History for one Device](docs/screenshots/history.png): the day's averages, the chart, and the Readings table, on the day it climbed into Hot
- [Settings](docs/screenshots/settings.png) on the Devices table (taken before sign-in, ADR 0010)
- On a phone: [Dashboard](docs/screenshots/phone-dashboard.png) and [History](docs/screenshots/phone-history.png)
- [A card escalating](docs/screenshots/escalation.gif) from Hot warning to Hot critical: the new border is traced from the badge around the card

## How it works

```
 closet                          server                              laptop
┌──────────────┐   POST /api/readings   ┌──────────────────┐   SSE /api/dashboard/stream   ┌───────────┐
│ NodeMCU      │ ─────────────────────▶ │ Express backend  │ ────────────────────────────▶ │ React     │
│ + DHT11      │   every 30 s,          │ one process      │   one message per Reading     │ dashboard │
│ (a Device)   │   Device token         │ Conditions here  │                               │           │
└──────────────┘                        └────────┬─────────┘                               └───────────┘
                                                 │ readings, devices, campuses
                                                 ▼
                                        ┌──────────────────┐
                                        │ MySQL 8          │  90 days of raw Readings
                                        └──────────────────┘
```

A Device identifies itself by hostname, `ESP_` plus the last six hex digits of its MAC, and that is what you register in Settings. There is no configuration on the board beyond WiFi, the server URL, and the Device token. The backend is a single process on purpose: the SSE fan-out and the per-Device rate limit live in memory, which keeps the whole thing simple enough to run anywhere.

The vocabulary used throughout the code and docs is defined in [`CONTEXT.md`](CONTEXT.md). The decisions behind the architecture are recorded as ADRs:

| ADR | Decision |
| --- | --- |
| [0001](docs/adr/0001-http-post-from-devices-sse-to-browsers.md) | HTTP POST from Devices, SSE to browsers, a single backend process |
| [0002](docs/adr/0002-single-readings-table.md) | One `readings` table instead of one table per Device |
| [0003](docs/adr/0003-shared-tokens-not-user-accounts.md) | Two shared tokens instead of user accounts |
| [0004](docs/adr/0004-ninety-day-raw-retention.md) | Ninety days of raw Readings, nothing rolled up |
| [0005](docs/adr/0005-docker-compose-runs-the-whole-system.md) | One Docker Compose file, built from the clone |

## Repository layout

```
.
├── arduino/       # ESP8266 sketch for the NodeMCU Device (DHT11, DHT22 or SHT31), its wiring diagram, and the bench watcher
├── backend/       # Express + TypeScript API, MySQL, the migration runner, the virtual Device
├── frontend/      # React + TypeScript + Vite, Tailwind, shadcn/ui; src/pages/ holds Dashboard, Incidents, Campuses, History and Settings; e2e/ holds the browser walk
├── deploy/        # deploy.sh and deploy.ps1: install, upgrade, back up, and remove the stack, here or over ssh
├── docs/adr/      # Architecture decision records
├── .claude/skills/deploy/  # The skill that lets a Claude agent drive the deploy scripts
├── compose.yaml   # The whole system: db, api, and web on one port
├── .env.example   # The stack's settings; copy to .env
├── CONTEXT.md     # Domain vocabulary
├── PRODUCT.md     # Who it is for and how it should feel
├── DESIGN.md      # Tokens, type, components
└── DEPLOYMENT.md  # Running it for real
```

## Working on the code

Run the two packages by hand when you are changing them; each reloads on save. You need Node.js 22.18 or newer (the frontend's tests run TypeScript on Node directly, which needs it; the images use Node 22 too) and a MySQL 8 the backend can use; the stack's `db` is not published, so it is not that one.

**Backend**

```bash
cd backend
npm install
cp .env.example .env   # fill in database credentials and the two tokens
npm run dev            # http://localhost:3001
```

The backend creates and upgrades the schema itself on start through its migration runner. It refuses to start without `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `ADMIN_TOKEN`, and `DEVICE_TOKEN`, naming whatever is missing. `backend/.env.example` lists every setting the server reads.

**Frontend**

```bash
cd frontend
npm install
cp .env.example .env   # VITE_API_URL points at the backend
npm run dev            # http://localhost:5173
```

`VITE_API_URL` is the only setting the frontend reads. Unset, every request goes to the page's own origin, which is how `frontend/Dockerfile` builds it for the stack; the dev server needs it set because Vite serves on its own port.

**Root shortcuts**

```bash
npm run install:all
npm run dev:backend
npm run dev:frontend
npm run build:all
npm run start:backend
```

**A virtual Device**

To watch the dashboard react without a board, run the virtual Device against your dev backend. It posts a Reading every interval with the Device token and logs in the firmware's style, so `report: 404` means the hostname is not registered yet:

```bash
cd backend
node scripts/mock-device.mjs --hostname ESP_000001 --token dev-device --interval 30
node scripts/mock-device.mjs --hostname ESP_000002 --count 3       # three Readings, then silence: watch the card go Offline
```

Against the stack, the same script runs inside the `api` container with `docker compose exec api node scripts/mock-device.mjs ...`, where the token and port are already set.

### Tests and checks

The backend suite runs every route through the Express app against a real MySQL, so it needs a database it can wipe. `backend/docker-compose.yml` provides one: MySQL 8.4 on `127.0.0.1:3307`, data in tmpfs, gone on `down`.

```bash
cd backend
npm run test:db        # docker compose up, waits for healthy
npm test               # node --test, one file at a time
npm run typecheck      # tsc over src and test
npm run test:db:down   # docker compose down -v
```

Without Docker, point the suite at any MySQL 8 you can spare with `TEST_DATABASE_URL=mysql://user:password@host:port/database`. The database name must contain `test`: the suite drops every table in it before each test.

The frontend has no component tests. Two of its pure modules, report timing (the countdown and the age of a Reading) and the API base address, have unit tests that run on Node's own test runner and type stripping, so there is nothing extra to install; lint and typecheck cover the rest, and `npm run build` runs the typecheck first.

```bash
cd frontend
npm test               # node --test over src/**/*.test.ts
npm run lint           # eslint
npm run typecheck      # tsc -b, including the tests
```

The bench watcher's logic has unit tests on Python's own runner, with the esptool and serial layer faked, so no board and no extra package is needed: `python -m unittest arduino/test_bench.py` from the repo root.

All three pass on a clean clone; run them before a commit. The dashboard card shows "Expected Ns ago" once a Device misses a report, and Offline once the server has declared it (three missed reports); the page asks the server again at that moment, since the browser never computes a Condition itself.

#### The browser walk

`frontend/e2e/walk.mjs` drives the whole system in a headless browser: signing in (as a throwaway Admin it adds with the Admin token and deletes at the end) and a Viewer's Settings, Campus and Device changes with their refusals, a Reading going live on a card over SSE, the Campus filter, the rate limit, History, reset, phone width, and the deletes. Run it against an empty stack, never a live one (it adds and deletes Campuses and Devices, and resets a History), with Playwright installed once:

```bash
cd frontend && npm install --no-save playwright && npx playwright install chromium
ADMIN_TOKEN=... DEVICE_TOKEN=... WEB=http://localhost node e2e/walk.mjs          # the stack; API defaults to WEB
ADMIN_TOKEN=... DEVICE_TOKEN=... WEB=http://localhost:5173 API=http://localhost:3001 node e2e/walk.mjs   # dev servers
```

It prints one line per check and exits non-zero if any failed. A second argument names a folder for screenshots.

### CI

GitHub Actions (`.github/workflows/ci.yml`) runs the checks above on every push and pull request, each in its own job, and the run's page shows which one failed:

- **Backend**: both typechecks (`npm run typecheck`, then the production build's `tsc --noEmit -p tsconfig.json`) and `npm test` against a MySQL 8.4 service container.
- **Frontend**: typecheck, lint, test, build.
- **Firmware**: `arduino-cli` compiles `arduino/TemperatureAlarms` from `config.example.h` once for each `SENSOR_TYPE` (DHT11, DHT22, SHT31), with the esp8266 core and the library versions in [Libraries and board settings](#libraries-and-board-settings); the run's summary lists each build's RAM, IRAM, and flash. The core and libraries are cached between runs.
- **Bench watcher**: `python3 -m unittest arduino/test_bench.py`.
- **Deploy scripts**: shellcheck 0.11 over `deploy.sh`, `real-ip.sh`, and their tests, then `deploy.test.sh` and `real-ip.test.sh`, on Linux; `deploy.test.ps1` under PowerShell 7 and Windows PowerShell 5.1, on Windows.
- **Images**: the api and frontend images, built from their Dockerfiles once everything above has passed, so a broken Dockerfile shows before `master`.

A newer push to a branch or pull request cancels its run in progress. When a version in the libraries table changes, change it in the workflow's `firmware` job too; arduino-cli and shellcheck are pinned there as well, each with the checksum of its download.

On `master` the same run publishes build artifacts, and nothing more:

- the images, pushed only once every other job has passed, as `ghcr.io/hamzaqaz/temperature-alarms-react-api` and `ghcr.io/hamzaqaz/temperature-alarms-react-frontend`, each tagged with the commit's full SHA and `latest`. The first push creates each package on GitHub; set who can pull it in the package's settings.
- the three firmware builds, `firmware-DHT11-unsigned`, `firmware-DHT22-unsigned`, and `firmware-SHT31-unsigned`, each attached by its own compile job, under Artifacts on the run's page.

Those firmware builds prove the code compiles and show its size; they are not for boards. They carry `config.example.h`'s placeholder WiFi, server, and Device token, and they are unsigned, so the server refuses them and a board flashed with one never updates over the air. Production builds are still made on the build laptop with the real `config.h` and the keys ([Updating boards over the air](#updating-boards-over-the-air)). The workflow holds no secret beyond the run's own `GITHUB_TOKEN` and deploys nowhere: servers still build the stack from source ([Deployment](#deployment)).

## API

Every response with a body is JSON. Errors carry `{ "error": "<message>" }` with the status: 400 for malformed JSON, 401 for no session or a missing or wrong token, 403 for a browser origin that is not allowed or a user whose role does not allow it, 415 for a change made with the session cookie that is not JSON, 404 for an unknown Campus or Device, 409 for a conflict, 422 for a body that failed validation, 429 when a rate limit is hit. Shortcodes and hostnames are stored upper-case, so `chs` and `CHS` name the same Campus.

| Route | Auth | Request and response |
| --- | --- | --- |
| `POST /api/session` | none | `{username, password}` → `{user: {id, username, role}, mustChangePassword}` and the session cookie (`ta_session`, `HttpOnly`, `SameSite=Strict`, `Path=/api`, `Secure` over HTTPS); 401 "Wrong username or password" for any failure; 429 after 10 failures for a username or 30 from an address in 15 minutes (only failures count). A JSON body only |
| `GET /api/session` | Session | Who is signed in, as above; 401 when no one is |
| `DELETE /api/session` | Session | 204; signs out, and the session's open streams close |
| `POST /api/session/password` | Session | `{currentPassword, newPassword}` → as `GET`; your own password, 8 to 200 characters; ends your other sessions. The one change a session still on `admin`'s first password may make |
| `GET /api/users` | Admin | `[{id, username, role, disabled, createdAt, lastSignInAt}]` by username |
| `POST /api/users` | Admin | `{username, role, password}` → 201 user; `username` 1 to 64 of letters, digits, `. _ @ -`, unique ignoring case (409); `role` `admin` or `viewer`; a starting password of 8 or more |
| `PATCH /api/users/:id` | Admin | `{role?, disabled?, password?}` → the user. Disabling or a new password ends their sessions at once. 409 for the last enabled Admin (demote, disable) or disabling yourself |
| `DELETE /api/users/:id` | Admin | 204; their sessions end. 409 for the last enabled Admin or yourself |
| `GET /api/health` | none | `{status, database}`; 503 when the database cannot be reached or the latest Reading could not be written, and `{status: "stopping"}` with 503 once the backend has been told to stop |
| `GET /api/campuses` | Signed in | `[{id, name, shortcode}]` by name |
| `GET /api/campuses/overview?tz=America/Chicago` | Signed in | `{timeZone, threshold, campuses}` for IT leadership: every Campus, worst first by its worst closet now (as the dashboard ranks Devices), then by name. Each is `{id, name, shortcode, closets, level, now, worst, days, lastIncident}`: `now.conditions` counts closets per Condition and level at warning or worse, and `now.headsUp` counts moderate Mold risk apart; `worst` is the worst closet with its `latestReading`, `level`, `offline`, and `conditions` (null with no Devices); `days` is the last seven local days in `tz` (the server's zone by default; an unknown one is 422), oldest first, each with its bounds, `maxTempF` (null with no Readings), `incident`, true when an incident overlapped it, and `incidentLevel`, the worst level an incident reached that day (null without one); today is `partial`. `lastIncident` is `{ongoing: true, start}` while one is open, else `{ongoing: false, end}` for the latest to close within the retention window, else null. `threshold` is the Hot warning line the server uses, for the chart, and `retentionDays` how far back Readings (and so the last incident) reach. The completed days' highs are reused for up to five minutes; today's are read on every request. Example below |
| `POST /api/campuses` | Admin | `{name, shortcode, notifyTo?}` → 201 Campus; 409 when the shortcode exists. `notifyTo` is the Campus's own email recipients, comma-separated (or an array), each a bare address as `NOTIFY_TO` takes them, 1000 characters at most (422 otherwise); empty or absent emails `NOTIFY_TO` (ADR 0008) |
| `GET /api/campuses/recipients` | Admin | `[{id, notifyTo}]` by name: each Campus's own recipients, `[]` for one that emails `NOTIFY_TO`. Kept out of the public list |
| `PATCH /api/campuses/:id` | Admin | `{notifyTo}` replaces the Campus's own recipients (`""` or `[]` for `NOTIFY_TO` again) → `{id, name, shortcode, notifyTo}`; 422 without `notifyTo` or with a bad address, 404 for an unknown Campus |
| `DELETE /api/campuses/:id` | Admin | 204; 409 while the Campus still has Devices |
| `GET /api/devices` | Signed in | `[{id, hostname, closet, campus, tokenMismatchAt}]` by Campus name, then closet. `tokenMismatchAt` is when the board was last refused for its Device token (a Reading or firmware check claiming that hostname with a wrong token), within the last 15 minutes and not since followed by an accepted Reading; otherwise null. Anyone can claim a hostname, so it is a hint, not proof |
| `POST /api/devices` | Admin | `{hostname, campusId, closet}` → 201 Device; hostname must be `ESP_` plus six hex digits; 409 when it exists; 422 when the Campus does not |
| `PATCH /api/devices/:id` | Admin | `{closet?, campusId?}` → the updated Device. The hostname never changes: a replaced board is a new Device, and a body carrying `hostname` is 422 |
| `DELETE /api/devices/:id` | Admin | 204; the Device's Readings and incidents go with it |
| `GET /api/firmware` | Device | The boards' hourly update check (ADR 0007): the Device token as Basic credentials `device:<token>` (or a Bearer header), with the ESP8266 update library's `x-ESP8266-STA-MAC` and `x-ESP8266-version` headers. 304 when there is nothing newer for that board, otherwise 200 with the signed image (`application/octet-stream`, `x-MD5`). Records the version the board reported. 400 without a MAC, 404 for an unregistered board. Shares the Readings route's wrong-token limit |
| `POST /api/firmware?only=ESP_A,ESP_B` | Admin | Publishes a signed build, the request body as `application/octet-stream` (up to 1 MB), to every Device or only those named → 201 `{version, size, md5, publishedAt, only, offeredTo}`, `offeredTo` saying who it reaches: "Offered to ESP_64533B (CHS IDF 2, running 4)", or "Offered to every Device (12)". A name may be typed as the board's log shows it (`ESP-64533B`), in any case, or as the six hex digits alone. 422, before anything is stored, for a name no Device is registered under (naming it), for every Device when none is registered, for an unsigned image, one without a version marker, or a version lower than the published one (the same version again changes who it is offered to) |
| `DELETE /api/firmware` | Admin | 204; no build is offered until the next publish |
| `GET /api/firmware/status` | Admin | `{release, progress, rollout, devices}`: the published build (or null) with `offeredTo`; `progress`, each Device it is offered to, stuck ones first, with its `step` (`waiting` for its next check, `downloading` once the server sent it the image, `running` the new version with its clean Readings; or stuck: `offline`, `refused` the image with its update result, `never-checked`, `unregistered`, `held`) and, while it waits, its `nextCheck` (`reading`: at its next Reading, nudged; `hourly`: a silent board, or one before firmware 3); a staged release's named Devices under `rollout`; and every Device with the `firmwareVersion` and `checkedAt` of its last update check (null until it first checks) |
| `GET /api/devices/pending` | Admin | Boards that reported with the Device token but are not registered (their Readings get 404), most recently heard first: `[{hostname, firstSeen, lastSeen, reports, lastReading: {tempF, humidity} \| null, address, ignored}]`. Settings' New devices tab and its pop-up show them; adopting one is `POST /api/devices` with its hostname, which takes it off the list. Only `ESP_` plus six hex digits is kept, and at most 500 |
| `PATCH /api/devices/pending/:hostname` | Admin | `{ignored: boolean}`: hide a waiting board from the pop-up (it stays listed); 404 if it is not listed |
| `DELETE /api/devices/pending/:hostname` | Admin | 204; forgotten until it reports again |
| `GET /api/devices/rotation` | Admin | `{active, since, previous, unheard}` for a Device token rotation: `active` is true while `DEVICE_TOKEN_PREVIOUS` is set; `previous` lists the Devices whose latest Reading came with the previous token, and `unheard` those not heard at all since `since`, when api started (both empty when not `active`). Settings shows it; `deploy.sh rotate-device-token --finish` waits for both to be empty |
| `POST /api/readings` | Device | The Device token, or during a rotation the previous one too. `{device, temp, humidity}`, plus, from firmware 3, what the board says about itself: `fw` (its `FIRMWARE_VERSION`), `rssi` (dBm), `uptime` (seconds), `heap` (free bytes), `reset` (why it last restarted) and `update` (its last update check); from firmware 6, `sensor` (`DHT11`, `DHT22` or `SHT31`; any other value is dropped); from firmware 7, `ssid` (the WiFi network it is on, cut to 32 printable characters) and `network` (`1` for `WIFI_SSID`, `2` for `WIFI_SSID_2`, its fallback network; any other value is dropped). Each is optional and dropped if out of range; the Firmware tab shows the latest. When a newer build is published for that board, the 201 carries `X-Firmware-Available: <version>` and the board checks for it at once. from the board (`device` is its hostname, `temp` in °F) → 201 `{device, reading: {tempF, humidity, recordedAt}}`; 404 when no Device has that hostname; 422 when a number is missing, `temp` is outside -40 to 200 °F, or `humidity` is outside 0 to 100 (a sensor fault, not a Reading). From firmware 5, a board whose sensor does not answer posts a fault report instead, `{device, fault: "sensor"}` with the same self-report fields and no values → 202 `{device, fault: "sensor"}`: no Reading is stored, the Device stays Online, and three in a row raise Sensor fault (docs/adr/0009); any other `fault`, or a fault with values, is 422. Limited to 20 Readings and fault reports a minute per Device, then 429 |
| `GET /api/dashboard?campus=SHORTCODE&order=worst\|campus` | Signed in | `{reportIntervalSeconds, offlineAfterSeconds, devices}`: every Device (or only that Campus's), worst first by default (critical, high, warning with Offline among it, moderate, then none; ties by Campus name then closet), or by Campus name then closet with `order=campus`; any other order is 422. Each Device comes with `latestReading`, `online`, `secondsSinceReading`, `lastReportAt` and `secondsSinceReport` (its last Reading or fault report, which Online counts from), its `conditions` worst first, `tokenMismatchAt` (as in `GET /api/devices`; the card says "Token mismatch" while it is set), `openIncidents`, its incidents still open, oldest first, each `{id, condition, level, start, acknowledgement}`, and `onFallbackNetwork`, true while its board says it is on its fallback network (firmware 7): a note on the card, never a Condition. The network's name is only on the Firmware tab, behind the Admin token |
| `GET /api/dashboard/stream` | Signed in | Server-Sent Events: one message per Reading ingested, `{type: "reading", device, reading, online, conditions, lastReportAt, onFallbackNetwork}`; one per fault report, `{type: "fault", device, fault: "sensor", online, conditions, lastReportAt, onFallbackNetwork}` (`onFallbackNetwork` as on the dashboard: what the board last said, kept when a report says nothing about itself); one per incident that opens, changes level, closes, or is acknowledged, `{type: "incident", change: "opened" \| "level" \| "closed" \| "acknowledged", incident}` with the incident as `/api/incidents` sends it; `{type: "firmware"}` and nothing more when firmware status can have changed (a release published, widened, withdrawn, or held, a board's update check, a Reading that changes a Device's version, update result, or a release's count of clean Readings), at most one a second, so an open Firmware tab reads `/api/firmware/status` again with the Admin token; plus a heartbeat comment every 25 seconds to keep proxies from closing the stream. Every message is unnamed: tell them apart by `type` |
| `GET /api/incidents?from=<ISO>&to=<ISO>` | Signed in | `{from, to, incidents}`: every incident that overlaps the window, ongoing ones included, oldest first. Each is `{id, device: {id, hostname, closet, campus}, condition, level, start, end, peak: {value, tempF, humidity, recordedAt}, segments: [{level, start, end}], acknowledgement}`: `level` is the worst reached, `acknowledgement` is `{by, at}` once someone said they are on it (null until then, and kept after the end), `end` is null while ongoing, `peak.value` is °F for Hot and Cold, percent for Dry and Mold risk, and null for Offline and Sensor fault (whose peak is the last good Reading before it). `from` and `to` are ISO instants with a zone; 422 unless `from` is before `to` and the window is at most 8 days. An incident is a Condition at warning or worse; see ADR 0006 for when one opens and closes |
| `POST /api/incidents/:id/acknowledge` | Admin | Body `{by}`: a name or short note, 1 to 60 characters once trimmed, no control characters, line or paragraph separators, or text-reordering marks (422 otherwise). Records who is on an open incident and when, and sends it on the stream; answers the incident as `/api/incidents` sends it. The first acknowledgement stands: a repeat while it is open answers 200 with the incident as it is and sends nothing. 409 once the incident has ended, acknowledged before or not; 404 for an unknown one. It stops reminders, never the other emails: later emails about the incident name it (ADR 0008) |
| `GET /api/devices/:id/history?date=YYYY-MM-DD&tz=America/Chicago` | Signed in | One local day of Readings, oldest first, with `summary` min, max, and average for each measure. `date` defaults to today and `tz` to the server's zone. At most 30,000 Readings, more than a day at the ingest limit: past that, the first 30,000 are sent, `truncated` is true, the summary covers only those, and the History page says so. `retentionDays` says how far back Readings go, the longest range the CSV download takes. `device.sensor` is the sensor its board last said it carries, null until a board on firmware 6 has said |
| `GET /api/devices/:id/readings.csv?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=America/Chicago` | Signed in | A CSV download for Excel: a header row, then one row per Reading over the days `from` to `to` (both included, cut in `tz`, the server's zone by default), oldest first: local time and UTC time (`2026-09-05 14:30:00`), °F, °C to one decimal, and % humidity, as bare numbers. UTF-8 with a byte order mark, CRLF line ends, named like `CHS_IDF-2_readings_2026-09-01_to_2026-09-28.csv`. Streamed a page at a time. 422 for a missing or backwards range, or one longer than `RETENTION_DAYS`; 404 for an unknown Device. Text that starts with `=`, `+`, `-`, or `@` is written with a leading `'` so a spreadsheet never runs it |
| `GET /api/incidents.csv?from=<ISO>&to=<ISO>&tz=America/Chicago&device=<id>` | Signed in | The incidents of `/api/incidents` as a CSV download, in the same form: one row per incident overlapping the window, oldest first, with its Campus, Closet, hostname, Condition, worst level, start and end (local and UTC; empty while ongoing), duration in minutes (to now while ongoing), peak °F, °C, and humidity and when (for Offline and Sensor fault, the last good Reading), and who acknowledged it and when. `device` keeps one Device's. The window may run to `RETENTION_DAYS` plus one day (422 past it); named like `incidents_2026-10-04_to_2026-10-05.csv`, or with the Campus and Closet first when `device` is given |
| `DELETE /api/devices/:id/history` | Admin | 204; every Reading and incident of that Device is gone |
| `GET /api/notifications/status` | Admin | `{enabled, relay, from, recipients, toAll, lists, monthlyReport, quietHours, lastSent, lastFailure, pending, held, heldUntil, failed}` for email notifications (ADR 0008): `relay` is `{host, port, secure}` (null when off), never the password; `recipients` is `NOTIFY_TO` and `toAll` is `NOTIFY_TO_ALL`; `lists` is every recipient list email can go to now, `NOTIFY_TO`'s first, each `{recipients, campuses, isDefault, lastResult}` with the shortcodes of the Campuses that email it and its last try in the last week (`{at, sent: true, subject}`, `{at, sent: false, error}`, or null; the test email and the monthly report count for `NOTIFY_TO`'s); `monthlyReport` is whether the report goes out on the 1st; `quietHours` is `{hours, weekends}` (`hours` as `18:00-07:00`, null for none; null while off); `pending` and `failed` count the queued emails (Incident changes and monthly reports) still to send and those given up on, and `held` how many of the pending warnings quiet hours hold, until `heldUntil` (null when none). Settings' Notifications tab shows it |
| `GET /api/system` | Admin | Whether the system itself is OK, for Settings, System: `{checkedAt, database, disk, backup, notifications, firmware, wifi, server}`, each with a `status` of `ok`, `off` (notifications not set up), or `attention`, decided by the server, and its facts: the database's size and whether Readings are being stored; free and total disk (`attention` under 10%); the last backup `deploy backup` recorded (`attention` when none, or over 2 days old); the outbox's figures (`attention` while the latest try failed); the release and the installed Devices it is offered to that checked and still run an older build; installed Devices under -80 dBm for 24 hours or more (`wifi.weak`); and the server's `version` (the commit `deploy` built it from, or null), `startedAt`, and `uptimeSeconds`. Devices on the Bench are left out of firmware and WiFi. Shown on the page only: nothing is emailed |
| `POST /api/notifications/test` | Admin | Sends a test email to `NOTIFY_TO` now, skipping the queue → `{sentAt, accepted, rejected, response}`, the relay's reply. 409 while notifications are off, 502 with the relay's reason when it refuses, 429 after one a minute (for the whole server) |
| `POST /api/notifications/report` | Admin | Queues the monthly report on last month (the server's zone) in the outbox, whatever `NOTIFY_MONTHLY_REPORT` says → 202 `{month, queuedAt}`, `month` as `YYYY-MM`; the sender emails it to `NOTIFY_TO` within seconds, with the outbox's retries, and the status shows it. 409 while notifications are off, 429 after one a minute (for the whole server) |

An overview with one Campus, trimmed to two of its seven days:

```json
{
  "timeZone": "America/Chicago",
  "threshold": { "name": "Hot", "level": "warning", "tempF": 82 },
  "retentionDays": 90,
  "campuses": [
    {
      "id": 1, "name": "Riverside High School", "shortcode": "RHS", "closets": 8, "level": "critical",
      "now": {
        "conditions": [{ "name": "Hot", "level": "critical", "count": 1 }, { "name": "Offline", "level": "warning", "count": 1 }],
        "headsUp": [{ "name": "Mold risk", "level": "moderate", "count": 1 }]
      },
      "worst": {
        "id": 3, "hostname": "ESP_4F2A10", "closet": "IDF 3 (Gym)", "closetType": "IDF",
        "latestReading": { "tempF": 91, "humidity": 35, "recordedAt": "2026-10-05T03:20:00Z" },
        "level": "critical", "offline": false, "conditions": [{ "name": "Hot", "level": "critical" }]
      },
      "days": [
        { "date": "2026-10-03", "from": "2026-10-03T05:00:00Z", "to": "2026-10-04T05:00:00Z", "partial": false, "maxTempF": 83, "incident": true, "incidentLevel": "warning" },
        { "date": "2026-10-04", "from": "2026-10-04T05:00:00Z", "to": "2026-10-05T05:00:00Z", "partial": true, "maxTempF": 91, "incident": true, "incidentLevel": "critical" }
      ],
      "lastIncident": { "ongoing": true, "start": "2026-10-05T03:17:30Z" }
    }
  ]
}
```

**Signed in** is any signed-in user's session or the Admin token; **Admin** is an Admin's session or the Admin token; a session that must still choose a new password gets 403 everywhere but `/api/session`. A change made with the session cookie must be `application/json` (the firmware upload `application/octet-stream`), else 415: with `SameSite=Strict`, that is the guard against cross-site requests (ADR 0010). Tokens are sent as `Authorization: Bearer <token>`. The Admin token is for scripts (the bench watcher, `deploy.sh`, the demo, the end-to-end walk) and may do whatever an Admin may; the Device token is flashed into every Device. Neither works in the other's place. See ADR 0003 for why there are two and what that trades away. The Conditions the API reports are defined in [`CONTEXT.md`](CONTEXT.md); the thresholds behind them are the `HOT_`, `COLD_`, and `DRY_` settings in `.env.example`.

Browsers are accepted from the API's own origin, which is how the stack serves them, and from one more origin named in `CORS_ORIGIN` for a dev server on another port.

Apart from Readings, which have the per-Device limit above, `/api/` allows each client address 6,000 reads (GET and HEAD) and 500 other requests per 15 minutes. The reads are sized for about 30 open tabs behind one address: a Campuses tab, the busiest page, reloads at most every 10 seconds. The address is the one the stack's nginx saw: the backend trusts exactly one proxy hop. With another proxy in front, such as the TLS proxy in DEPLOYMENT.md, that address is the proxy's, so every browser shares one allowance, unless `TRUST_PROXY` in `.env` names the proxy. nginx then takes the browser's address from the proxy's `X-Forwarded-For` ([TLS in front of the stack](DEPLOYMENT.md#tls-in-front-of-the-stack)).

## Hardware

| Part | Notes |
| --- | --- |
| NodeMCU (ESP8266) | Identifies itself by hostname: `ESP_` plus the last six hex digits of its MAC |
| One sensor, chosen per build (`SENSOR_TYPE` in `config.h`) | Temperature and humidity; the firmware treats each the same, and the board names its sensor with every report, so its History page shows it |

| Sensor | Accuracy (typical, from the datasheet) | Connection |
| --- | --- | --- |
| DHT11 | ±2 °C (±3.6 °F), ±5 % humidity | One data pin: GPIO 5 (D1) when wired separately, GPIO 4 (D2) on boards that carry it soldered on |
| DHT22 (AM2302) | ±0.5 °C (±0.9 °F), ±2 % humidity (up to ±5 % at the extremes) | One data pin, wired as the DHT11: GPIO 5 (D1) |
| SHT31, on a breakout board such as Adafruit's SHT31-D | ±0.3 °C (±0.5 °F), ±2 % humidity | I²C: SDA on GPIO 4 (D2), SCL on GPIO 5 (D1), address 0x44 (0x45 with ADDR tied high) |

Readings are stored in whole degrees and whole percent whatever the sensor (docs/adr/0002), so a DHT22 or SHT31 makes a Reading closer to the truth, not finer.

### Wiring

![NodeMCU wired to a DHT11: DATA on D1 (GPIO 5), VCC on 3V3, GND on GND](arduino/dht11-pinout.svg)

| DHT11 pin | NodeMCU pin |
| --- | --- |
| VCC | 3V3 (not VIN) |
| DATA | D1 (GPIO 5) |
| GND | GND |

A bare four-pin sensor needs a 10 kΩ pull-up between DATA and VCC or every read is NaN; its third pin stays unconnected. Three-pin modules carry that resistor already, so wire them the same way, but check the silkscreen because the pin order varies by module.

A NodeMCU sold with the DHT11 already soldered on needs no wiring at all, but its sensor sits on D2 (GPIO 4), so set `DHT_PIN 4` in `config.h`. Every read comes back NaN until the pin matches the board.

A **DHT22** has the same pinout and wires exactly as the DHT11 above (DATA on D1, and the same pull-up rule); set `SENSOR_TYPE DHT22`.

An **SHT31** is an I²C sensor. Use it on a breakout board, which carries the bus's pull-up resistors, and set `SENSOR_TYPE SHT31`:

| SHT31 breakout pin | NodeMCU pin |
| --- | --- |
| VIN | 3V3 |
| GND | GND |
| SDA | D2 (GPIO 4) |
| SCL | D1 (GPIO 5) |
| ADDR | unconnected (address 0x44); to 3V3 for 0x45, then set `SHT31_ADDRESS 0x45` |

Other pins work too, named in `SHT31_SDA_PIN` and `SHT31_SCL_PIN`. A board whose SHT31 does not answer at boot says so on serial and keeps trying every interval, as a DHT board with a loose wire does.

## Firmware

The sketch in [`arduino/TemperatureAlarms/`](arduino/TemperatureAlarms/) is the one firmware for every Device: a NodeMCU reads its sensor (a DHT11, DHT22 or SHT31, set in `config.h`) and posts a Reading every Report interval. It is a folder the Arduino IDE compiles together, one job per file:

| File | Job |
| --- | --- |
| `TemperatureAlarms.ino` | `setup` and `loop` only: when a Reading is due, read once and report once |
| `network.h/.cpp` | Join WiFi at boot, fall back to a second network when the first cannot be joined, reconnect from the loop without a reboot, name the Device |
| `sensor.h/.cpp` | Read the sensor `config.h` names behind one `sensorRead`, try a NaN read once more 2 s later, then skip the sample and say so on serial |
| `reporter.h/.cpp` | Build the JSON Reading, or a fault report when the sensor did not answer (firmware 5), with what the board says about itself (its sensor too, from firmware 6, and its WiFi network, from firmware 7), and POST it with the Device token, log the HTTP status |
| `server.h/.cpp`, `roots.h/.cpp` | Where `SERVER_URL` is; over `https://`, a TLS client that accepts only a Let's Encrypt certificate for that name, with the time taken from the server |
| `updater.h/.cpp`, `version.h` | Over-the-air updates: every hour, install a newer signed build if the server offers one; `FIRMWARE_VERSION` is this build's number |
| `config.example.h` | Template for the gitignored `config.h`: SSID, password, an optional second network to fall back to, server URL, Device token, interval, the sensor (`SENSOR_TYPE`) and its pins |

There is no on-device web server, no retry loop, and no per-Device setting. Your router's DHCP list shows the same six digits as `ESP-xxxxxx`.

### Libraries and board settings

The sketch compiles clean against these versions; install them from the IDE's Boards Manager and Library Manager. Build production binaries with exactly these, not whatever is newest: the same `config.h` and the same versions give the same firmware, so a board flashed months later behaves like the rest of its batch. When a version changes, compile, run one board through the bench checklist, and update this table in the same commit.

| Dependency | Version | Where |
| --- | --- | --- |
| esp8266 by ESP8266 Community | 3.1.2 | Boards Manager, after adding `https://arduino.esp8266.com/stable/package_esp8266com_index.json` under Preferences, Additional boards manager URLs |
| DHT sensor library by Adafruit | 1.4.7 | Library Manager |
| Adafruit Unified Sensor | 1.1.15 | Library Manager (the DHT library depends on it; accept the prompt to install it) |
| Adafruit SHT31 Library | 2.2.2 | Library Manager; only `SENSOR_TYPE SHT31` builds use it |
| Adafruit BusIO | 1.17.4 | Library Manager (the SHT31 library depends on it; accept the prompt to install it) |

Board settings, under Tools: board **NodeMCU 1.0 (ESP-12E Module)**, upload speed 115200, CPU 80 MHz, flash size 4MB (any FS split), everything else at its default. The serial monitor runs at 115200.

Room to grow: a signed build of firmware 7 uses 92 % of the ESP8266's instruction RAM (IRAM) with a DHT11 or DHT22 (60,847 of 65,536 bytes) and 93 % with an SHT31 (61,447; the I²C driver adds 600), and 37 % of its 1 MB of code flash (38 % with an SHT31). IRAM is the tight one: compile any change that could add to it (an interrupt handler, another core library) for each sensor and check that figure first.

### Flashing

1. Copy `arduino/TemperatureAlarms/config.example.h` to `config.h` in the same folder and fill in the WiFi credentials (leave the password `""` for an open network that admits Devices by MAC allowlist, and see [Secrets on the board](#secrets-on-the-board) first), a second network to fall back to if the closet has one (`WIFI_SSID_2` and `WIFI_PASSWORD_2`, or `""` for none: see [The fallback network](#the-fallback-network)), and the server URL without a trailing slash (the sketch appends `/api/readings`). For production boards that is `https://YOUR_DOMAIN`, the same name the dashboard is served at, HTTPS, checked against Let's Encrypt's roots like a browser checks it, is the transport the district chose (see [Transport for production boards](#transport-for-production-boards) below, and run its checks first). On a desk or a lab network, `http://<host>` works too. A Device flashed with `http://<host>` keeps reporting after TLS goes in front, by hostname or by address, but only through the plain-HTTP Readings route that DEPLOYMENT.md's TLS proxy keeps; the Device cannot follow a redirect to HTTPS. Then the `DEVICE_TOKEN` from the stack's `.env`, the interval, which must equal the backend's `REPORT_INTERVAL_SECONDS`, and the sensor: `SENSOR_TYPE` (`DHT11`, `DHT22` or `SHT31`) and its pins (`DHT_PIN` 5 for a wired DHT11 or DHT22, 4 for an integrated DHT11; the SHT31's I²C pins as wired above). `config.h` is gitignored.
2. Open `TemperatureAlarms.ino` in the Arduino IDE, choose the board setting above and the port the NodeMCU appears on, and click Upload.
3. Open the serial monitor at 115200 and watch the Device join WiFi.

The same build from the command line, with the sketch's dependencies installed once:

```bash
arduino-cli config init --additional-urls https://arduino.esp8266.com/stable/package_esp8266com_index.json
arduino-cli core update-index && arduino-cli core install esp8266:esp8266@3.1.2
arduino-cli lib install "DHT sensor library@1.4.7" "Adafruit Unified Sensor@1.1.15" "Adafruit SHT31 Library@2.2.2" "Adafruit BusIO@1.17.4"
arduino-cli compile --fqbn esp8266:esp8266:nodemcuv2 arduino/TemperatureAlarms
arduino-cli upload  --fqbn esp8266:esp8266:nodemcuv2 -p /dev/ttyUSB0 arduino/TemperatureAlarms
arduino-cli monitor -p /dev/ttyUSB0 -c baudrate=115200
```

Over an `https://` server URL the board checks the server's certificate as a browser does: it must chain to one of Let's Encrypt's roots, built into the firmware (`roots.cpp`: ISRG Root X1, X2, YE, and YR), and name `SERVER_URL`'s host. Checking dates needs the time, which the board takes from the server's own `Date` header (a GET of `/api/health`, with no token); until it has it, it sends nothing (serial says `no time from the server yet`). Renewals, a new server key, or a rebuilt server never need a reflash. ADR 0001 records the decision.

### Transport for production boards

Decided 2026-10-06 (ADR 0001): production boards post over **HTTPS to `https://YOUR_DOMAIN`**, the name the dashboard is reached at too, and check its certificate against **Let's Encrypt's roots**, built into the firmware. The token is encrypted on the wire and goes only to a server with a valid certificate for that name: a spoofed DNS answer, a rogue access point, or any other host fails the handshake before the request goes out, and the board logs `report: failed` and records nothing. Nothing about the server's key is in the boards, so certbot's renewals, a new key, or a rebuilt server need no reflash, and anything that does change is an [over-the-air update](#updating-boards-over-the-air), not a visit to every closet.

Before flashing day:

- [ ] **The server has a Let's Encrypt certificate for `YOUR_DOMAIN`** (DEPLOYMENT.md, step 6), renewing on its own. If the name is not reachable from the internet, issue it with a DNS challenge rather than `--nginx`.
- [ ] **The device network** resolves `YOUR_DOMAIN` to the server and lets the boards reach it on TCP 443, and nothing else besides its DNS resolver. Give the boards an SSID and VLAN of their own with client isolation (if the SSID is open, by MAC allowlist, it is this VLAN). The board takes the time from the server, so no time server is needed.
- [ ] **Checked from a machine on the device network:** `nslookup YOUR_DOMAIN` gives the server's address; `curl -i https://YOUR_DOMAIN/api/health` answers `200` (curl checks the certificate the same way); `openssl s_client -connect YOUR_DOMAIN:443 -servername YOUR_DOMAIN -verify_return_error </dev/null 2>&1 | grep 'Verify return code'` prints `Verify return code: 0 (ok)`.
- [ ] **The signing keys exist** and are in the sketch folder ([Updating boards over the air](#updating-boards-over-the-air), one-time setup), so the boards flashed over USB on flashing day are the last ones anyone flashes by hand.
- [ ] **One board on the bench first:** serial shows `server: https, 4 roots, time from the server` and `update: on, signed builds only, hourly` at boot, then `report: 201 created`. That also proves the board has the heap for TLS.

What is accepted: anyone able to get a Let's Encrypt certificate for `YOUR_DOMAIN` (that is, whoever controls its DNS) could stand in for the server, as for any browser. The roots last until 2035 (X1) to 2045 (YE, YR), the firmware does not check a root's own expiry, and new roots can be shipped over the air. Anyone holding a board can still read the token from its flash (next section).

### Secrets on the board

Every board carries the WiFi password (both, when it has a second network) and the Device token in plain text: in `config.h`, in the exported `.bin`, and in the board's flash, where anyone holding the board reads them back over USB with `esptool read_flash`. The ESP8266 has no flash encryption or secure boot, so no build setting changes that. Treat a board like a key to the closet network.

- **What the Device token allows.** Posting Readings, and nothing else: it cannot read anything the dashboard does not already show, or change Campuses or Devices. A Reading is accepted only for a hostname registered in Settings (the dashboard lists them), at most 20 a minute per hostname, so a stolen token can send false temperatures for any registered Device: open false incidents, or hide a real one by posting normal values over it. Every board shares the one token, so one lost board exposes all of them.
- **What the WiFi password allows.** Joining the Devices' network. Give the boards an SSID and VLAN of their own that reaches only the server's port 443, with client isolation, so the password opens nothing else. A second network (`WIFI_SSID_2`) is held to the same rule: it is in every board too.
- **An open network** (`WIFI_PASSWORD ""`) is only for an SSID that admits Devices by MAC allowlist, and a MAC allowlist stops nobody determined: the MACs are on the inventory sheet and in every frame the boards send. Use it only on that same isolated VLAN.
- **Serial.** The firmware never prints the token or the WiFi password; serial shows the SSID, the server URL, the hostname, and each report's status. A refused report prints at most 120 printable characters of the server's answer, so the bench log carries no secret, and a server cannot write a line of its own into it.
- **Where the token goes.** Only to `SERVER_URL`: the firmware never follows a redirect (a 3xx is logged as `report: 3xx` and nothing is recorded). Over `http://`, anyone who can see the traffic reads the token. Over `https://`, as production boards are flashed, it is encrypted and sent only after the server shows a valid certificate for its name, so a machine that answers for the server's name (a spoofed DNS answer, an ARP spoof, a rogue access point) gets a failed handshake, not the token.
- **A lost or stolen board**, or a token seen in the wrong place: rotate the token, without a dark fleet. The backend accepts the previous token next to the new one until you say the rotation is over:
  1. On the server, `deploy/deploy.sh rotate-device-token` (or `deploy.ps1`). It moves the current token to `DEVICE_TOKEN_PREVIOUS`, generates a new `DEVICE_TOKEN`, restarts `api` with both, and prints the new `config.h` line, masked; `deploy.sh info --reveal` prints it in full. Boards on either token keep reporting.
  2. Put the new token in `config.h`, raise `FIRMWARE_VERSION`, export once, and [publish it over the air](#updating-boards-over-the-air): boards download it with the token they still carry, which the server accepts until step 4. A board that does not update (offline, or flashed before over-the-air updates) is reflashed with the watcher, which takes boards already registered (`already`) without moving them from their Campus and Closet.
  3. Watch Settings: while a rotation is under way it lists every Device whose latest Reading still came with the previous token, and any Device the server has not heard since it last restarted. `api`'s log also names each Device still on the previous token, once an hour, by hostname.
  4. When the list is empty, `deploy/deploy.sh rotate-device-token --finish` clears the previous token, and only the new one is accepted from then on. It refuses while any Device is listed; a Device that is gone for good can be deleted in Settings, or `--finish --force` (with a typed confirmation) ends the rotation anyway, and the boards left on the old token stop reporting until they are reflashed.

  A lost board's token stays valid until `--finish`, so for a stolen board finish as soon as the fleet is reflashed. One rotation at a time: a second `rotate-device-token` is refused until the first is finished.
- **The signing key is a secret too.** `private.key` (next section) signs every build the boards will install; whoever holds it and can reach the server's Admin token could install their own firmware on every board. Keep it on the build laptop and in one offline backup, never in the repo (`.gitignore` covers it).
- **The exported `.bin` is a secret.** Keep it under the sketch's `build/` (gitignored, as is any `.bin` under `arduino/`), never copy it to a share or a ticket, and delete it when the batch is done.

### Bench checklist

Run through this once per Device, on a desk, before it goes into a closet. What differs by sensor is in the table after the steps.

1. **Hostname on serial.** After `wifi: connected` the log prints `device: ESP_xxxxxx`. Add that hostname as a Device in Settings, or adopt it: a board reporting with the right token but not added yet appears under Settings, New devices (and as a pop-up for Admins), with its last Reading and address. Until it is added, every POST is refused with a 404 naming the hostname. A board flashed with the wrong token shows "Token mismatch" on its card instead, if it is already added.
2. **First POST returns 201.** At boot the log names the sensor the binary was built for, and within one interval it shows a `sensor:` line with the temperature and humidity, then `report: 201 created`, and the Device's card updates on the dashboard. Its History page names the sensor beside the hostname. A `report: 401` means the token in `config.h` does not match the backend's `DEVICE_TOKEN`.
3. **Unplugged sensor yields fault reports, never zeros.** Pull the sensor's wire (see the table): each interval logs `sensor: read failed (NaN), trying once more`, then `sensor: read failed (NaN), sample skipped` and `report: 202 sensor fault reported` (firmware 5 and later; earlier firmware posts nothing). The history never records a zero. On the Firmware tab the board stays Online, and after three intervals its card shows **Sensor fault** (docs/adr/0009). Plug it back in: the next interval posts a Reading (`report: 201 created`), and the Sensor fault Incident ends after two Readings in a row.
4. **Router reboot yields resumed posting.** Power-cycle the access point: the log shows `wifi: connection lost, reconnecting`, then `wifi: reconnected` with the new address, and the next Reading goes out without the Device restarting. The `report:` lines that fail in between are logged and not retried.
5. **Fallback network** (once per build that names a second network, on one board). With the first network off, boot the board: after 30 s the log shows `wifi: not joined, trying <second> (fallback network)`, then `wifi: reconnected to <second> (fallback network)` and `report: 201 created`. The card shows "On its fallback WiFi network" and nothing more: no Condition, no Incident, no email; the Firmware tab names the second network over "Fallback network". Turn the first network back on: the board stays where it is. Turn the second off: `wifi: connection lost, reconnecting`, 30 s for the core to retry it, then `wifi: not joined, trying <first>`, `wifi: reconnected to <first>`, and the note goes with the next report.

| | DHT11 | DHT22 | SHT31 |
| --- | --- | --- | --- |
| Boot line (step 2) | `sensor: DHT11 on GPIO 5` (`GPIO 4` integrated) | `sensor: DHT22 on GPIO 5` | `sensor: SHT31 at 0x44, SDA GPIO 4, SCL GPIO 5`; `not answering at` means the wiring or the address |
| History and the Firmware tab name | DHT11 | DHT22 | SHT31 |
| Wire to pull (step 3) | DATA | DATA | SDA |
| The first board of a new sensor or a new supplier: beside a reference thermometer and hygrometer for 10 minutes, every Reading within | 5 °F and 6 % | 2 °F and 3 % | 2 °F and 3 % |

The last row is the sensor's accuracy (Hardware) plus one for the whole-degree rounding of a Reading. Outside it, the sensor is bad or is warmed by the board it sits against.

### Flashing a batch

For a box of boards, [`arduino/bench.py`](arduino/bench.py) does the checklist's first two steps for every board and writes what it found back to the inventory sheet. It runs on the Windows laptop next to a USB hub, needs Python 3.9 or newer, and only two packages:

```powershell
pip install esptool pyserial
```

1. **Export the binary once.** Fill in `config.h` as above, then in the IDE choose Sketch, Export Compiled Binary: it lands under `build/` in the sketch folder as `TemperatureAlarms.ino.bin`. One kind of board per batch, since the sensor and its pins are in the binary: integrated DHT11 boards, DHT22 boards, and SHT31 boards are each an export of their own.
2. **Set the Admin token**, from the stack's `.env`, in the environment and nowhere else: `$env:ADMIN_TOKEN = "..."` in PowerShell, `set ADMIN_TOKEN=...` in cmd. The watcher never prints it or writes it to the sheet or the log. It does send it with every registration, so give `--server` an `https://` URL once a TLS proxy is in front; over `http://`, run the bench only on a network you trust, such as the Devices' VLAN or a cable to the server's LAN. The watcher never follows a redirect, so an `http://` URL that the proxy redirects stops it at startup, naming the URL to use instead. Close the PowerShell window when the batch is done.
3. **Run the watcher** against the live server and the inventory sheet, a CSV with a `MAC` column (`ID` and `HOSTNAME` columns are used when present). Close the sheet in Excel first, since an open sheet cannot be written. Keep the sheet outside the repo: it lists every board's MAC, and the watcher writes `<sheet>.bench.csv` and, while saving, `<sheet>.tmp` next to it (`.gitignore` covers CSVs at the repo root and in `arduino/` in case one lands there):

   ```powershell
   python arduino\bench.py --server http://<host> --inventory "device_log - device_log.csv"
   ```

   It refuses to start when the binary is missing or older than a source file in the sketch folder, when `ADMIN_TOKEN` is unset or not the server's, or when the server's `/api/health` does not answer. Once running, plug boards in; ports present at start are ignored. Each new port is handled on its own thread, so a hub works several boards at once. Per board: esptool reads the MAC, the hostname is derived (`ESP_` plus the last six hex digits), the sheet row is looked up by MAC (a board off the sheet proceeds and gets a row of its own), the Device is registered under the Bench Campus with closet `Unassigned` (an existing hostname reads `already`), the binary is flashed at 921600 baud (460800 if the handshake fails), and the board is reset and read over serial for 70 seconds, two report attempts. One line per board says what happened:

   ```
   COM7  row 12  ESP_7AED5B  registered  flashed  PASS
   COM9  added row 94  ESP_1234AB  already  flashed  FAIL bad sensor
   ```

   PASS needs `device:` with the derived hostname, `wifi: connected`, a numeric `sensor:` line, and `report: 201 created`. `FAIL bad sensor` and `FAIL did not boot` keep the batch going and leave the Device registered. A `report: 401` (the Device token in the binary), no `wifi: connected` on the first board of the run (SSID or password), or `report: failed` (the server is unreachable from the bench) stops the batch and names which of the binary, the WiFi, or the server to fix. Ctrl-C stops after the boards in progress finish.
4. **Read the sheet and the log.** After each board, its sheet row is updated in place: `FLASHED` becomes TRUE, `TESTED` becomes TRUE on PASS or FALSE on a FAIL, and a `BENCH` column holds the verdict and the date; the three columns are added to the header when the sheet lacks them, and a board the sheet lacks gets a new row with the next `ID`. Rows the watcher did not touch are written back as they were, so edits made between boards survive. `<sheet>.bench.csv` next to the sheet also gains one row per board seen (time, port, sheet row, hostname, MAC, `registered` or `already`, `flashed`, verdict, reason); replugging a board runs it again and adds a row. On stop, the watcher prints the sheet rows no board answered for and the boards the sheet lacked at start. A Device on the Bench stays there, Offline, until Settings moves it to its Campus and Closet.
5. **Clean up.** Delete the exported `.bin` (it holds the WiFi password and the Device token), close the window that holds `ADMIN_TOKEN`, and keep the sheet where only technicians can read it.

The watcher has run one batch of 92 boards (91 passed, one bad sensor). Its logic is unit-tested without hardware (see Tests and checks); a real board on the bench is the acceptance test for any change to it.

### Updating boards over the air

Every board learns of a newer build within one Report interval of its publication: the server says so in its answer to the board's next Reading, and the board checks at once (at most once a minute). It also checks 30 seconds after boot and every hour regardless. It installs the build and restarts; nobody visits a closet. Boards on firmware before version 3 only check hourly and at boot, so their first update to version 3 or later can take up to an hour; after that, updates arrive within a Report interval. Only builds signed with the district's key are installed: the board checks the signature itself before it boots the new build, so not even someone who takes over the server can put their own firmware on the boards. The server offers a build only to Devices that present the Device token, since the image holds the WiFi password and the token. ADR 0007 has the design.

**One-time setup, before flashing day.** On the build laptop, in the sketch folder (`arduino\TemperatureAlarms`), with OpenSSL (Git for Windows has it in `C:\Program Files\Git\usr\bin`):

```bash
openssl genrsa -out private.key 2048
openssl rsa -in private.key -pubout -out public.key
```

With `public.key` there, every build turns updates on and refuses anything unsigned; with `private.key` there, every build also writes a signed copy, `TemperatureAlarms.ino.bin.signed`, next to the `.bin`. Both files are gitignored. Copy `private.key` to one offline place (a password manager, an encrypted USB key in a safe): if it is lost, boards keep running, but the next update means USB for every board (with new keys); if it leaks, rotate it the same way. The boards flashed over USB on flashing day must be built with the keys present, or they never check for updates (serial says `update: off, this build is not signed`).

**Every update after that:**

1. Make the change (code, `config.h`, a new Device token), and raise `FIRMWARE_VERSION` in `version.h` by one. A board installs a build only if its number is higher than its own.
2. Export the binary (Sketch, Export Compiled Binary). Use `TemperatureAlarms.ino.bin.signed` from `build/`; the server refuses the unsigned `.bin`.
3. **One board first.** In Settings, on the Firmware tab, choose the `.signed` file, type one bench board's hostname under "Only these Devices" (`ESP-64533B` as its serial log prints it is read as `ESP_64533B`; a name no Device is registered under is refused), and Publish. The answer says who it is offered to ("Offered to ESP_64533B (CHS IDF 2, running 4)"). Within a Report interval that board downloads it, restarts, and reports; under "Named Devices first" its line goes from waiting for its next check (and when to expect it) to downloading, to running the new version with its clean Readings counted, or says where it is stuck: Offline, refused the image (with why), or never checked in. On its serial (firmware 8 and later): `update: v8 offered, downloading`, `update: installed, restarting`, `firmware: TA-FIRMWARE-VERSION=<new>`, then `report: 201 created`; a check with nothing for it says `update: none newer for ESP_64533B (running 8)`, the name the release must use.
4. **Then every board.** Once every named board has sent 10 clean Readings in a row on the new version (five minutes at a 30-second Report interval), "Release to all" is enabled; press it. Within a Report interval or two every board takes it; the tab counts them and gives each a line, stuck ones first.
5. Delete the exported files (they hold the WiFi password and the Device token).

**The hold.** While a build is on the named boards only, it stops by itself if one of them goes Offline or into Sensor fault after taking it, or reports that the update failed: no Device is offered it any more, the tab says which board and why, and it is emailed when notifications are on. A board that never downloaded it holds nothing. Look at the board, then withdraw the build, or publish a fixed one with a higher version; publishing the held build again is refused.

The same from the server's shell: `deploy/deploy.sh publish-firmware --file TemperatureAlarms.ino.bin.signed --only ESP_A1B2C3`, then again without `--only` (the same as "Release to all", and refused while held); `deploy/deploy.sh firmware-status` (who it is offered to and the same line per Device as the tab, and when a build is held, and why); `deploy/deploy.sh withdraw-firmware` stops offering a build (boards keep what they run).

**What can go wrong.** A build that cannot join WiFi or reach the server can never be fixed over the air, since the update check needs both: that is what step 3 is for. The ESP8266 does not roll back to the previous build on its own; a board stuck on a bad build is a USB flash. A download cut short is simply retried at the next check (the board verifies the image's MD5 and signature before switching to it, and keeps running the old build until then). A board flashed before over-the-air updates, or built without the keys, shows as "Never checked in" on the Firmware tab and needs one USB flash.

### The fallback network

A board can carry a second WiFi network (`WIFI_SSID_2` and `WIFI_PASSWORD_2` in `config.h`; an empty password is an open network, as for the first). When it cannot join the first, it gives it 30 seconds, then tries the second for 30 seconds, and so on in turn until one joins; it stays on whichever joined until that one drops, and after a drop the core retries the same network for 30 seconds before the board turns to the other. Every report from firmware 7 says which network it came over. A board on its second network shows "On its fallback WiFi network" on its Dashboard card, and the Firmware tab names the network; it is a note, not a Condition, so it opens no Incident and sends no email. Both networks must reach `SERVER_URL`, and both are held to the rules in [Secrets on the board](#secrets-on-the-board). A build with no second network (`""`, or a `config.h` from before firmware 7) behaves as before.

**Moving boards to a new network over the air.** A build carries both networks, so closets can change network without a visit:

1. Build with the current network first and the new one second, raise `FIRMWARE_VERSION`, and publish it as above, one board first. Boards keep reporting over the current network; nothing on the Dashboard changes.
2. Take the current network away from the boards. Each joins the new one within about a minute; its card shows the note, and the Firmware tab names the new network for it. A board that does not come back is not reaching the server over the new network: turn the old one back on and it returns to it, then fix the new network.
3. Build with the new network first and, until the old one is gone for good, the old one second; raise `FIRMWARE_VERSION` and publish it. Each board restarts onto the new network as its first, and the notes go.

## Deployment

The Compose stack from the quick start is the deployment too, and deploying it is one step, two ways:

- **The deploy script.** On the server, `deploy/deploy.sh deploy --yes` (Linux, macOS) or `deploy\deploy.ps1 deploy --yes` (Windows Server) writes `.env` with generated secrets, builds and starts the stack, and checks it is healthy. Run either with no action for a menu that also upgrades, backs up, schedules a nightly backup, restores, shows the tokens and the `config.h` lines, and removes the stack. From one machine, `--host admin@server` (repeatable) or `--servers deploy/servers.txt` does the same on each server over ssh, each keeping its own `.env` and backups.
- **Ask your Claude agent.** In Claude Code in this repo, say "set up the new server admin@server", "deploy this to admin@server", "upgrade", or "back up nightly"; the `deploy` skill drives the script, keeps the secrets out of the chat, and ends on the health check.

A fresh Linux server (Ubuntu, Debian, RHEL, Rocky, AlmaLinux, CentOS Stream, Fedora) needs only git and sudo (on a minimal Debian or Ubuntu, such as a Proxmox CT, `sudo apt-get install -y git` first; see [Proxmox LXC](DEPLOYMENT.md#proxmox-lxc)):

```bash
git clone <repo-url> temperature-alarms && cd temperature-alarms
deploy/deploy.sh bootstrap        # Docker Engine and Compose from Docker's repository, cron, the docker group
# log out and back in, then:
cd temperature-alarms && deploy/deploy.sh deploy --yes
```

From another machine, `deploy/deploy.sh deploy --bootstrap --host admin@server --yes` does both over ssh, with no git needed on the server first.

Email notifications are off until you name the district's SMTP relay: `install` asks for it, or give `--smtp-host`, `--smtp-port`, `--smtp-secure`, `--smtp-user`, `--notify-from`, `--notify-to`, `--public-url`, `--notify-remind-hours`, `--notify-monthly-report on|off`, `--notify-quiet-hours HH:MM-HH:MM|off`, and `--notify-quiet-weekends on|off` (the password goes in on stdin or at a hidden prompt, never on the command line). They set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `NOTIFY_FROM`, `NOTIFY_TO`, `PUBLIC_URL`, `NOTIFY_REMIND_HOURS`, `NOTIFY_MONTHLY_REPORT`, `NOTIFY_QUIET_HOURS`, and `NOTIFY_QUIET_WEEKENDS` in `.env`, listed commented in `.env.example` with `NOTIFY_COALESCE_SECONDS`. With `NOTIFY_REMIND_HOURS` set (`install` offers 4; empty or 0 is off), an Incident still open and unacknowledged that many hours after it started is emailed again, and every as many hours after, until it closes or someone acknowledges it. Each Campus can name its own recipients on Settings, Campuses; a Campus without them emails `NOTIFY_TO`, and `--set NOTIFY_TO_ALL=true` copies `NOTIFY_TO` on every email. With `NOTIFY_MONTHLY_REPORT=true` (off by default), `NOTIFY_TO` gets a report on the month just ended on the 1st of each month: incidents and time in each Condition, the hottest and most humid closets, the closets that ran warm, and Offline and Sensor fault time. With quiet hours (`NOTIFY_QUIET_HOURS=18:00-07:00`, and `NOTIFY_QUIET_WEEKENDS=true` for weekends), warning emails wait until they end and go out together; critical Incidents, Offline, and Sensor fault still go at once. They are read in `api`'s zone, `TZ` (`--set TZ=America/Chicago`; UTC when empty), as are the times in emails and the monthly report's months. Settings, Notifications, has "Send test email" and "Send last month's report now" buttons; [Email notifications](DEPLOYMENT.md#email-notifications) covers the questions for the district's mail admin and the firewall.

[`DEPLOYMENT.md`](DEPLOYMENT.md) covers both, then the same steps by hand with `docker compose` as the fallback: first run and the end-to-end check, upgrades, backups and restore, TLS in front of the stack, what the stack hardens and what it needs from you, and the manual PM2 and nginx install for a server that cannot run Docker.

## License

ISC
