---
name: deploy
description: Deploy the Temperature Alarms stack to this machine or district servers by driving deploy/deploy.sh or deploy/deploy.ps1 non-interactively. Use when the operator asks to set up a new server, deploy, install, or upgrade it, back up or restore the database (once or nightly), check its status or logs, or stop or remove it.
---

# Deploy

`deploy/deploy.sh` (Linux, macOS, Git Bash) and `deploy/deploy.ps1` (Windows PowerShell 5.1 and 7) are one tool: same actions, same flags. `--help` on either is the flag reference, and `DEPLOYMENT.md` explains each action. You are the hands of an operator who cannot see your terminal, so every call is **non-interactive**: it carries `--yes`, and a prompt never waits on you.

## Secrets stay on the server

The Admin token, Device token, database passwords, and SMTP password live only in each server's `.env`. Keep them out of the conversation: show `info --yes`, which masks them, and leave `.env` unread. When the operator needs one in full (the Settings page, a board's `config.h`), give them the command to run in their own terminal on the server: `deploy/deploy.sh info --reveal`.

Never ask for the SMTP password in the chat, and never put it on a command line: the scripts refuse `--smtp-password`. When the relay needs a login, hand the operator the command to run in their own terminal, where it reads the password at a hidden prompt (the same command without `--yes`), or from stdin: `read -rs PW && printf '%s\n' "$PW" | deploy/deploy.sh install --reconfigure --yes --smtp-user USER …; unset PW`, or in PowerShell `[Net.NetworkCredential]::new('', (Read-Host -AsSecureString)).Password | .\deploy\deploy.ps1 install --reconfigure --yes --smtp-user USER …`. With `--host`, the password is read once on this machine and handed to each server on its ssh stdin.

## Steps

1. **Target.** Decide where it runs and which script:
   - This machine: `bash deploy/deploy.sh …`; on Windows without bash, `powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1 …`.
   - Servers: add `--host USER@SERVER` (repeatable) or `--servers deploy/servers.txt`. The script ssh's in, clones the repo into `~/temperature-alarms` if missing (`--dir` for an existing checkout), and runs `deploy.sh` there, so remote targets are Linux or macOS.

   Ask the operator only for what you cannot find: the server's `USER@HOST`, and on a first install the web port (default 80). For a server, prove ssh works unattended with `ssh -o BatchMode=yes USER@HOST true`; when it fails, ask the operator to set up key-based ssh, since you cannot answer a password prompt. Done when the command line is settled and ssh answers.

   A server that is new, or whose preflight says `docker is not installed`, needs `bootstrap` first (Linux only: Ubuntu, Debian, RHEL, Rocky, AlmaLinux, CentOS Stream, Fedora). It installs packages with sudo, so unattended it needs passwordless sudo: prove it with `ssh -o BatchMode=yes USER@HOST sudo -n true`, and when that fails, ask the operator to run the bootstrap line themselves in a terminal (sudo will ask them for the password there) or to grant passwordless sudo.

2. **Preflight.** Run `preflight --yes` with the same target flags (and `--web-port` on a first install). Done when every line reads `[ ok ]` or `[warn]`. A `[FAIL]` line is the answer: report it with its fix and stop; for `docker is not installed` on a Linux server, the fix is `bootstrap`.

