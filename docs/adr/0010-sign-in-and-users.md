---
status: accepted
---

# Everyone signs in; Users are Admins or Viewers

ADR 0003 kept viewing open and guarded changes with one shared Admin token pasted into Settings. The owner decided on 2026-10-08 that the whole site sits behind a username and password instead: the Dashboard, Campuses, Incidents, History and Settings, and the API they read. This supersedes ADR 0003's "viewing stays unauthenticated"; its Device token, rotation window and transport are unchanged.

## Decision

- **Users** live in the database (migration 0021): a username unique ignoring case, a scrypt hash with its own salt (Node's `crypto`, no dependency), a role, a disabled flag, created and last-sign-in times. **Admin** changes things and manages users; **Viewer** only looks. No kiosk exception: a wall display signs in like anyone else.
- **First start**: with no users, `api` creates `admin` / `admin` and logs that it did. Signing in with it allows nothing but choosing a new password (8 characters or more).
- **Sessions** are server-side: the cookie (`ta_session`, `HttpOnly`, `SameSite=Strict`, `Path=/api`, `Secure` when the request came over HTTPS, as nginx's `X-Forwarded-Proto` says) holds a random id; the `sessions` table holds its SHA-256. A session ends after 12 hours unused and 7 days at most. Signing out, a disabled user, a new password set by an Admin, or a deleted user end it at once, and close the live streams it opened. An open stream counts as use (a sweep once a minute), so a wall display stays signed in until the 7 days are up.
- **Guards** (`auth.ts`): every route the pages read needs a session or the Admin token; every change, and the Admin's own reads, an Admin's session or the Admin token. Roles are read from the users table on every request, so a role change takes effect at once. `/api/readings` and the firmware check keep the Device token alone; `/api/health` stays open.
- **The Admin token stays** as the machine credential: as a Bearer it does whatever an Admin may, so `bench.py`, `deploy.sh`/`deploy.ps1`, `demo.mjs` and `e2e/walk.mjs` keep working. People no longer paste it anywhere.
- **Sign-in limit**: failures only, 30 per address and 10 per username (any address) per 15 minutes; past either, even the right password is refused, so a 429 never confirms a guess. Every failure says only "Wrong username or password", and an unknown or disabled user is checked against a decoy hash so the time taken says nothing.
- **Cross-site requests**: `SameSite=Strict` keeps another site's page from sending the cookie, and a change made with the cookie must be `application/json` (or `application/octet-stream`, the firmware upload), which no form can send and no other origin can send past the CORS preflight. Otherwise 415. Sign-in reads only a JSON body.
- **Keeping an Admin**: the last enabled Admin cannot be demoted, disabled or deleted, and no one deletes or disables themselves; checked with the Admins' rows locked. A locked-out owner runs `deploy.sh reset-admin-password` (or `deploy.ps1`): a typed password, never echoed or on a command line, for `admin` or `--user NAME`, which becomes an enabled Admin, created if missing.

## Consequences

- Acknowledgement stays free text, and only an Admin may give one.
- Nothing about passwords, hashes or session ids is logged; the first-start line names only the public default.
- Sessions are in the database and the limits in memory, like the other rate limits (ADR 0001): a restart keeps everyone signed in and forgets the failure counts.
