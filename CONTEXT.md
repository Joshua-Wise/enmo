# Temperature Alarms

Live temperature and humidity monitoring for network closets across school campuses, fed by NodeMCU boards with DHT11 sensors (or the more accurate DHT22 or SHT31).

## Language

**Device**:
One NodeMCU board with a sensor (a DHT11, DHT22, or SHT31, chosen when its firmware is built), installed in a single Closet. Identified by its hostname (`ESP_` plus the last six hex digits of its MAC), which never changes: a replaced board is a new Device. Its Closet and Campus can be corrected without losing its Readings. From firmware 6 the board says which sensor it carries with every report, and the Device's History shows it, so its Readings are read with that sensor's accuracy in mind.
_Avoid_: Sensor, node, board, table

**Fallback network**:
The second WiFi network a board's firmware may name (`WIFI_SSID_2`), joined when the first cannot be: the board tries the two in turn and stays on whichever joined until it drops. From firmware 7 the board says which network it is on with every report. A Device on its fallback network shows a note on its card and Settings names the network, but it is not a Condition: no Incident, no Notification. Moving closets to a new network over the air goes through it: a build whose fallback is the new network, then one that makes it the first.
_Avoid_: Backup network, secondary SSID, failover

**Reading**:
One temperature and humidity sample sent by a Device at a single moment.
_Avoid_: Record, data point, temp data, row

**Report interval**:
How often a healthy Device sends a Reading. Currently 30 seconds.
_Avoid_: Poll rate, update rate, countdown

**Online / Offline**:
A Device is Online if its last report, a Reading or a Fault report, arrived within the last Report interval. It is Offline after three consecutive missed reports.
_Avoid_: Pinging, connected, alive

**Fault report**:
What a Device posts in place of a Reading when its sensor does not answer (firmware 5 and later): its hostname and `fault: "sensor"`, no values. It is a report, so the Device stays Online, but not a Reading: nothing is stored in Readings (docs/adr/0009).
_Avoid_: Error reading, null reading, failed reading

**Sensor fault**:
The Condition a Device is in after three Fault reports in a row: the board is online but its sensor is not answering. Critical, since the closet is unwatched. While it lasts, the last good Reading is not judged for Hot, Cold, Dry, or Mold risk. The next Reading clears it (docs/adr/0009).
_Avoid_: Sensor offline, broken sensor, bad data

**Campus**:
A school site. Has a display name and a short code (e.g. `CHS`). Every Device belongs to exactly one Campus.
_Avoid_: Location (the old `locations` table held campuses), site, school

**Closet**:
The room a Device is installed in, within a Campus. Named by its network role and number, e.g. `IDF 2` or `MDF`.
_Avoid_: Location, room, position

**IDF / MDF**:
Intermediate and Main Distribution Frame. The two kinds of Closet; parsed from the Closet name to tag cards.

**User**:
A person who signs in to the site with a username and password; nothing on the site or its API shows without signing in. Each is an Admin or a Viewer, and can be disabled. A fresh install has one, `admin` with the password `admin`, which must be changed at its first sign-in (docs/adr/0010).
_Avoid_: Account, login, member

**Admin**:
A User who may change things: Campuses, Devices, firmware, history, Acknowledgements, and other Users on Settings. There is always at least one enabled Admin.
_Avoid_: Administrator, superuser, owner

**Viewer**:
A User who may look at every page but change nothing; Settings shows them no change controls.
_Avoid_: Read-only user, guest

**Session**:
What a signed-in browser holds: it ends on Sign out, after 12 hours unused, after 7 days at most, or at once when its User is disabled, deleted, or given a new password by an Admin.
_Avoid_: Login, token (that is the Admin or Device token)

**Admin token**:
The single shared secret scripts use in place of signing in (the bench watcher, `deploy.sh`, the demo, the end-to-end walk): it may do whatever an Admin may. People sign in instead.

**Device token**:
The single shared secret every Device sends with each Reading.

**Device token rotation**:
Replacing the Device token without a dark fleet: for a while the server accepts the **previous Device token** as well as the new one, lists which Devices still report with the previous token (and which it has not heard since it started), and stops accepting the previous one when the rotation is finished. One at a time (docs/adr/0003).
_Avoid_: Key rollover, token refresh, re-keying

**New device**:
A board that reports with the Device token but is not yet added as a Device, waiting in Settings to be adopted: given a Campus and Closet, it becomes a Device. Its Readings are refused until then.
_Avoid_: Pending device, unknown device, orphan

**Firmware release**:
The one signed firmware build the server offers to Devices over the air, with its version and, while it is staged, the named Devices it is offered to first. It is released to all (widened) once every named Device has sent 10 clean Readings in a row on it. A Device installs it when its version is higher than the Device's own (docs/adr/0007).
_Avoid_: OTA image, update, push

