# Deployment

The supported way to run the system is the Docker Compose stack at the repo root (ADR 0005): one `compose.yaml` runs the database, the backend, and nginx serving the dashboard on one port, and the same file is the laptop demo and the district server. Deploying it is one step, two ways:

- **[The deploy script](#the-deploy-script)**: `deploy/deploy.sh` on Linux and macOS, `deploy\deploy.ps1` on Windows Server. It writes `.env` with generated secrets, builds and starts the stack, waits for it to be healthy, and handles upgrades, backups, restores, and removal, on this server or on any number of servers over ssh.
- **[Ask your Claude agent](#ask-your-claude-agent)**: in Claude Code in this repo, say "deploy this to admin@closet-mon" and the agent runs the script for you.

[Docker Compose by hand](#docker-compose-by-hand) is what both of them do, step by step, and the fallback when you want each command in front of you. The manual PM2 and nginx install stays at the [bottom](#manual-install-without-docker) for a server that cannot run Docker.

Throughout this guide, replace `YOUR_DOMAIN` with the hostname the site is served on.

## The deploy script

A new Linux server needs nothing but git and a login with sudo. On the server:

```bash
git clone <repo-url> temperature-alarms
cd temperature-alarms
deploy/deploy.sh bootstrap             # Docker Engine, Compose, and cron; adds you to the docker group
exit                                   # log out and back in, so the docker group applies
cd temperature-alarms
deploy/deploy.sh deploy --yes          # port 80, default thresholds, no questions
deploy/deploy.sh schedule-backup       # optional: a backup every night at 02:00, a week kept
```

`deploy/deploy.sh` with no action shows a menu instead. `bootstrap` supports Ubuntu, Debian, RHEL, Rocky Linux, AlmaLinux, CentOS Stream, and Fedora. On a server without git yet, install it first: `sudo apt-get update && sudo apt-get install -y git` on a minimal Debian or Ubuntu (a Proxmox CT template has none), `sudo dnf install git` on a minimal RHEL-family install; or run `bootstrap` from another machine with `--host` (below), which needs no checkout. Elsewhere, install Docker with the Compose v2 plugin yourself: Docker Desktop on macOS and Windows, Docker running Linux containers on Windows Server. On Windows:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1                 # Windows PowerShell 5.1
pwsh deploy/deploy.ps1 deploy --yes --web-port 8080                        # PowerShell 7
```

The two scripts are the same tool, with the same actions and the same flags; `--help` lists them. Run with no action, either one shows a menu. Every action also runs with `--yes`, which never prompts: it takes the flags given and the defaults for the rest.

| Action | What it does |
| --- | --- |
| `bootstrap` | Linux only. Installs Docker Engine, the Compose and buildx plugins, and containerd from Docker's own apt or dnf repository, the way [Docker's install guide](https://docs.docker.com/engine/install/) does it (signed by Docker's GPG key; not the `get.docker.com` script), plus git, curl, and cron (`cronie` on RHEL-family servers, whose minimal images have no cron). Enables and starts `docker` and cron, and adds you (the `sudo` caller) to the `docker` group. Uses `sudo` when not run as root. What is already installed is skipped, so it is safe to repeat. A server with a distribution `docker` but no Compose v2 is refused with the uninstall link rather than replaced |
| `preflight` | Checks Docker, Compose v2, that the daemon is up and runs Linux containers, that the web port is free (or already this stack's), and disk space |
| `install` | Creates `.env` from `.env.example` with `ADMIN_TOKEN`, `DEVICE_TOKEN`, `DB_PASSWORD`, and `DB_ROOT_PASSWORD` from a cryptographic random source, 64 hex characters each, asks for the port, the SMTP relay for [email notifications](#email-notifications) (blank for none), and, if you want, the thresholds and retention (`--web-port`, `--smtp-host` and the rest, `--set KEY=VALUE` without asking), and limits `.env` to its owner. An existing `.env` is kept: only empty secrets are filled, and nothing else changes without a yes (or `--reconfigure`) |
| `deploy` | Runs `install` if there is no `.env`, offers `git pull --ff-only` on a clean checkout (`--pull` to do it unasked, `--no-pull` to skip), runs preflight, `docker compose up -d --build --wait`, then checks `/api/health` through `web`. This is also the upgrade. On an install from before `DB_ROOT_PASSWORD`, it first gives MySQL root a password of its own, once, behind the typed project name ([Separate MySQL root password](#separate-mysql-root-password)) |
| `status`, `logs` | `docker compose ps` and the health check; recent logs (`--service api`, `--tail 500`, `--follow`) |
| `backup` | `mysqldump` through the `db` container to `backups/<project>_<date>-<time>.sql.gz`, checked for completeness, then records its time, name, and size in the database (`last_backup`) for Settings, System, which cannot see cron or `backups/` (a warning, and the backup kept, if the api is from before that table). `--keep-days N` then deletes this project's backups older than N days |
| `schedule-backup`, `unschedule-backup` | Adds a line to your crontab that runs `backup --keep-days 7` every night at 02:00 (`--at HH:MM`, `--keep-days N`), logging to `backups/backup.log`; or removes it. Repeating `schedule-backup` replaces its own line, found by a `# temperature-alarms backup: <checkout>` comment, and other crontab lines are never touched. Linux and macOS; in Git Bash or `deploy.ps1` on Windows it prints the `schtasks` command for Task Scheduler instead |
| `restore` | Replaces the whole database with a backup (`--file`, or pick from a list): it empties the database first, so a table the backup lacks does not survive it, and the api's migrations recreate any newer table, empty. Asks you to type the project name, and backs up the current database first, recording that backup again once the api is back |
| `info` | The dashboard URL, the four secrets (and `DEVICE_TOKEN_PREVIOUS` during a rotation) masked (`--reveal` to print them), the email relay and recipients (or `off`) with the SMTP login, its password masked whole, and the two `config.h` lines for the firmware |
| `rotate-device-token` | Starts a Device token rotation: the current token becomes `DEVICE_TOKEN_PREVIOUS`, still accepted, a new `DEVICE_TOKEN` is generated, `api` restarts with both, and the new `config.h` line is printed (masked unless `--reveal`). `--finish` ends it once Settings lists no Device on the previous token, and refuses otherwise; `--finish --force` ends it anyway, behind the typed project name ([Rotating the Device token](#rotating-the-device-token)) |
| `publish-firmware`, `firmware-status`, `withdraw-firmware` | Over-the-air firmware (ADR 0007; README, "Updating boards over the air"). `publish-firmware --file TemperatureAlarms.ino.bin.signed` offers a signed build to every Device, or with `--only ESP_A,ESP_B` to those first, each a registered Device (`ESP-A1B2C3` from a board's log is read as `ESP_A1B2C3`; the same file again without `--only` then widens it, refused while it is held); the image goes into `api` on stdin and is checked there (signed, with a version above the published one), and the answer says who it is offered to. `firmware-status` shows the build on offer, whether it is held and why, a line for each Device it is offered to with where it is on the way (waiting for its next check and when, downloading, running it with its clean Readings, or stuck: Offline, refused the image, never checked in), and the version each Device runs; `withdraw-firmware` stops offering it. The Settings page's Firmware tab does the same from a browser |
| `reset-admin-password` | A locked-out owner's way back in (ADR 0010): asks twice for a new password, not shown (with `--yes`, the first line of stdin; never an argument), and makes `admin`, or `--user NAME`, an enabled Admin with it, created if missing; its sessions end |
| `stop`, `uninstall` | `docker compose stop`; `docker compose down` and the built images, and the `schedule-backup` crontab line if there is one. `--wipe` also deletes the database volume, behind the typed project name. `.env` and `backups/` stay |

Running `deploy` twice is safe: an unchanged checkout leaves the containers running, and a changed one rebuilds and recreates only what changed. The destructive actions take `--confirm <project>` in place of typing the name, so they can be scripted too. The database volume is named after the Compose project, `<project>_db-data`, and the project is Compose's own default, the checkout's folder name. On first install the script writes that name into `.env` as `COMPOSE_PROJECT_NAME`, so renaming or moving the folder later still finds the same volume; it never rewrites the line. Pass `-p` only for a second stack on the same machine, and never to an existing install. An install made by hand before the script has no such line and keeps using the folder name; see [Docker Compose by hand](#docker-compose-by-hand) to pin it.

For a nightly backup, `deploy/deploy.sh schedule-backup` writes the crontab line for you. Backups stay on the server, so copy `backups/` somewhere else too. Settings, System shows how old the last backup is and says to run one once it is over two days old, so a nightly backup that stopped shows there.

### Many servers from one machine

From any machine with ssh access, give one or more servers and an action; the script runs itself on each one in turn and prints a summary:

```bash
deploy/deploy.sh deploy --host admin@closet-mon-hs --host admin@closet-mon-ms --yes
cp deploy/servers.example.txt deploy/servers.txt     # one USER@HOST per line; gitignored
deploy/deploy.sh bootstrap --servers deploy/servers.txt          # prepare new servers
deploy/deploy.sh deploy --bootstrap --servers deploy/servers.txt --yes   # or prepare and deploy in one go
deploy/deploy.sh schedule-backup --servers deploy/servers.txt --yes
deploy/deploy.sh status --servers deploy/servers.txt --yes
deploy/deploy.sh backup --servers deploy/servers.txt --yes
```

On each server it connects with plain `ssh`, clones the repo into `~/temperature-alarms` if it is not there yet (`--dir` for another path, such as an existing checkout; `--repo` and `--branch` for another source, by default this checkout's `origin`), and runs `deploy/deploy.sh` there with the same action and flags. So each server keeps its own `.env`, secrets, and `backups/`, and nothing secret crosses the network. A `deploy` to a remote server pulls the latest code first unless you pass `--no-pull`. With one server and no `--yes`, the menu and the prompts work over the ssh session.

`bootstrap` with `--host` or `--servers` copies `deploy.sh` to each server on its own and runs it there, so a server with no git and no checkout can be prepared from here. `deploy --bootstrap` runs `bootstrap` and then the deploy on each server; each is its own ssh login, so the deploy already has the new `docker` group. `sudo` on the server asks for your password when you run from a terminal; unattended (`--yes` from a script or an agent), the login needs passwordless sudo, and without it `bootstrap` stops and says so.

Apart from `bootstrap`, the servers need git, Docker with Compose v2, and a login that can run `docker` (in the `docker` group), which is what `bootstrap` sets up. Key-based ssh saves typing a password per server; extra ssh options go in `--ssh-opts "-p 2222 -i ~/.ssh/district"` or `DEPLOY_SSH_OPTS`. `deploy.ps1` takes the same `--host`, `--servers`, and `--bootstrap` flags and uses the OpenSSH client built into Windows. The remote side is always `deploy.sh`, so the targets are Linux or macOS servers; for a Windows server, run `deploy.ps1` on it.

### Proxmox LXC

The deploy script runs in a Proxmox container (CT) the same way as on any Debian server, provided the CT can run Docker. This was tested end to end on a stand-in, not on Proxmox itself: a `debian:12` container with systemd as PID 1, run privileged under Docker Desktop (WSL2 kernel 6.18, cgroup v2). Everything below the "Not proven" list is what that run showed.

CT settings:

- **Template and features**: `debian-12-standard`, with `features: nesting=1,keyctl=1` (Options, Features: Nesting and keyctl). Nesting is what lets Docker run inside; Proxmox applies keyctl only to an unprivileged CT.
- **Privileged or unprivileged**: the stand-in was privileged with the host's cgroup namespace, the closest match to a privileged CT, and everything passed. An unprivileged CT with nesting and keyctl is the usual community setup for Docker and is not proven here (see below). Proxmox's own documentation recommends a VM for application containers such as Docker; a small Debian VM runs this stack with the same commands and none of the caveats below.
- **Storage**: Docker 29 on a fresh install keeps images in containerd's store with the `overlayfs` snapshotter (`docker info` shows `Storage Driver: overlayfs`, `driver-type: io.containerd.snapshotter.v1`). It worked with `/var/lib/docker` and `/var/lib/containerd` on ext4. It failed on a root that is itself overlayfs, at the first `docker run`: `failed to mount ... fstype: overlay ... err: invalid argument`. A CT root on LVM-thin or a directory store is ext4 and fine. On ZFS, overlayfs needs ZFS 2.2 or newer (Proxmox VE 8.1 and later); on older ZFS, give the CT a mount point on ext4 for `/var/lib/containerd` and `/var/lib/docker`. Neither fuse-overlayfs nor vfs was needed.
- **Clock**: a CT has no clock of its own; it reads the Proxmox host's. Let the host slew its clock rather than step it: Proxmox VE runs chrony, so check that `/etc/chrony/chrony.conf` on the host has `makestep 1 3` (step only in the first three updates after boot) and nothing that steps later. In the load test a 5-hour step lasting 12 seconds stamped Readings 5 hours ahead. The stack now passes over Readings stamped more than 5 minutes ahead and times its rate limits and the browser's ages on monotonic clocks, so a step no longer freezes cards or locks Devices out, but the Readings stamped during it still carry the wrong time.
- **Resources**: the running stack uses about 640 MiB on a new install (MySQL about 500, the API about 120, nginx about 10). MySQL grows to about 1 GiB as its 512 MB buffer pool fills, which at 100 Devices takes a few weeks of Readings (see [Database settings and sizing](#database-settings-and-sizing)). The whole CT peaked at about 1.3 GiB during a first build with no cache. After the first deploy, Docker's stores held 3.4 GB (`/var/lib/containerd` 2.1 GB, `/var/lib/docker` 1.3 GB, of which 0.8 GB is build cache), on top of about 1.5 GB for Debian, Docker's packages, and the clone. Give the CT 3 GiB of memory, 512 MiB of swap, 2 cores, and a 24 GB disk: a running stack of about 1.1 GiB plus an upgrade's build of about 1.3 GiB, and 90 days of Readings for 100 Devices (about 3 GB) plus a week of nightly backups (about 1 GB) on top of the 5 GB above, with room for upgrades. 2 GiB and 16 GB are enough for the first weeks. For 300 Devices, 4 GiB with `DB_BUFFER_POOL_SIZE=1G` (`deploy.sh install --set DB_BUFFER_POOL_SIZE=1G --reconfigure`) and 32 GB. The rule behind these: MySQL takes about `DB_BUFFER_POOL_SIZE` plus 400 MiB, the api and nginx about 150 MiB, and an upgrade's build about 1.3 GiB on top while it runs. A first build took 3 minutes on 12 cores; fewer cores take longer.

The exact sequence, as the CT's sudo user (`admin` here), from a fresh debian-12 CT:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/HamzaQaz/Temperature-Alarms-React.git temperature-alarms
cd temperature-alarms
deploy/deploy.sh bootstrap             # Docker 29 from Docker's apt repository, cron, the docker group
exit                                   # log in again, so the docker group applies
cd temperature-alarms
deploy/deploy.sh deploy --yes          # port 80
deploy/deploy.sh info                  # the URL and config.h lines; --reveal for the tokens
deploy/deploy.sh schedule-backup --yes # nightly at 02:00, a week kept
```

What the run showed: `bootstrap` installs and enables Docker, containerd, and cron, and a second run changes nothing. A restart of the CT brings the stack back on its own, healthy and with its data, in about 12 seconds, because `docker` is enabled and every service restarts unless stopped. The cron line fires and writes a backup. `deploy.sh demo --web-port 8091` runs beside the real install on its own volume without touching it. `--at` is the CT's local time, and a fresh CT's clock is UTC, so the default 02:00 is 02:00 UTC; set the zone first (`sudo timedatectl set-timezone America/Chicago && sudo systemctl restart cron`) for a local 02:00. The stack itself runs in UTC either way, unless `TZ` in `.env` names the zone for `api`. `info` reports the CT's own address, the one Devices and browsers use when the CT is on a bridge to the LAN.

Not proven by the stand-in, so check these on the real CT:

- An unprivileged CT. Its uid mapping and AppArmor confinement are where Docker inside LXC most often fails. If `docker run` fails there with `permission denied` from AppArmor or on a sysctl, the stand-in, which had no AppArmor, could not have shown it; try a privileged CT, or ask before relaxing the CT's AppArmor profile.
- ZFS or LVM-thin storage, and the snapshotter on them (the stand-in's Docker stores were on ext4 volumes).
- The Proxmox kernel, the Proxmox firewall, and the bridge: the stand-in published port 80 through Docker, not through `vmbr0`. Check `http://<CT address>/api/health` from another machine on the LAN.
- Starting with the Proxmox host: set the CT to start at boot (`onboot: 1`); the stand-in only restarted the CT, not a host.

## Ask your Claude agent

With [Claude Code](https://claude.com/claude-code) open in this repo, ask for what you want in plain words:

- "Set up the new server admin@closet-mon-hs" (bootstrap, then deploy)
- "Deploy this to admin@closet-mon-hs on port 8080"
- "Upgrade the servers in deploy/servers.txt"
- "Back up the database", "back up nightly", or "restore yesterday's backup"
- "Is the stack healthy?"

The `deploy` skill in `.claude/skills/deploy/` has the agent run the deploy script non-interactively. It asks only for what it cannot find out (the server and, on a first install, the port), runs preflight before deploying, never prints a token or password into the chat (it shows `info` masked and tells you how to reveal them yourself), asks you before a restore or a wipe, and finishes on the health check. It needs ssh to the server to work without a password prompt.

## Docker Compose by hand

The stack is three services on a private network:

| Service | What it is | Reachable from |
| --- | --- | --- |
| `db` | MySQL 8.4 with its data on the named volume `db-data` | `api` only, or `docker compose exec db` |
| `api` | The backend, one process (ADR 0001), built from `backend/Dockerfile` | `web` only, or `docker compose exec api` |
| `web` | nginx serving the built frontend and proxying `/api/` to `api` with the SSE settings, built from `frontend/Dockerfile` | `http://<host>:WEB_PORT`, port 80 by default |

Every service restarts unless stopped and has a healthcheck, logs are capped at three files of 10 MB each, and the dashboard's own origin serves the API, so no CORS setting is needed. The frontend is built with no API address on purpose: one image works on any hostname. nginx in `web` runs as a non-root user, so inside the container it listens on 8080; Compose publishes that on the host as `WEB_PORT`, still 80 by default, so nothing outside the container sees the 8080.

The database volume is named after the Compose project, `<project>_db-data`, and the project name defaults to the name of the folder the repo is cloned into, lower-cased: `temperature-alarms` below, `temperature-alarms-react` for the README's quick start clone. Run the stack from a renamed or moved folder and Compose starts on a new, empty volume, leaving the old one orphaned (`docker volume ls` shows both). To keep the name whatever the folder is called, set it in `.env`: `COMPOSE_PROJECT_NAME=temperature-alarms`, with the name `docker volume ls` shows before `_db-data`. The deploy script writes that line on first install, so a stack it installed keeps its volume through a rename, and it never changes the line afterwards.

### Setup

Install Docker: Docker Desktop on a laptop, or on Ubuntu Server [Docker Engine with the Compose plugin](https://docs.docker.com/engine/install/ubuntu/) (`docker compose version` should print a v2 number). Then:

```bash
git clone <repo-url> temperature-alarms
cd temperature-alarms
cp .env.example .env
nano .env
```

Set the four secrets; `docker compose up` refuses to start and names any that is empty:

| Variable | Value |
| --- | --- |
| `ADMIN_TOKEN` | The secret scripts send in place of signing in (the bench watcher, the end-to-end walk, the demo, deploy's rotation check); as a Bearer it may do whatever an Admin may. People sign in instead (ADR 0010). Generate it with `openssl rand -hex 32` and give it only to whoever runs those scripts |
| `DEVICE_TOKEN` | The secret every Device sends with every Reading. Generate another one; it goes into each board's `config.h`, so rotating it means reflashing every Device, which `DEVICE_TOKEN_PREVIOUS` makes a rolling job rather than a flag day ([Rotating the Device token](#rotating-the-device-token)) |
| `DB_PASSWORD` | The password of the database user `api` connects as. Generate a third one; nothing outside the stack can reach the database |
| `DB_ROOT_PASSWORD` | The password of MySQL root, which logs in only inside the `db` container, for backups and restores. Generate a fourth one. Only `db` gets it, never `api`, so a bug in `api` cannot become MySQL root. MySQL takes it when the volume is first created; changing it later is the procedure in [Separate MySQL root password](#separate-mysql-root-password) |

`WEB_PORT` is the only port published; leave it at 80 so boards and browsers need no port in their URL. `TRUST_PROXY` stays empty unless a TLS proxy sits in front of the stack ([TLS in front of the stack](#tls-in-front-of-the-stack)). Every other setting in `.env.example` is the backend's and has the default shown. `TZ` is `api`'s time zone, an IANA name like `America/Chicago`: quiet hours, the times written in emails, and the monthly report's months are read in it. Left empty it is UTC, the container's own, as before it existed; set it with `install --reconfigure --yes --set TZ=America/Chicago`, then `deploy --yes`. `api` refuses to start on a zone Node does not know, naming it, rather than quietly running in UTC. The `SMTP_*`, `NOTIFY_*`, and `PUBLIC_URL` lines stay commented until you turn on [email notifications](#email-notifications). `.env` is gitignored.

### First run

```bash
docker compose up -d --build
docker compose ps        # wait until db, api, and web all say "healthy"
```

The first build downloads the base images and compiles both packages, a couple of minutes; later builds reuse the layers. On start, `api` waits for `db` to answer, creates or upgrades the schema itself through its migration runner, and `web` starts once `api` answers `/api/health`. Then open `http://<host>/` (with `:WEB_PORT` only if you changed it).

Walk the whole path once, before any Device is flashed. Open `http://<host>/settings`, sign in as `admin` / `admin` and choose a new password (see [Users and signing in](#users-and-signing-in)), add a Campus, and add a Device with the hostname `ESP_A1B2C3` (the commands below post as that hostname; any other gets a 404). With the dashboard open in another tab, post a Reading for that Device from the host:

```bash
set -a; source .env; set +a
curl http://localhost/api/health                       # {"status":"ok","database":"connected"}
curl -N http://localhost/api/dashboard/stream          # stays open and prints events; Ctrl-C
curl -i http://localhost/api/readings -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DEVICE_TOKEN" -d '{"device":"ESP_A1B2C3","temp":72,"humidity":40}'   # 201
curl -i http://localhost/api/readings -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer wrong' -d '{"device":"ESP_A1B2C3","temp":72,"humidity":40}'             # 401
```

The card should update without a reload, and the History link on it should show that Reading in today's list. For a card that keeps moving, run the virtual Device that ships in the `api` image; it reads the Device token and port from the container's environment, so only the hostname you registered is needed:

```bash
docker compose exec api node scripts/mock-device.mjs --hostname ESP_A1B2C3
docker compose exec api node scripts/mock-device.mjs --hostname ESP_A1B2C3 --count 3   # three Readings, then watch the card go Offline
```

Reset history on the Device's History page removes every Reading of the Device, so use it before the real Device starts reporting; or register a throwaway Device for the test and delete it afterwards, since its Readings go with it.

Useful commands:

```bash
docker compose logs -f api        # migrations, retention
docker compose logs -f web        # nginx access and error log
docker compose restart api
docker compose down               # stop; the data stays on the volume
docker compose down -v            # stop and wipe the database
```

Once a day, and once at every start, the backend deletes Readings older than `RETENTION_DAYS` (90 unless `.env` says otherwise; see ADR 0004) and logs a line like `retention: removed 12480 readings older than ...`. Nothing is archived first: export anything you want to keep before it ages out.

### Users and signing in

A fresh install has one user, `admin` with the password `admin`, and `api`'s log says when it creates it. Sign in with it and the site asks for a new password (8 characters or more) before anything else. Then add each technician on Settings, Users: an Admin changes things and manages users, a Viewer only looks. A session lasts 12 hours unused and 7 days at most; disabling a user or setting their password signs them out at once. Ten wrong passwords for a username, or thirty from one address, in 15 minutes lock sign-in for it until the 15 minutes pass. Behind a TLS proxy, the proxy must send `X-Forwarded-Proto: https` (Caddy, Traefik and nginx do) so the session cookie is marked Secure.

Locked out, with no Admin able to sign in: `deploy/deploy.sh reset-admin-password` (or `deploy.ps1`) asks twice for a new password, not shown, and makes `admin` (or `--user NAME`) an enabled Admin with it, creating the user if it is gone. With `--yes` it reads the password from the first line of stdin. On a manual install, `printf '%s\n' "$PW" | node dist/userCli.js reset-admin-password` in `backend/` does the same.

### Upgrades

```bash
git pull
docker compose build --pull       # newer node and nginx base images, for their security patches
docker compose up -d --build
docker image prune -f             # drop the previous images
```

Compose rebuilds what changed and recreates only those containers. New schema migrations run on the first start of the new `api`, and the data on the volume is untouched. A change to `.env` needs `docker compose up -d` as well; Compose recreates the containers whose environment changed. Run every upgrade from the same folder, or with `COMPOSE_PROJECT_NAME` set as described above: a stack first started from a differently named folder keeps its old volume name, and `docker volume ls` shows which one holds the data. An install from before `DB_ROOT_PASSWORD` (2026-10-06) stops at `docker compose build` with `Set DB_ROOT_PASSWORD in .env`: move root over once, as [Separate MySQL root password](#separate-mysql-root-password) describes, then carry on.

An upgrade that adds an index to `readings` takes `api` off the air while it builds, since migrations run before it listens: migration `0006-readings-covering-index` took 33 s at 26 M Readings (90 days of 100 Devices), so each Device misses about one Reading. To lose none, build it first by hand while the old `api` keeps serving; MySQL builds it online, ingest kept working throughout (all 201s, p99 0.36 s during the 32 s build), and the migration then finds it done:

```bash
docker compose exec db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot temperature_alarms -e "ALTER TABLE readings ADD INDEX ix_readings_device_recorded_temp (device_id, recorded_at, id, temp_f), DROP INDEX ix_readings_device_recorded, ALGORITHM=INPLACE, LOCK=NONE"'
```

The migration runner holds a MySQL lock while it works, so a second runner, such as a second `api` started while the first is still applying a long migration, waits for the first to finish. After ten minutes it gives up with `Another migration run still holds the lock`; run it again once the first has finished.

### Separate MySQL root password

Since 2026-10-06 MySQL root has its own password, `DB_ROOT_PASSWORD`, which only the `db` container holds, and logs in only through the socket inside it. Before that, root shared `DB_PASSWORD` with `api`, and volumes created before `MYSQL_ROOT_HOST` also let root log in over the stack's network, so a code-execution bug in `api` was a MySQL root login away from every schema and user.

MySQL reads the root password only when the volume is first created, so an existing install has to move over once. `compose.yaml` refuses to start without `DB_ROOT_PASSWORD`, and says so. `deploy.sh deploy` (or `deploy.ps1`) does the move for you: it explains it, asks for the project name to be typed (`--confirm <project>` with `--yes`), starts `db`, takes a backup, drops `root@'%'` if it exists, sets the new root password, writes it to `.env`, and only then deploys. Until that deploy, the script's other actions, backups included, keep working with the old shared password. `install` never generates a root password for an existing volume, since the volume would not have it.

By hand instead, from the checkout, with `.env` holding no `DB_ROOT_PASSWORD` yet (the old password is `DB_PASSWORD`, so it is given to Compose for this once):

```bash
set -a; . ./.env; set +a                          # DB_PASSWORD, for the next lines only
NEW=$(openssl rand -hex 32)
DB_ROOT_PASSWORD="$DB_PASSWORD" docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot' <<SQL
DROP USER IF EXISTS 'root'@'%';
ALTER USER 'root'@'localhost' IDENTIFIED BY '$NEW';
SQL
echo "DB_ROOT_PASSWORD=$NEW" >> .env
docker compose up -d                              # recreates db with the new MYSQL_ROOT_PASSWORD
unset NEW DB_PASSWORD
```

The heredoc keeps the new password off every command line. Check it took: `docker compose exec db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -e "SELECT user, host FROM mysql.user"'` lists `root` at `localhost` only.

### Backups and restore

Everything lives in the `db-data` volume. Dump it through the `db` container. Every command in this guide hands MySQL its password inside the container, from the container's own `MYSQL_ROOT_PASSWORD`, so it is never on a command line that the host's `ps` or your shell history would show; the single quotes keep your shell from expanding it:

```bash
(umask 077; docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction temperature_alarms' | gzip > backup_$(date +%Y%m%d_%H%M%S).sql.gz)
```

For a nightly copy on a server, put that line in a script and run it from cron, keeping the last week:

```bash
sudo tee /usr/local/bin/backup-temperature-db.sh >/dev/null <<'EOS'
#!/bin/bash
cd /path/to/temperature-alarms || exit 1
umask 077
DIR=/var/backups/temperature-alarms
mkdir -p "$DIR"
F="$DIR/backup_$(date +%Y%m%d_%H%M%S).sql.gz"
docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction temperature_alarms' | gzip > "$F"
# Tells Settings, System when (deploy.sh backup does this itself).
echo "REPLACE INTO last_backup (id, finished_at, file) VALUES (1, UTC_TIMESTAMP(), '$(basename "$F")');" | docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot temperature_alarms'
find "$DIR" -name 'backup_*.sql.gz' -mtime +7 -delete
EOS
sudo chmod +x /usr/local/bin/backup-temperature-db.sh
# crontab -e:  0 2 * * * /usr/local/bin/backup-temperature-db.sh
```

Restore into a running stack (the `-T` matters, it lets the file stream in). `deploy/deploy.sh backup` and `restore` do all of this for you, and `restore` backs up first:

```bash
docker compose stop api
docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -e "DROP DATABASE temperature_alarms; CREATE DATABASE temperature_alarms"'
gunzip -c backup_20260909_020000.sql.gz | docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot temperature_alarms'
docker compose start api
```

The drop and create matter: a dump replaces only the tables it holds, so without them a table added after the backup (the incident log, for one) would keep rows from after the backup point, pointing at Readings that are gone. The `temperature` user's grant survives the drop, and the api recreates any table the dump lacks, empty, when it starts.

To move to another machine, copy the repo, the `.env`, and a dump; `up -d --build` there, then restore. Keep `COMPOSE_PROJECT_NAME` in the copied `.env`, or clone into a folder of the same name, so the new machine's volume has the name the old one had.

### Database settings and sizing

`compose.yaml` starts MySQL with two settings of its own (the `command:` of `db`):

- **`--disable-log-bin`: no binary log.** Nothing replicates from this database and there is no point-in-time recovery: the backups are the `mysqldump` files above, and a restore brings back the moment of the dump, no later. MySQL 8.4 writes a binary log by default and keeps 30 days of it; nothing here read it, yet each Reading paid a second fsync for it (a commit took 3.75 ms with it and 1.72 ms without), and it held about 3 GB at 100 Devices, plus a full copy of every restored dump. `deploy.sh backup` and `restore` work the same without it (they use `mysqldump --single-transaction`, which needs no binary log). If you ever add a replica or want point-in-time recovery, remove the flag and plan the disk for the log.
- **`--innodb-buffer-pool-size=512M`**, where MySQL's default is 128 MB. The Campuses overview reads a week of every Device's Readings; with 128 MB that week did not stay in memory and the page took seconds at 90 days. 512 MB holds it for 100 Devices with room to spare. Set `DB_BUFFER_POOL_SIZE` (for example `1G` for 300 Devices or more, on a CT with 4 GiB) with `deploy/deploy.sh install --set DB_BUFFER_POOL_SIZE=1G --reconfigure` and then `deploy/deploy.sh deploy`, or in `.env` followed by `docker compose up -d`. MySQL uses about the pool plus 400 MiB, so every step up in the pool is the same step up in the CT's memory.

What to plan for, measured with 100 Devices posting every 30 seconds and 90 days kept (26 M Readings):

| | 100 Devices | Each further 100 |
|---|---|---|
| MySQL memory | about 470 MiB on a new install, growing to about 1 GiB as the buffer pool fills | the same with 512M; raise `DB_BUFFER_POOL_SIZE` past 300 |
| `readings` on disk at 90 days | about 3.0 GB (table 1.2 GB, indexes 1.8 GB) | about 3 GB |
| One backup (`backups/*.sql.gz`) | about 150 MB, taking 30 s | about 150 MB |
| Restore of that backup | about 4.5 minutes, the api down throughout | proportionally longer |

Readings keep arriving for the first 90 days and then level off, since the retention job removes what is older.

### TLS in front of the stack

The stack serves plain HTTP on purpose: a certificate needs a public hostname, and a laptop demo or a closet network has none. On the district server, put a TLS proxy on the host in front of the one published port. Move the stack off port 80 and keep it on the loopback address so only the proxy reaches it, `WEB_PORT=127.0.0.1:8080` in `.env`, then `docker compose up -d`.

Devices already flashed with `http://<host>` must keep reporting, and they cannot follow a redirect: the firmware's HTTP client logs `report: 308` and records nothing. So the proxy redirects browsers to HTTPS but passes `POST /api/readings` through on plain HTTP, for the domain and for any address a Device was flashed with.

The shortest proxy is [Caddy](https://caddyserver.com/docs/install), which obtains and renews the certificate itself. `/etc/caddy/Caddyfile`:

```
# Plain HTTP: Devices keep posting Readings, everything else moves to HTTPS.
(plain_http) {
	handle /api/readings {
		reverse_proxy 127.0.0.1:8080
	}
	handle {
		redir https://YOUR_DOMAIN{uri} 308
	}
}

YOUR_DOMAIN {
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
	}
}

http://YOUR_DOMAIN {
	import plain_http
}

# Devices flashed with the server's IP address rather than its hostname.
http:// {
	import plain_http
}
```

`flush_interval -1` keeps the SSE stream unbuffered. Keep `http://YOUR_DOMAIN` as a block of its own: listed together with `http://`, Caddy drops the hostname and adds its own redirect for the domain in front of the Readings route. `sudo systemctl reload caddy`, open the firewall (`sudo ufw allow OpenSSH`, `sudo ufw allow 80,443/tcp`, `sudo ufw enable`), and the site is on `https://YOUR_DOMAIN`.

With nginx and certbot instead, follow steps 5 and 6 of the [manual install](#5-nginx), which give the same split, with every `proxy_pass` pointed at `http://127.0.0.1:8080` and the snippet's `root`, `index`, and asset locations replaced by a single `location /` carrying the same `proxy_*` lines as its `/api/` block.

Boards with an `https://` server URL check the certificate against Let's Encrypt's roots and the hostname (README, Transport for production boards), so any renewal, Caddy's or certbot's, is fine for them. The Firmware tab uploads a build of about 430 KB to `/api/firmware`: Caddy has no body limit, and an nginx in front needs `client_max_body_size 1m;` in its HTTPS server, since its default is exactly 1 MB and a bigger build would be refused. One with `http://YOUR_DOMAIN`, or `http://` and the server's address, keeps posting over plain HTTP through the blocks above; with the stack on `127.0.0.1:8080`, the proxy is now the only way in.

#### Client addresses behind the proxy: `TRUST_PROXY`

Behind the proxy, every browser and every Device reaches the stack's nginx from the proxy's one address. Per-address limits then count the whole district as one client:

- the cap of 60 open live streams per address, one per open Dashboard or Campuses tab, which both nginx and the backend apply (and 400 in all, in the backend). The 61st tab open anywhere gets a 429 for its stream, shows Reconnecting, and tries again every 5 seconds until another tab closes. The load test held 60 streams with the stream adding 1 to 2 ms to each Reading's delivery.
- the general limits per 15 minutes: 6,000 reads (GET), which about 30 open tabs stay well under (a Campuses tab, the busiest, makes about 90), and 500 changes (everything else; Readings have their own per-Device limit and are not counted). An office of browsers behind one NAT address shares these too, with or without the proxy.
- the cap of 100 wrong Device tokens per 15 minutes. Past it, every Reading from that address is refused, even with the right token. A few boards still flashed with an old token would then stop every Device behind the proxy from recording.

Set `TRUST_PROXY` in `.env` to the proxy's address, then run `docker compose up -d`, which recreates only `web`. nginx then takes the client from the proxy's `X-Forwarded-For`, and each browser and Device counts on its own:

| Where the proxy runs | `TRUST_PROXY` |
| --- | --- |
| On this host, as above (Caddy or nginx proxying to `127.0.0.1:8080`) | `gateway`. A host proxy reaches the container through the Docker network's gateway; nginx looks that address up when it starts. Only with `WEB_PORT=127.0.0.1:PORT`: Docker's userland proxy delivers other connections from the gateway too (every IPv6 client, since `web` listens on IPv4, and on hosts without iptables NAT every client), so with the port open to the network any of them could claim to be anyone. `deploy.sh` and `deploy.ps1` refuse to deploy `gateway` with the port open |
| On another machine, or in a container on the stack's network | Its IP address, or several, comma-separated: `10.20.0.5,10.20.0.6`. CIDR ranges work too: `10.20.0.0/29` |

Leave it empty with no proxy in front. That is the default, and nginx then counts the address it sees, as without the setting. `deploy/deploy.sh install` asks for the value only when you say a proxy is in front; non-interactively, use `--set TRUST_PROXY=gateway` (with `--reconfigure` on an existing `.env`). `docker compose logs web` shows what nginx trusts, as a line starting `real-ip:`.

nginx believes `X-Forwarded-For` only on connections from the addresses you list. It reads the header from the right and stops at the first address it does not trust, so a value a browser wrote itself is ignored, and so is any request that skips the proxy. The backend trusts one hop, the stack's nginx, so it sees the address nginx settled on. Never list an address that ordinary clients connect from, such as the LAN's whole range when `WEB_PORT` is open to the LAN. Anyone at a listed address can claim to be any client. `0.0.0.0/0` is refused for that reason, and so is any value that is not an address: `web` does not start and its log says why.

### Rotating the Device token

Every board carries the one Device token, so a lost or stolen board, or a token seen where it should not be, means a new token in every board's flash. The backend accepts a second, previous token while that happens (ADR 0003), so no board goes dark:

1. `deploy/deploy.sh rotate-device-token`: the current token moves to `DEVICE_TOKEN_PREVIOUS` in `.env`, a new `DEVICE_TOKEN` is generated, and `api` restarts with both. If `api` does not come back healthy, `.env` goes back to the old token alone. The new `config.h` line is printed masked; `deploy.sh info --reveal` prints it in full.
2. Reflash every board with the new token (README, "Flashing a batch"). Boards on either token keep reporting meanwhile.
3. Settings shows an Admin the rotation: each Device whose latest Reading still came with the previous token, and each Device not heard since `api` last started (whose token it cannot know yet). `api`'s log names each Device still on the previous token once an hour, by hostname, never the token. The same list is `GET /api/devices/rotation` with the Admin token.
4. When the list is empty, `deploy/deploy.sh rotate-device-token --finish` clears `DEVICE_TOKEN_PREVIOUS` and restarts `api`; the old token is refused from then on. While any Device is listed it refuses, naming them: reflash them, or delete in Settings a Device that is gone for good, and run it again a Report interval later. `--finish --force` (typed project name) ends the rotation anyway, and the boards still on the old token stop reporting until reflashed.

Only Readings with neither token count toward the wrong-token limit (100 per address per 15 minutes), so boards on the previous token never lock out their campus. The backend refuses to start if `DEVICE_TOKEN_PREVIOUS` equals `DEVICE_TOKEN` or `ADMIN_TOKEN`. A second rotation is refused until the first is finished; the list lives in `api`'s memory, so after a restart every Device is "not heard" until its next Reading, within one Report interval.

### Email notifications

The server emails the technicians when an Incident opens, gets worse (its level rises), or closes, through the district's SMTP relay (ADR 0008). Changes within a minute of each other arrive as one email per recipient list, worst first, so a campus power cut is one email, not twenty. Devices on the Bench never email. It is off until `SMTP_HOST` is set, and the Settings page says so.

**Recipients per Campus.** `NOTIFY_TO` is the default list. A Campus can name its own on Settings, Campuses (the pencil on its row, as an Admin), so a campus's technicians get only their campus's mail; a Campus without one emails `NOTIFY_TO`. The lists live in the database, so a backup carries them. For a district office that wants every email as well, `install --reconfigure --yes --set NOTIFY_TO_ALL=true`, then `deploy --yes`, copies `NOTIFY_TO` on each Campus's email. Settings, Notifications, lists every recipient list with the Campuses on it and how its last email went; a list the relay refuses is retried on its own, without resending the others.

**Reminders** (`NOTIFY_REMIND_HOURS`, off by default): an Incident still open with no one having acknowledged it after that many hours is emailed again, `[Temperature Alarms] Still open: CHS IDF 2 Hot critical, 4 h`, and again every as many hours after, until it closes or someone acknowledges it on the Dashboard or the Incidents log. The hours count from the Incident's start, so a restart neither repeats a reminder nor starts the count again. Interactive `install` offers 4; `--notify-remind-hours N` sets it (1 to 168), and `--notify-remind-hours 0` turns them off. There is no cap on how many an Incident gets: acknowledging it is how they stop, so acknowledge an unplugged board on the Bench of a closed school, or delete it.

**Quiet hours** (`NOTIFY_QUIET_HOURS`, `NOTIFY_QUIET_WEEKENDS`, off by default): warning emails wait while they last and go out when they end, in the first pass after, one email per recipient list, so a technician reads the night's warnings at 07:00 instead of being woken by them. `--notify-quiet-hours 18:00-07:00` sets a nightly window, two 24-hour times in `TZ` (set it, or they are UTC), the end before the start for a window past midnight; `--notify-quiet-weekends on` holds them all Saturday and Sunday too, so with both a Friday 18:00 warning waits until Monday 07:00. Every warning waits, Mold risk high (humid) included, and so do the reminders and closing emails of warning Incidents. Critical Incidents, Offline, and Sensor fault never wait, nor do held firmware releases or the monthly report. A warning that turns critical sends at once as "got worse", and the warnings it had waiting go with it, so the morning does not repeat it; an Incident that opened and ended in the night arrives in the morning's email as "opened and resolved". A held email's 24 hours of retries count from when the quiet ended, not from when it was queued. Settings, Notifications, says when quiet hours are and how many emails they hold, until when. `--notify-quiet-hours off` (or `--notify-quiet-weekends off`) turns them off; interactive `install` asks, offering off. School holidays are not quiet hours.

**Monthly report** (`NOTIFY_MONTHLY_REPORT=true`, off by default): on the 1st of each month `NOTIFY_TO` gets one email on the month just ended (a Campus's own list never does), for facilities' HVAC work: `[Temperature Alarms] Monthly report, September 2026: 5 incidents, 1 closet ran warm`, with the incidents and time in each Condition, the five hottest and five most humid closets with their peaks, the closets that ran warm (more than half their Readings within 3 °F of `HOT_WARNING_F`, or above it), and each Device's Offline and Sensor fault time, every closet linked to its History. It goes out once a month whatever the restarts, from midnight on the 1st in the server's zone, or as soon as the server is back if it was down then; turned on mid-month, last month's goes at once. The Bench is left out. `--notify-monthly-report on` (or `off`) sets it; interactive `install` asks, offering yes. "Send last month's report now" on Settings sends one whenever you like, on or off.

**Ask the district's mail admin first.** Four answers decide the settings:

- **The relay** (`SMTP_HOST`) and its port. Usually an internal relay, or the Exchange or Microsoft 365 connector the district already uses for printers and scanners.
- **Allowed sender or service account.** Does the relay accept mail from this server's address without a login (an allowed-sender or relay rule for its IP), or does it need a service account? With a rule, leave `SMTP_USER` and `SMTP_PASSWORD` empty; with an account, set both. The address the relay sees is the host's, not the container's.
- **The sender address** the relay lets this server send as (`NOTIFY_FROM`), such as `temperature-alarms@YOUR_DOMAIN`.
- **A distribution list** for `NOTIFY_TO`, such as `network-techs@YOUR_DOMAIN`, so who receives alerts changes in Exchange, not in `.env`. Several addresses, comma-separated, work too.

**Ports and the district firewall.** `api` connects out to the relay; nothing connects in. Pick the port with the mail admin:

| Port | `SMTP_SECURE` | When |
| --- | --- | --- |
| 587 | `starttls` (the default) | Submission, encrypted with STARTTLS. The usual choice, and the one a service account needs. The server refuses to send if the relay does not offer STARTTLS, rather than send in plain text |
| 465 | `tls` | TLS from the first byte, for a relay that offers it instead of 587 |
| 25 | `none` (or `starttls` if the relay offers it) | An internal relay that accepts plain SMTP from allowed addresses. Many district firewalls block port 25 out of server VLANs, to stop infected machines sending spam; ask for this server to reach the relay on it |

Whichever port, the firewall between this server and the relay must allow it. From the server, `nc -vz RELAY 587` (or the port you chose) should connect; `openssl s_client -starttls smtp -connect RELAY:587 -brief </dev/null` shows the relay's certificate for STARTTLS.

**Turn it on** with the deploy script. Interactively, `deploy/deploy.sh install --reconfigure` asks for each value, the password at a hidden prompt; leave the relay blank for no email. Non-interactively:

```bash
# A relay that accepts this server's address (no login):
deploy/deploy.sh install --reconfigure --yes \
  --smtp-host relay.YOUR_DOMAIN --notify-from temperature-alarms@YOUR_DOMAIN \
  --notify-to network-techs@YOUR_DOMAIN --public-url https://YOUR_DOMAIN
# With a service account: the password goes in on stdin, never on the command line, where any
# process on the host could read it. read and printf are bash builtins, so they show it nowhere.
read -rs PW && printf '%s\n' "$PW" | deploy/deploy.sh install --reconfigure --yes \
  --smtp-host relay.YOUR_DOMAIN --smtp-user svc-temperature-alarms \
  --notify-from temperature-alarms@YOUR_DOMAIN --notify-to network-techs@YOUR_DOMAIN \
  --public-url https://YOUR_DOMAIN; unset PW
deploy/deploy.sh deploy --yes            # recreates api with the new settings
```

```powershell
$pw = Read-Host -AsSecureString 'SMTP password'
[Net.NetworkCredential]::new('', $pw).Password | .\deploy\deploy.ps1 install --reconfigure --yes `
  --smtp-host relay.YOUR_DOMAIN --smtp-user svc-temperature-alarms `
  --notify-from temperature-alarms@YOUR_DOMAIN --notify-to network-techs@YOUR_DOMAIN --public-url https://YOUR_DOMAIN
.\deploy\deploy.ps1 deploy --yes
```

`--smtp-port` and `--smtp-secure` take the table's values; without them it is 587 and STARTTLS. `--public-url` is the address technicians open the dashboard at, used for the History links in each email: `https://YOUR_DOMAIN` behind the [TLS proxy](#tls-in-front-of-the-stack). Each flag changes only its own setting, so `install --reconfigure --yes --notify-to oncall@YOUR_DOMAIN` changes the recipients alone (and `--notify-remind-hours 4` the reminders alone, `--notify-monthly-report on` the report alone, `--notify-quiet-hours 18:00-07:00` the quiet hours alone), and `--smtp-user` again with nothing on stdin keeps the current password. `--smtp-host off` turns email off and empties the rest of the group. With `--host`, the password is read once here and handed to each server on its ssh stdin. `install` only writes `.env`; `deploy` (or `docker compose up -d`) applies it. `--smtp-password` is refused.

By hand, uncomment the lines at the end of `.env` and run `docker compose up -d`, which recreates only `api`. Put the password in single quotes, `SMTP_PASSWORD='...'`, so Compose reads a `$` or `#` in it as itself; it cannot then contain a single quote. `api` refuses to start on a half-set group: `SMTP_HOST` without `NOTIFY_FROM`, `NOTIFY_TO`, or `PUBLIC_URL`, a user without a password, or any of those set without `SMTP_HOST`. `docker compose logs api` names every problem at once, never the password.

**Prove it** from Settings, Notifications, as an Admin: "Send test email" sends one now, straight to the relay, and shows the relay's reply or its reason for refusing. It goes to `NOTIFY_TO` (a Campus's own list gets its first real Incident email) and allows one a minute, since every press emails them all. "Send last month's report now" queues the monthly report, which goes to `NOTIFY_TO` within seconds, also one a minute. The same tab shows whether email and the monthly report are on, the quiet hours and how many emails they hold, the relay and the sender, each recipient list with its Campuses, and how the last email to each went. An SMTP outage delays Incident emails and reports rather than losing them: the server keeps retrying for 24 hours, and the failure shows on that tab. `deploy.sh info` prints the time zone, the relay, the recipients, how often reminders go, whether the monthly report is on, and the quiet hours, and the login with its password masked.

### Security

What the stack does by itself:

- nginx sends a Content-Security-Policy (scripts, styles, fetches, and the live stream only from the site's own origin; no framing), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and a Permissions-Policy, and does not name its version. The headers live in `frontend/security-headers.conf`. Add `Strict-Transport-Security` at the TLS proxy, not there.
- `api` and `web` run with a read-only root filesystem (only `/tmp` is writable), no Linux capabilities, and `no-new-privileges`; `db` keeps only the five capabilities its entrypoint needs to hand the data directory to the mysql user. A shell from `docker compose exec` in those containers cannot write outside `/tmp`, which is expected.
- Only `web` is published; the database and the backend are not reachable from outside the host.

What it needs from you:

- **Keep technicians out of the `docker` group.** The secrets are environment variables, so `docker inspect` shows them, and the group is root on the host anyway. Give each technician a User on Settings, Users: an Admin if they manage Campuses and Devices, a Viewer otherwise. The Admin token is for scripts.
- **Production boards post over HTTPS and check the certificate** (ADR 0001, 2026-10-06), at `https://YOUR_DOMAIN`, the same name the dashboard is served at. The boards trust Let's Encrypt's roots and the name, nothing about this server's key, so renewals and key changes never need a reflash. Before flashing day:
  - [ ] The server has a Let's Encrypt certificate for `YOUR_DOMAIN` ([step 6](#6-tls)); `sudo certbot renew --dry-run` passes. If the name is not reachable from the internet, use a DNS challenge.
  - [ ] The boards have an SSID and VLAN of their own with client isolation, whose DNS resolves `YOUR_DOMAIN` to the server, and which reaches only the server on TCP 443 and that DNS resolver. The boards take the time from the server, so no time server is needed. If the SSID is open (Devices admitted by MAC allowlist), it must be that same VLAN: MACs are easy to copy.
  - [ ] From a machine on that VLAN: `nslookup YOUR_DOMAIN` gives the server's address, `curl -i https://YOUR_DOMAIN/api/health` answers 200, `openssl s_client -connect YOUR_DOMAIN:443 -servername YOUR_DOMAIN -verify_return_error </dev/null 2>&1 | grep -E 'Verify return code|i:'` shows `Verify return code: 0 (ok)`, and nothing else answers.
  - What it buys: the token is encrypted, and goes only to a server with a valid certificate for the name, so a wrong DNS answer or a rogue access point fails the handshake instead of collecting the token. What it needs: the time, which the board reads from the server's `Date` header; until it has it, it sends nothing.
- **Run `arduino\bench.py` with `--server https://YOUR_DOMAIN`** once TLS is in front: it sends the Admin token with every registration, and it refuses to follow the proxy's redirect from `http://`.
- Run every upgrade through `deploy.sh deploy` or with `docker compose build --pull` first, so the base images pick up their security patches.

## Manual install (without Docker)

The fallback for a server that cannot run Docker. A single Ubuntu server runs everything: nginx serves the built frontend and proxies `/api/` to the backend, PM2 keeps the backend running as one process, and MySQL holds the data. Replace `/path/to/frontend/dist` with wherever you copy the frontend build.

### 1. Server packages

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx mysql-server certbot python3-certbot-nginx git
sudo npm install -g pm2
```

### 2. MySQL

```bash
sudo mysql_secure_installation
sudo mysql -u root -p
```

```sql
CREATE DATABASE temperature_alarms;
CREATE USER 'tempuser'@'localhost' IDENTIFIED BY 'choose-a-strong-password';
GRANT ALL PRIVILEGES ON temperature_alarms.* TO 'tempuser'@'localhost';
FLUSH PRIVILEGES;
```

The backend creates and upgrades the schema itself: every start runs its migration runner, which applies whatever has not run yet and records it in `schema_migrations`. A fresh database needs nothing beyond the `CREATE DATABASE` above.

### 3. Clone and build

```bash
sudo mkdir -p /var/www/temperature-alarms
sudo chown -R $USER:$USER /var/www/temperature-alarms
git clone <repo-url> /var/www/temperature-alarms
cd /var/www/temperature-alarms
npm run install:all
```

#### Backend

```bash
cd backend
cp .env.example .env
nano .env
npm run build
```

The backend refuses to start until these are set, naming whatever is missing:

| Variable | Value |
| --- | --- |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME` | The MySQL user and database from step 2 (`DB_HOST` and `DB_PORT` default to `localhost:3306`) |
| `ADMIN_TOKEN`, `DEVICE_TOKEN` | The two shared secrets, as in the Compose [setup](#setup) table. `DEVICE_TOKEN_PREVIOUS`, set only during a [rotation](#rotating-the-device-token), is the old Device token still accepted; set it to the old value, put the new one in `DEVICE_TOKEN`, `pm2 restart`, and clear it once every board reports with the new one |
| `SMTP_HOST` and the rest | Optional [email notifications](#email-notifications), listed commented at the end of `backend/.env.example`; off while `SMTP_HOST` is unset |

`CORS_ORIGIN` can stay unset: through the nginx below the dashboard and the API share one origin, which the backend always accepts. Set it only if the dashboard is served from somewhere else. Leave `REPORT_INTERVAL_SECONDS` at 30 unless the firmware interval changes with it. Every other setting has a default that `.env.example` shows.

#### Frontend

```bash
cd ../frontend
cp .env.example .env.production
nano .env.production   # VITE_API_URL=https://YOUR_DOMAIN
npm run build          # output lands in frontend/dist
sudo mkdir -p /path/to/frontend/dist
sudo cp -r dist/* /path/to/frontend/dist/
```

### 4. PM2

The backend must run as exactly one process (see ADR 0001). `backend/ecosystem.config.js` is already set to a single fork-mode instance; do not raise `instances`. It also gives a stop 10 seconds, as Docker does, so `pm2 restart` lets the backend finish what it is doing (`backend/src/shutdown.ts`).

```bash
cd /var/www/temperature-alarms/backend
pm2 start ecosystem.config.js
pm2 save
pm2 startup     # run the command it prints
```

Useful commands:

```bash
pm2 logs temperature-api
pm2 restart temperature-api
pm2 monit
```

The retention job runs here exactly as in the stack: once a day and once at every start, logging a `retention:` line.

### 5. nginx

Start on plain HTTP, the shape certbot needs in step 6. The site itself goes in a snippet that the HTTP server includes now and the HTTPS server includes after step 6. Create `/etc/nginx/snippets/temperature-alarms.conf`:

```nginx
root /path/to/frontend/dist;
index index.html;

# Backend API, including the SSE stream
location /api/ {
    proxy_pass http://localhost:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Required for Server-Sent Events: no buffering, long read timeout
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 86400s;
}

# React Router: every unknown path serves index.html
location / {
    try_files $uri $uri/ /index.html;
}

# Hashed build assets can be cached forever
location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

Then `/etc/nginx/sites-available/YOUR_DOMAIN`. `default_server` makes it answer a Device flashed with the server's IP address as well as its name:

```nginx
server {
    listen 80 default_server;
    server_name YOUR_DOMAIN;
    include snippets/temperature-alarms.conf;
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/YOUR_DOMAIN /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

The site is now on `http://YOUR_DOMAIN`.

### 6. TLS

Get the certificate without letting certbot edit the site, since its redirect would also catch the Devices' plain-HTTP Readings, which cannot follow one:

```bash
sudo certbot certonly --nginx -d YOUR_DOMAIN --deploy-hook "systemctl reload nginx"
sudo certbot renew --dry-run
```

Then replace `/etc/nginx/sites-available/YOUR_DOMAIN` with an HTTPS server for the site and an HTTP server that passes Readings through and sends everything else to HTTPS:

```nginx
# Plain HTTP: Devices keep posting Readings, everything else moves to HTTPS.
server {
    listen 80 default_server;
    server_name YOUR_DOMAIN;

    location = /api/readings {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        return 301 https://YOUR_DOMAIN$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name YOUR_DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem;

    include snippets/temperature-alarms.conf;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Certbot installs a systemd timer that renews the certificate before it expires, and the deploy hook reloads nginx so the new one is served; `systemctl list-timers certbot.timer` shows the next run, and the dry run above proves the renewal works. A renewal changes nothing for the boards: one with an `https://` server URL checks the certificate against Let's Encrypt's roots and the hostname, not against this server's key, so a new key or a rebuilt server is fine too (README, Transport for production boards). Keep `ssl_certificate` on `fullchain.pem`: the boards need the intermediate the server sends with it. A Device with `http://` keeps posting through the HTTP server above.

### 7. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

### Updating

```bash
cd /var/www/temperature-alarms
git pull
npm run install:all
npm run build:all
sudo cp -r frontend/dist/* /path/to/frontend/dist/
pm2 restart temperature-api
```

### Checks

```bash
curl https://YOUR_DOMAIN/api/health
curl -N https://YOUR_DOMAIN/api/dashboard/stream   # should stay open and print events
pm2 logs temperature-api
sudo tail -f /var/log/nginx/error.log
```

Then walk the same path as the Compose [first run](#first-run), with `https://YOUR_DOMAIN` in place of `http://localhost` and the virtual Device run from `backend/` on the server: `node scripts/mock-device.mjs --hostname ESP_A1B2C3 --token "$DEVICE_TOKEN"`.

### Database backups

```bash
sudo tee /usr/local/bin/backup-temperature-db.sh >/dev/null <<'EOS'
#!/bin/bash
DIR=/var/backups/temperature-alarms
mkdir -p "$DIR"
F="$DIR/backup_$(date +%Y%m%d_%H%M%S).sql.gz"
mysqldump --defaults-extra-file=/root/.my.cnf temperature_alarms | gzip > "$F"
# Tells Settings, System when.
mysql --defaults-extra-file=/root/.my.cnf temperature_alarms -e "REPLACE INTO last_backup (id, finished_at, file) VALUES (1, UTC_TIMESTAMP(), '$(basename "$F")')"
find "$DIR" -name 'backup_*.sql.gz' -mtime +7 -delete
EOS
sudo chmod +x /usr/local/bin/backup-temperature-db.sh
# crontab -e:  0 2 * * * /usr/local/bin/backup-temperature-db.sh
```

Put the database credentials in `/root/.my.cnf` (mode 600) rather than in the script.