3. **Act.** Map the request to one action; the first build takes minutes, so give it a 15-minute timeout. Run the script unpiped, so the exit status you read is the script's (a `| tail` reports `tail`'s); its output is already short apart from the build log.

   | The operator says | Run |
   | --- | --- |
   | set up this new server | `bootstrap --yes`, then `deploy --yes --web-port PORT`; on servers, one call does both: `deploy --bootstrap --yes --web-port PORT --host USER@HOST`. On this machine, the deploy needs a new login after bootstrap adds the docker group: run it under the new group with `sg docker -c 'deploy/deploy.sh deploy --yes --web-port PORT'`, and tell the operator to log out and back in before using docker themselves |
   | deploy, install | `deploy --yes --web-port PORT`, plus `--set KEY=VALUE` for any threshold they named |
   | upgrade, update | `deploy --yes --pull` (a remote deploy pulls by default) |
   | back up the database | `backup --yes` (it also records the backup for Settings, System; a warning there, with the backup kept, means the api predates that, and `deploy` fixes it) |
   | back up nightly | `schedule-backup --yes`, plus `--at HH:MM` and `--keep-days N` if they named them (02:00 and 7 by default); `unschedule-backup --yes` stops it. On Windows it prints a `schtasks` line instead: give it to the operator |
   | restore | `restore --file backups/NAME.sql.gz --yes --confirm PROJECT` |
   | status, logs | `status --yes`; `logs --yes --service api --tail 200` |
   | turn on email notifications, change the recipients | `install --reconfigure --yes --smtp-host RELAY --notify-from ADDR --notify-to LIST --public-url URL`, plus `--smtp-port` and `--smtp-secure starttls\|tls\|none` if they named them, then `deploy --yes` to apply. Each flag changes only its own setting, so `--notify-to LIST` alone changes the default recipients. A Campus's own recipients are set on Settings, Campuses, not here; `--set NOTIFY_TO_ALL=true` copies `NOTIFY_TO` on every Campus's email. With a login (`--smtp-user USER`), the operator runs it, as above. Ask for what is missing; DEPLOYMENT.md, "Email notifications", lists the questions for the district's mail admin. Then tell them to press "Send test email" on Settings, Notifications |
   | remind about long incidents, change or stop reminders | `install --reconfigure --yes --notify-remind-hours N` (hours, 1 to 168; `0` turns them off), then `deploy --yes`. Email must already be on. An Incident open and unacknowledged that long is emailed again every N hours until it closes or someone acknowledges it |
   | send a monthly report, or stop it | `install --reconfigure --yes --notify-monthly-report on` (or `off`), then `deploy --yes`. Email must already be on. On the 1st of each month the default recipients (`NOTIFY_TO`, never a Campus's own) get a report on the month just ended; Settings, Notifications, also has "Send last month's report now" |
   | hold warning emails overnight or at weekends, or stop holding them | `install --reconfigure --yes --notify-quiet-hours 18:00-07:00` (two 24-hour times; `off` stops it) and/or `--notify-quiet-weekends on` (or `off`), then `deploy --yes`. Email must already be on. Warnings wait until the quiet ends and go out together; critical, Offline, and Sensor fault still go at once. The times are read in `TZ`: if `info` says `UTC (TZ not set)`, ask which zone the district is in and add `--set TZ=America/Chicago` (an IANA name) |
   | set the server's time zone | `install --reconfigure --yes --set TZ=America/Chicago`, then `deploy --yes`. Quiet hours, the times in emails, and the monthly report's months follow it; empty is UTC |
   | turn email off | `install --reconfigure --yes --smtp-host off`, then `deploy --yes` |
   | stop, take it down | `stop --yes`; `uninstall --yes` |
   | wipe it | `uninstall --yes --wipe --confirm PROJECT` |

   `--confirm PROJECT` stands in for the operator typing the project name, so it is theirs to give: before a restore or a wipe, name the file or the data that will be replaced or deleted, and run it only after they say yes in the chat. The project names the database volume: it is Compose's default (the checkout's folder name), which the first install pins in `.env`. Pass `-p` only when the operator names a project; the first install pins it too, so later calls need no `-p`. The project for `--confirm` is the one `status` prints in its `Containers (PROJECT)` heading.

4. **Verify.** Finish with `status --yes` on the same target. Done when it prints `[ ok ] http://…/api/health -> {"status":"ok","database":"connected"}` and exits 0. Report the dashboard URL from `info --yes`; after a first install, add the `info --reveal` command for the tokens and the reminder that `DEVICE_TOKEN` goes into every board's `config.h`.
