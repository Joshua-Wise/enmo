---
status: accepted
---

# Two shared secrets instead of user accounts

The site is public on the internet and had no authentication at all: anyone could delete Devices, wipe history, or post fake Readings. District SSO was the obvious "proper" answer but is a project of its own for a tool with one admin. We decided on two environment-variable secrets: an **admin token** required on every mutating request (entered once in the Settings page), and a separate **device token** that firmware sends on every `/api/readings`. Viewing the dashboard and history stays unauthenticated by design. Separate tokens mean a leaked admin token cannot forge Readings and a board pulled off a wall cannot wipe history.

## Consequences

- Rotating the device token means reflashing every board. Keep it in one firmware config header. Since 2026-10-06 the backend accepts the previous token during a rotation, so the reflash is a rolling job, not an outage (update below), and it goes out over the air (ADR 0007).
- If real logins are ever needed, the admin-token middleware is the single seam to replace.
- A firmware flashed with an `https://` server URL sends the device token only to a server whose certificate chains to a Let's Encrypt root and names the server (since 2026-10-06; before, TLS ran without any check). Nothing about the server's own key is in the board, so no server-side change needs a reflash (ADR 0001, update 2026-10-06).

## Note (2026-10, production security review)

- The device token sits in plain text in every board's flash, and the ESP8266 has no flash encryption, so anyone holding a board can read it with `esptool read_flash`. It is one token for every board: a single lost board exposes the fleet's ability to post Readings (only for registered hostnames, at most 20 a minute each), though never to change Campuses or Devices.
- The backend accepts one device token at a time, so a rotation is a flag day: from the moment `DEVICE_TOKEN` changes, every board still on the old token is refused until it is reflashed. The README's "Secrets on the board" gives the procedure. Accepting a previous token during a rotation window, or per-Device tokens, would be a new decision. (Superseded by the update below.)

## Update 2026-10-06: a rotation window, and the transport

**Rotation window.** The owner chose a dual-token window over a flag day or per-Device tokens (`.scratch/prodtest/security-firmware.md`, D2). The backend takes an optional `DEVICE_TOKEN_PREVIOUS` beside `DEVICE_TOKEN`:

- A Reading with either is accepted. Both are compared every time, as SHA-256 digests in constant time, so neither the time taken nor a length difference says which one matched, or whether either did.
- The wrong-token limit counts only requests matching neither, so boards still on the previous token never lock out their campus's address.
- While the previous token is set, `api` remembers, per Device, which token its latest Reading carried, logs a Device on the previous token once an hour by hostname (never the token), and lists those Devices, and those not heard since it started, to the Admin token (`GET /api/devices/rotation`, and a line on the Settings page). The list is in memory, like the rate limits (ADR 0001); after a restart every Device is "not heard" until its next Reading.
- `api` refuses to start if the previous token equals the device token or the admin token.
- `deploy.sh rotate-device-token` (and `deploy.ps1`) starts a rotation: the current token becomes the previous one, a new one is generated, `api` restarts with both. `--finish` clears the previous token once the list is empty, and refuses otherwise unless forced behind a typed confirmation. One rotation at a time.

A lost board's token stays valid until `--finish`, so the window should be as short as the reflash allows. Per-Device tokens (a lost board exposes only itself) stay unbuilt: they need a per-board binary, schema, and Settings work, which one admin and an isolated device VLAN do not justify.

**Transport.** Production boards post HTTPS to `https://YOUR_DOMAIN`, checking its certificate against Let's Encrypt's roots (ADR 0001, update 2026-10-06), so the device token is no longer readable on the network. It is still readable from any board's flash, and the rotation window is the remedy for a leak.

## Update 2026-10-08: viewing is no longer open

Superseded in part by [ADR 0010](0010-sign-in-and-users.md): the owner put the whole site behind a username and password, so "viewing the dashboard and history stays unauthenticated by design" no longer holds, and the Admin token is no longer entered in Settings. The Admin token remains the machine credential for scripts and still authorises every change as a Bearer; the Device token and everything above about it are unchanged.