**Hold**:
A staged Firmware release stopping itself because one of its named Devices went Offline or into Sensor fault after taking it, or reported that the update failed. A held release is offered to no Device until it is withdrawn or replaced by a higher version; it is emailed when Notifications are on (docs/adr/0007).
_Avoid_: Pause, freeze, rollback (nothing is rolled back: boards that installed it keep it)

**Condition**:
A named state a Device is in, computed on the server from its latest Reading and its reports against global thresholds set once in the backend configuration: Hot, Cold, Dry, Mold risk, Sensor fault, Offline. Each has a level (warning, critical, or moderate/high for Mold risk). A Device can be in several Conditions at once.
_Avoid_: Alert, alarm, risk, status

**Incident**:
A stretch of time a Device spent in one Condition at warning or worse, recorded by the server: when it started, each level change, when it ended (or that it is ongoing), and its peak Reading. It opens on the first Reading in the Condition and closes after two Readings in a row without it, ending at the first of them; Offline opens when the server would first report the Device Offline and closes on its next report; Sensor fault opens on the third Fault report in a row. Moderate Mold risk is a heads-up, never an Incident. Kept for the Retention window, like Readings (docs/adr/0006).
_Avoid_: Alert, alarm, event, outage

**Acknowledgement**:
A technician saying they are on an open Incident, with their name or a short note (free text, 1 to 60 characters) and when they said it. Given in the app by an Admin, from the Device card or the Incidents log; the first one stands, an ended Incident cannot be acknowledged, and it is never cleared, not by the level rising nor by the close. It shows on the card, in the log, and in every later Notification about that Incident, which still sends (docs/adr/0008). It stops Reminders.
_Avoid_: Claim, assign, ownership, ack

**Notification**:
An email the server sends through the district's SMTP relay when an Incident opens, gets worse (its level rises), or closes, to its Campus's recipients: the Campus's own list, set on Settings, or the default list (`NOTIFY_TO`) for a Campus without one; and, to the default list, when a Firmware release goes on Hold (its own email). A level falling back is not sent, Devices on the Bench never send one, and Incident changes close together go out as one email to each recipient list, worst first. Each is queued in the same transaction as the Incident change it reports, so a restart or an SMTP outage delays it rather than losing it. Off unless the backend configuration names a relay (docs/adr/0008).
_Avoid_: Alert, alarm (the old feature that was removed), page, message

**Reminder**:
A Notification that an Incident is still open and no one has acknowledged it, sent once it has been open a set number of hours (`NOTIFY_REMIND_HOURS`, the same for every Condition and level) and again every as many hours after, counted from the Incident's start, until it closes or is acknowledged. Off unless configured, and only while Notifications are on; Devices on the Bench never get one; no cap on how many (docs/adr/0008).
_Avoid_: Escalation, repeat alert, nag, follow-up

**Quiet hours**:
When warning Notifications wait instead of going out: a nightly window (`NOTIFY_QUIET_HOURS`, such as 18:00 to 07:00) and, if configured, the whole weekend (`NOTIFY_QUIET_WEEKENDS`), on the server's clock (`TZ`). Every warning waits, Mold risk high included, with its Reminders and its closing email; what waited goes out when they end, one email per recipient list. Critical Incidents, Offline, and Sensor fault never wait, and a warning that turns critical goes at once. Off unless configured; school holidays are not quiet hours (docs/adr/0008).
_Avoid_: Do not disturb, snooze, mute, maintenance window

**Monthly report**:
An email on the month just ended, sent to the default list (`NOTIFY_TO`), never a Campus's own, on the 1st of each month when configured (`NOTIFY_MONTHLY_REPORT`), or on request from Settings: its Incidents and time in each Condition, the hottest and most humid closets with their peaks, the closets that **ran warm** (more than half their Readings within 3 °F of their Hot warning, or above it), and each Device's Offline and Sensor fault time, every closet linked to its History. Evidence for facilities' HVAC work. Devices on the Bench are left out (docs/adr/0008).
_Avoid_: Digest, summary, newsletter, statement

**Bench**:
The holding Campus (shortcode `BENCH`) a Device is registered under between flashing and installation, whatever its bench verdict: a board that failed its check stays registered there too, and the inventory sheet's `TESTED` column says which passed. A Device on the Bench is expected to be Offline until it is moved to its real Campus and Closet.
_Avoid_: Staging, spare, inventory (that is the spreadsheet of boards, not a place)

**Operator**:
The person who runs the backend and its database: installs, upgrades, backs up. A role in the documentation, not in the product; their way back in when no Admin can sign in is `deploy.sh reset-admin-password`.
_Avoid_: Admin (that is a User's role), sysadmin, host

**Retention window**:
How long a Reading is kept before the backend deletes it, in a pass that runs once a day and whenever the backend starts. 90 days unless the configuration says otherwise (docs/adr/0004). Nothing is rolled up first; a Reading past the window is gone.
_Avoid_: Purge, cleanup, archive, expiry
