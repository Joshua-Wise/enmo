# Tests for deploy.ps1's input gates, the same cases as deploy.test.sh: pwsh deploy/deploy.test.ps1
# (or Windows PowerShell 5.1). Needs no Docker. Exits 1 on any failure.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'deploy.ps1'

# The validators, lifted out of deploy.ps1 so they run without its main.
$ast = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$null)
$wanted = 'Test-IPv4', 'Test-IPv6', 'Test-Address', 'Test-TrustProxy', 'Test-SshHost', 'Get-EnvValue', 'Get-WebPortSetting', 'Test-GatewayExposed'
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $wanted -contains $n.Name }, $true)) {
    . ([scriptblock]::Create($fn.Extent.Text))
}

$fails = 0
function Expect([bool]$Got, [bool]$Want, [string]$What) {
    if ($Got -ne $Want) { Write-Output "FAIL $What"; $script:fails++ }
}

foreach ($v in '', '10.0.0.5', '172.22.0.0/16', '10.0.0.5, 10.0.0.6', 'gateway', 'gateway,10.0.0.5', '2001:db8::/32', 'fd00::1', '::ffff:10.0.0.5') {
    Expect (Test-TrustProxy $v) $true "TRUST_PROXY '$v' refused"
}
foreach ($v in '0.0.0.0/0', '1.2.3.4/00', '0.0.0.0/000', '::/0', '::/00', '::/000', '10.0.0.5,::/00', '1.2.3.4/33', '::/129', '256.1.1.1', 'caddy',
    '1.2.3.4;', '*', '/*', ':', "10.0.0.5`n10.0.0.6", "10.0.0.5`nADMIN_TOKEN=x", "10.0.0.5`n") {
    Expect (Test-TrustProxy $v) $false "TRUST_PROXY '$v' accepted"
}

foreach ($v in 'admin@10.0.0.5', 'admin@server.district.org', 'server', 'deploy_user@fd00::1') {
    Expect (Test-SshHost $v) $true "host '$v' refused"
}
foreach ($v in '-oProxyCommand=id', '-oProxyCommand=touch /tmp/x', '-p2222', 'admin@server -oX', "a`nb", 'a;id', '$(id)', '') {
    Expect (Test-SshHost $v) $false "host '$v' accepted"
}

# TRUST_PROXY=gateway is only safe with web published on the loopback address (deploy.test.sh says why).
$O = @{ WebPort = '' }
$EnvPath = Join-Path ([System.IO.Path]::GetTempPath()) "deploy-test-$PID.env"
function Read-Lines([string]$Path) { if (Test-Path -LiteralPath $Path) { return Get-Content -LiteralPath $Path } else { return @() } }
function Exposed([string]$WebPort, [string]$TrustProxy) {
    Set-Content -LiteralPath $EnvPath -Value @("WEB_PORT=$WebPort", "TRUST_PROXY=$TrustProxy")
    return Test-GatewayExposed
}
try {
    Expect (Exposed '80' 'gateway') $true 'gateway on port 80 (all addresses) not flagged'
    Expect (Exposed '0.0.0.0:8080' '10.0.0.5, gateway') $true 'gateway on 0.0.0.0:8080 not flagged'
    Expect (Exposed '[::]:8080' 'gateway') $true 'gateway on [::]:8080 not flagged'
    Expect (Exposed '127.0.0.1:8080' 'gateway') $false 'gateway on 127.0.0.1:8080 flagged'
    Expect (Exposed '[::1]:8080' 'gateway') $false 'gateway on [::1]:8080 flagged'
    Expect (Exposed '80' '10.0.0.5') $false "a remote proxy's address on port 80 flagged"
    Expect (Exposed '80' '') $false 'empty TRUST_PROXY flagged'
}
finally { Remove-Item -LiteralPath $EnvPath -ErrorAction SilentlyContinue }

# --- Actions against a fake docker -------------------------------------------------------------
# Every function and top-level setting of deploy.ps1, in a scope of their own, with docker, the
# health check, and the backup replaced: the fake logs each docker call (and what is piped to db)
# and answers what the action asks. Nothing reaches a real daemon.
$work = Join-Path ([System.IO.Path]::GetTempPath()) "deploy-test-$PID"
New-Item -ItemType Directory -Path $work -Force | Out-Null
$fake = @{ Log = @(); DbStdin = @(); FwStdin = @(); UserStdin = @(); FwRc = 0; RotationOut = @(); RotationRc = 0; DbRc = 0; Volume = $false; RealBackup = $false; Built = @() }
$run = {
    param([string[]]$Arguments)
    $script:ast = $ast
    foreach ($statement in $ast.EndBlock.Statements) {
        # The paths come from the script's own location, which a script block has not; they are set below.
        if ($statement -is [System.Management.Automation.Language.AssignmentStatementAst]) { try { . ([scriptblock]::Create($statement.Extent.Text)) } catch { } }
    }
    foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
    $RepoDir = $work; $EnvPath = Join-Path $work '.env'; $ExamplePath = Join-Path $PSScriptRoot '..\.env.example'
    $BackupDir = Join-Path $work 'backups'; $UseColour = $false
    function Invoke-Dc {
        $line = "$args"; $fake.Log += $line
        $global:LASTEXITCODE = 0
        # What a build would bake into api's image (backend/Dockerfile).
        if ($line -like 'build*' -or $line -like 'up*--build*') { $fake.Built += @("APP_VERSION=$env:APP_VERSION") }
        # The dump is made in db and copied out: the copy lands as a small file.
        if ($line -like 'exec -T db sh -c*mysqldump*') { return }
        if ($line -like 'cp db:*') { Set-Content -LiteralPath $args[2] -Value '-- Dump completed'; return }
        if ($line -like 'exec -T api node dist/firmwareCli.js*') { $fake.FwStdin += @($input | ForEach-Object { "$_" }); $global:LASTEXITCODE = $fake.FwRc; return }
        if ($line -like 'exec -T api node dist/userCli.js*') { $fake.UserStdin += @($input | ForEach-Object { "$_" }); return }
        if ($line -like 'exec -T api node -e*') { $fake.RotationOut; $global:LASTEXITCODE = $fake.RotationRc; return }
        if ($line -like 'exec -T db sh -c*') { $fake.DbStdin += @($input | ForEach-Object { "$_" }); $global:LASTEXITCODE = $fake.DbRc; return }
    }
    function Invoke-DcStdin { $input | Invoke-Dc @args }
    function Test-Running { return $true }
    function Get-ProjectName { return 'ta-test' }
    function Test-Health { return $true }
    function Test-DbVolume { return $fake.Volume }
    function Invoke-Preflight { return $true }
    function Invoke-MaybePull { }
    if (-not $fake.RealBackup) { function Invoke-Backup { $fake.Log += 'backup'; $script:LastBackup = 'backups\ta-test.sql.gz' } }
    function Write-Host { $fake.Out += @("$args") }
    # Stdin is [Console]::In, which Invoke-FakeStdin points at a string; never the test's own console.
    function Test-StdinRedirected { return $true }
    $fake.Out = @()
    try { Read-Args $Arguments; $O.Yes = $true; Set-LegacyRootEnv; Invoke-Action $O.Action; return $true }
    catch { $fake.Out += "Error: $($_.Exception.Message)"; return $false }
}
function Invoke-Fake([string[]]$Arguments) {
    $fake.Log = @(); $fake.DbStdin = @()
    return (& $run $Arguments)
}
$envFile = Join-Path $work '.env'
function EnvOf([string]$Key) {
    $value = ''
    foreach ($line in (Read-Lines $envFile)) { if ($line.StartsWith("$Key=")) { $value = $line.Substring($Key.Length + 1) } }
    return $value
}
function SetEnvLine([string]$Key, [string]$Value) {
    Set-Content -LiteralPath $envFile -Value @(Read-Lines $envFile | ForEach-Object { if ($_.StartsWith("$Key=")) { "$Key=$Value" } else { $_ } })
}
function Hex64([string]$Value) { return $Value -cmatch '\A[0-9a-f]{64}\z' }
$consoleIn = [Console]::In
function Invoke-FakeStdin([string]$Stdin, [string[]]$Arguments) {
    [Console]::SetIn((New-Object IO.StringReader $Stdin))
    try { return (Invoke-Fake $Arguments) } finally { [Console]::SetIn($consoleIn) }
}
function Get-EnvText { return ((Read-Lines $envFile) -join "`n") }
$said = { ($fake.Out -join "`n") }
$secretNames = 'ADMIN_TOKEN', 'DEVICE_TOKEN', 'DB_PASSWORD', 'DB_ROOT_PASSWORD'

try {
    # install: four secrets from the CSPRNG, all different; info masks every one of them.
    Expect (Invoke-Fake @('install', '--web-port', '18098')) $true "install failed: $(& $said)"
    foreach ($k in $secretNames) { Expect (Hex64 (EnvOf $k)) $true "install: $k is not 64 hex characters" }
    Expect (@($secretNames | ForEach-Object { EnvOf $_ } | Sort-Object -Unique).Count -eq 4) $true 'install: the four secrets are not all different'
    Expect (Invoke-Fake @('info')) $true 'info failed'
    foreach ($k in $secretNames) { Expect ((& $said).Contains((EnvOf $k))) $false "info: $k printed in full without --reveal" }
    Expect ((& $said) -match 'DB root') $true 'info: no DB root line'

    # Email notifications (docs/adr/0008); deploy.test.sh says why each case matters.
    $notifyNames = 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'NOTIFY_FROM', 'NOTIFY_TO', 'PUBLIC_URL', 'NOTIFY_COALESCE_SECONDS', 'NOTIFY_REMIND_HOURS', 'NOTIFY_TO_ALL', 'NOTIFY_MONTHLY_REPORT', 'NOTIFY_QUIET_HOURS', 'NOTIFY_QUIET_WEEKENDS'
    foreach ($k in $notifyNames) { Expect ((EnvOf $k) -eq '') $true "install: $k has a value without --smtp-host" }
    Expect ((& $said) -match 'Email +off') $true 'info: notifications not shown as off'

    # NOTIFY_TO_ALL (recipients per Campus) is a tunable: --set takes true, false, or empty, and nothing else.
    $before = Get-EnvText
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--set', 'NOTIFY_TO_ALL=yes')) $false '--set NOTIFY_TO_ALL=yes: succeeded'
    Expect ((Get-EnvText) -eq $before) $true '--set NOTIFY_TO_ALL=yes: .env changed'
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--set', 'NOTIFY_TO_ALL=true')) $true "--set NOTIFY_TO_ALL=true failed: $(& $said)"
    Expect ((EnvOf 'NOTIFY_TO_ALL') -eq 'true') $true '--set NOTIFY_TO_ALL=true: not written'
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--set', 'NOTIFY_TO_ALL=')) $true "--set NOTIFY_TO_ALL= failed: $(& $said)"
    Expect ((EnvOf 'NOTIFY_TO_ALL') -eq '') $true '--set NOTIFY_TO_ALL=: not emptied'

    # TZ, the api's zone (quiet hours, email times, the monthly report's months): a tunable, UTC unless set.
    Expect (Invoke-Fake @('info')) $true 'info without TZ failed'
    Expect ((& $said) -match 'Time zone +UTC \(TZ not set\)') $true 'info: TZ not shown as unset'
    $before = Get-EnvText
    foreach ($bad in @('America/Chicago;id', '../etc/passwd', 'Central Time')) {
        Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--set', "TZ=$bad")) $false "--set TZ=${bad}: succeeded"
    }
    Expect ((Get-EnvText) -eq $before) $true '--set TZ refused: .env changed'
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--set', 'TZ=America/Chicago')) $true "--set TZ=America/Chicago failed: $(& $said)"
    Expect ((EnvOf 'TZ') -ceq 'America/Chicago') $true '--set TZ=America/Chicago: not written'
    Expect (Invoke-Fake @('info')) $true 'info with TZ failed'
    Expect ((& $said) -match 'Time zone +America/Chicago') $true 'info: TZ not shown'
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--set', 'TZ=')) $true "--set TZ= failed: $(& $said)"
    Expect ((EnvOf 'TZ') -eq '') $true '--set TZ=: not emptied'

    $before = Get-EnvText
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--smtp-host', 'relay.example.org', '--smtp-password', 'hunter2')) $false '--smtp-password: succeeded'
    Expect ((& $said) -match 'never taken on the command line') $true '--smtp-password: no explanation'
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--smtp-host', 'relay.example.org', '--notify-from', 'alarms@example.org', '--notify-to', 'techs@example.org')) $false 'no --public-url: succeeded'
    Expect ((& $said) -match '--public-url is required') $true 'no --public-url: no explanation'
    $okFlags = @('--smtp-host', 'relay.example.org', '--notify-from', 'alarms@example.org', '--notify-to', 'techs@example.org', '--public-url', 'https://alarms.example.org')
    foreach ($bad in @(@('--smtp-port', '70000'), @('--smtp-secure', 'ssl'), @('--notify-to', 'not-an-address'), @('--notify-from', 'a@b.c,d@e.f'), @('--public-url', 'ftp://alarms.example.org'), @('--smtp-host', 'relay.example.org;id'), @('--notify-to', "a@example.org`nADMIN_TOKEN=x"), @('--notify-remind-hours', '169'), @('--notify-remind-hours', '1.5'), @('--notify-remind-hours', '-4'), @('--notify-monthly-report', 'yes'), @('--notify-monthly-report', 'true'), @('--notify-quiet-hours', '18:00'), @('--notify-quiet-hours', '18:00-18:00'), @('--notify-quiet-hours', '6pm-7am'), @('--notify-quiet-hours', '24:00-07:00'), @('--notify-quiet-weekends', 'yes'), @('--notify-quiet-weekends', 'true'))) {
        Expect (Invoke-FakeStdin '' (@('install', '--reconfigure') + $okFlags + $bad)) $false "$($bad -join ' '): succeeded"
        Expect ((& $said).Contains($bad[0])) $true "$($bad -join ' '): the flag is not named"
    }
    Expect (Invoke-FakeStdin "it's`n" (@('install', '--reconfigure') + $okFlags + @('--smtp-user', 'svc'))) $false 'a password with a single quote: succeeded'
    Expect ((Get-EnvText) -eq $before) $true 'refused settings: .env changed'

    # On, with a login: the password is the first line of stdin, written single-quoted, never printed.
    $pw = 'p@ss $HOME #1 \t\\x "q"'
    Expect (Invoke-FakeStdin "$pw`r`n" (@('install', '--reconfigure') + $okFlags + @('--smtp-port', '465', '--smtp-secure', 'tls', '--smtp-user', 'DISTRICT\svc-alarms', '--notify-to', 'techs@example.org, noc@example.org', '--notify-remind-hours', '4', '--notify-monthly-report', 'on', '--notify-quiet-hours', '18:00-07:00', '--notify-quiet-weekends', 'on'))) $true "notify on failed: $(& $said)"
    Expect ((EnvOf 'SMTP_HOST') -eq 'relay.example.org') $true 'notify on: SMTP_HOST'
    Expect ((EnvOf 'SMTP_PORT') -eq '465' -and (EnvOf 'SMTP_SECURE') -eq 'tls') $true 'notify on: port or security not written'
    Expect ((EnvOf 'SMTP_USER') -eq 'DISTRICT\svc-alarms') $true 'notify on: SMTP_USER'
    Expect ((EnvOf 'SMTP_PASSWORD') -ceq "'$pw'") $true "notify on: SMTP_PASSWORD is not the stdin line, single-quoted: $(EnvOf 'SMTP_PASSWORD')"
    Expect ((EnvOf 'NOTIFY_TO') -eq 'techs@example.org,noc@example.org') $true 'notify on: NOTIFY_TO'
    Expect ((EnvOf 'PUBLIC_URL') -eq 'https://alarms.example.org') $true 'notify on: PUBLIC_URL'
    Expect ((EnvOf 'NOTIFY_REMIND_HOURS') -eq '4') $true 'notify on: NOTIFY_REMIND_HOURS'
    Expect ((EnvOf 'NOTIFY_MONTHLY_REPORT') -ceq 'true') $true "notify on: NOTIFY_MONTHLY_REPORT is '$(EnvOf 'NOTIFY_MONTHLY_REPORT')'"
    Expect ((EnvOf 'NOTIFY_QUIET_HOURS') -ceq '18:00-07:00' -and (EnvOf 'NOTIFY_QUIET_WEEKENDS') -ceq 'true') $true "notify on: quiet hours are '$(EnvOf 'NOTIFY_QUIET_HOURS')', weekends '$(EnvOf 'NOTIFY_QUIET_WEEKENDS')'"
    Expect ((& $said).Contains('p@ss')) $false 'notify on: the password is in the output'
    Expect (($fake.Log -join "`n").Contains('p@ss')) $false 'notify on: the password is on a docker command line'
    Expect (Invoke-Fake @('info')) $true 'info with notify failed'
    Expect ((& $said).Contains('relay.example.org:465 (tls)')) $true 'info: no relay line'
    Expect ((& $said).Contains('reminders every 4 h')) $true 'info: reminders not shown'
    Expect ((& $said).Contains('monthly report on')) $true 'info: the monthly report not shown'
    Expect ((& $said).Contains('quiet hours 18:00-07:00 and weekends')) $true 'info: quiet hours not shown'
    Expect ((& $said).Contains('DISTRICT\svc-alarms / ********')) $true 'info: no masked login line'
    Expect ((& $said).Contains('p@ss')) $false 'info: the SMTP password (or its start) printed without --reveal'
    Expect (Invoke-Fake @('info', '--reveal')) $true 'info --reveal failed'
    Expect ((& $said).Contains($pw)) $true 'info --reveal: the SMTP password not shown'

    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--notify-to', 'oncall@example.org')) $true "notify-to alone failed: $(& $said)"
    Expect ((EnvOf 'NOTIFY_TO') -eq 'oncall@example.org' -and (EnvOf 'SMTP_HOST') -eq 'relay.example.org') $true 'notify-to alone: not applied on its own'
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--notify-remind-hours', '0')) $true "notify-remind-hours alone failed: $(& $said)"
    Expect ((EnvOf 'NOTIFY_REMIND_HOURS') -eq '0' -and (EnvOf 'NOTIFY_TO') -eq 'oncall@example.org') $true 'notify-remind-hours alone: not applied on its own'
    Expect (Invoke-Fake @('info')) $true 'info with reminders off failed'
    Expect ((& $said).Contains('reminders off')) $true 'info: reminders not shown as off'
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--notify-monthly-report', 'off')) $true "notify-monthly-report alone failed: $(& $said)"
    Expect ((EnvOf 'NOTIFY_MONTHLY_REPORT') -ceq 'false' -and (EnvOf 'NOTIFY_REMIND_HOURS') -eq '0') $true 'notify-monthly-report alone: not applied on its own'
    Expect (Invoke-Fake @('info')) $true 'info with the monthly report off failed'
    Expect ((& $said).Contains('monthly report off')) $true 'info: the monthly report not shown as off'
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--notify-quiet-weekends', 'off')) $true "notify-quiet-weekends alone failed: $(& $said)"
    Expect ((EnvOf 'NOTIFY_QUIET_WEEKENDS') -ceq 'false' -and (EnvOf 'NOTIFY_QUIET_HOURS') -ceq '18:00-07:00') $true 'notify-quiet-weekends alone: not applied on its own'
    Expect (Invoke-Fake @('info')) $true 'info with quiet weekends off failed'
    Expect ((& $said) -match 'quiet hours 18:00-07:00(\r?\n|$)') $true 'info: quiet hours without weekends not shown'
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--notify-quiet-hours', 'off')) $true "notify-quiet-hours off failed: $(& $said)"
    Expect ((EnvOf 'NOTIFY_QUIET_HOURS') -eq '' -and (EnvOf 'NOTIFY_QUIET_WEEKENDS') -ceq 'false') $true 'notify-quiet-hours off: not applied on its own'
    Expect (Invoke-Fake @('info')) $true 'info with quiet hours off failed'
    Expect ((& $said).Contains('quiet hours off')) $true 'info: quiet hours not shown as off'
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--smtp-user', 'other-svc')) $true "smtp-user, empty stdin failed: $(& $said)"
    Expect ((EnvOf 'SMTP_USER') -eq 'other-svc' -and (EnvOf 'SMTP_PASSWORD') -ceq "'$pw'") $true 'smtp-user, empty stdin: password not kept'
    Expect (Invoke-FakeStdin '' @('install', '--smtp-host', 'off')) $true 'off without --reconfigure failed'
    Expect ((EnvOf 'SMTP_HOST') -eq 'relay.example.org') $true 'off without --reconfigure: .env changed'

    # Remote: the password reaches the server on ssh's stdin, never in its arguments.
    $fake.SshArgs = @(); $fake.SshStdin = @()
    $remote = {
        param([string[]]$Arguments, [string]$Password)
        foreach ($statement in $ast.EndBlock.Statements) {
            if ($statement -is [System.Management.Automation.Language.AssignmentStatementAst]) { try { . ([scriptblock]::Create($statement.Extent.Text)) } catch { } }
        }
        foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
        function ssh { $fake.SshArgs += "$args"; $fake.SshStdin += @($input | ForEach-Object { "$_" }); $global:LASTEXITCODE = 0 }
        Read-Args $Arguments
        $O.Yes = $true
        $script:SmtpPw = $Password
        Invoke-RemoteHost 'admin@a.example.org'
    }
    & $remote @('install', '--reconfigure', '--smtp-user', 'svc') $pw
    Expect ($fake.SshStdin -ccontains $pw) $true 'remote smtp-user: the password did not reach the server on stdin'
    Expect (($fake.SshArgs -join "`n").Contains('p@ss')) $false 'remote smtp-user: the password is in ssh''s arguments'

    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--smtp-host', 'off')) $true "off failed: $(& $said)"
    foreach ($k in $notifyNames) { Expect ((EnvOf $k) -eq '') $true "off: $k still set" }
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--smtp-host', 'off', '--notify-to', 'a@example.org')) $false 'off with another flag: succeeded'
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--smtp-host', 'off', '--notify-remind-hours', '4')) $false 'off with --notify-remind-hours: succeeded'
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--notify-remind-hours', '4')) $false '--notify-remind-hours with email off: succeeded'
    Expect ((& $said) -match 'email notifications are off here') $true '--notify-remind-hours with email off: no explanation'
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--smtp-host', 'off', '--notify-monthly-report', 'on')) $false 'off with --notify-monthly-report: succeeded'
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--notify-monthly-report', 'on')) $false '--notify-monthly-report with email off: succeeded'
    Expect ((& $said) -match 'email notifications are off here') $true '--notify-monthly-report with email off: no explanation'
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--smtp-host', 'off', '--notify-quiet-hours', '18:00-07:00')) $false 'off with --notify-quiet-hours: succeeded'
    Expect (Invoke-FakeStdin '' @('install', '--reconfigure', '--notify-quiet-weekends', 'on')) $false '--notify-quiet-weekends with email off: succeeded'
    Expect ((& $said) -match 'email notifications are off here') $true '--notify-quiet-weekends with email off: no explanation'

    # rotate-device-token
    $old = EnvOf 'DEVICE_TOKEN'
    Expect (Invoke-Fake @('rotate-device-token')) $true "rotate failed: $(& $said)"
    $new = EnvOf 'DEVICE_TOKEN'
    Expect ((EnvOf 'DEVICE_TOKEN_PREVIOUS') -eq $old) $true 'rotate: DEVICE_TOKEN_PREVIOUS is not the old token'
    Expect ((Hex64 $new) -and $new -ne $old) $true 'rotate: DEVICE_TOKEN is not a new 64-hex token'
    Expect (@($fake.Log | Where-Object { $_ -like 'up -d*' }).Count -gt 0) $true 'rotate: the stack was not recreated'
    Expect ((& $said) -match '#define DEVICE_TOKEN "') $true 'rotate: no config.h line'
    Expect ((& $said).Contains($new)) $false 'rotate: the new token printed without --reveal'
    Expect ((& $said) -match 'rotate-device-token --finish') $true 'rotate: the steps do not say how to finish'
    Expect (($fake.Log -join "`n").Contains($old) -or ($fake.Log -join "`n").Contains($new)) $false 'rotate: a token is on a docker command line'

    Expect (Invoke-Fake @('rotate-device-token', '--reveal')) $false 'rotate twice: succeeded'
    Expect ((EnvOf 'DEVICE_TOKEN') -eq $new -and (EnvOf 'DEVICE_TOKEN_PREVIOUS') -eq $old) $true 'rotate twice: .env changed'
    Expect ((& $said) -match 'already under way') $true 'rotate twice: no explanation'

    # --finish refuses while api lists Devices on the previous token, naming them.
    $fake.RotationOut = @('previous ESP_00000A', 'unheard ESP_00000C'); $fake.RotationRc = 3
    Expect (Invoke-Fake @('rotate-device-token', '--finish')) $false 'finish with Devices left: succeeded'
    Expect ((EnvOf 'DEVICE_TOKEN_PREVIOUS') -eq $old) $true 'finish with Devices left: the previous token was cleared'
    Expect ((& $said) -match 'ESP_00000A' -and (& $said) -match 'ESP_00000C') $true 'finish with Devices left: not named'
    Expect (@($fake.Log | Where-Object { $_ -like 'up -d*' }).Count -eq 0) $true 'finish with Devices left: the stack was recreated'
    Expect (Invoke-Fake @('rotate-device-token', '--finish', '--force')) $false 'finish --force without --confirm: succeeded'
    Expect ((EnvOf 'DEVICE_TOKEN_PREVIOUS') -eq $old) $true 'finish --force without --confirm: cleared'
    Expect (Invoke-Fake @('rotate-device-token', '--finish', '--force', '--confirm', 'ta-test')) $true "finish --force --confirm failed: $(& $said)"
    Expect ((EnvOf 'DEVICE_TOKEN_PREVIOUS') -eq '') $true 'finish --force --confirm: not cleared'

    SetEnvLine 'DEVICE_TOKEN_PREVIOUS' $old
    $fake.RotationOut = @(); $fake.RotationRc = 0
    Expect (Invoke-Fake @('rotate-device-token', '--finish')) $true "finish failed: $(& $said)"
    Expect ((EnvOf 'DEVICE_TOKEN_PREVIOUS') -eq '') $true 'finish: DEVICE_TOKEN_PREVIOUS not cleared'
    Expect ((EnvOf 'DEVICE_TOKEN') -eq $new) $true 'finish: DEVICE_TOKEN changed'
    Expect (@($fake.Log | Where-Object { $_ -like 'up -d*' }).Count -gt 0) $true 'finish: the stack was not recreated'
    Expect (($fake.Log -join "`n").Contains((EnvOf 'ADMIN_TOKEN'))) $false 'finish: the Admin token is on a docker command line'
    SetEnvLine 'DEVICE_TOKEN_PREVIOUS' $old
    $fake.RotationOut = @('GET /api/devices/rotation answered 500'); $fake.RotationRc = 1
    Expect (Invoke-Fake @('rotate-device-token', '--finish')) $false 'finish with api failing: succeeded'
    Expect ((EnvOf 'DEVICE_TOKEN_PREVIOUS') -eq $old) $true 'finish with api failing: cleared'
    SetEnvLine 'DEVICE_TOKEN_PREVIOUS' ''

    # An install from before DB_ROOT_PASSWORD (its volume made by master).
    Set-Content -LiteralPath $envFile -Value @(Read-Lines $envFile | Where-Object { -not $_.StartsWith('DB_ROOT_PASSWORD=') })
    $fake.Volume = $true
    Expect (Invoke-Fake @('install')) $true 'legacy install failed'
    Expect ((EnvOf 'DB_ROOT_PASSWORD') -eq '') $true 'legacy install: generated a DB_ROOT_PASSWORD the volume does not have'
    Expect (Invoke-Fake @('info')) $true 'legacy info failed'
    Expect ((& $said) -match 'still shares DB_PASSWORD') $true 'legacy info: no warning'
    Expect (Invoke-Fake @('deploy', '--no-pull')) $false 'legacy deploy without --confirm: succeeded'
    Expect ((& $said) -match "DROP USER IF EXISTS 'root'@'%'") $true 'legacy deploy: no explanation'
    Expect ((EnvOf 'DB_ROOT_PASSWORD') -eq '') $true 'legacy deploy without --confirm: .env changed'
    Expect ($fake.DbStdin.Count -eq 0) $true 'legacy deploy without --confirm: ran SQL'
    $fake.DbRc = 1
    Expect (Invoke-Fake @('deploy', '--no-pull', '--confirm', 'ta-test')) $false 'legacy deploy, MySQL refusing: succeeded'
    Expect ((EnvOf 'DB_ROOT_PASSWORD') -eq '') $true 'legacy deploy, MySQL refusing: .env keeps a password root does not have'
    $fake.DbRc = 0
    Expect (Invoke-Fake @('deploy', '--no-pull', '--confirm', 'ta-test')) $true "legacy deploy failed: $(& $said)"
    $root = EnvOf 'DB_ROOT_PASSWORD'
    Expect (Hex64 $root) $true 'legacy deploy: DB_ROOT_PASSWORD not written'
    Expect ($root -ne (EnvOf 'DB_PASSWORD')) $true 'legacy deploy: root still shares DB_PASSWORD'
    Expect (($fake.DbStdin -join "`n").Contains("DROP USER IF EXISTS 'root'@'%'; ALTER USER 'root'@'localhost' IDENTIFIED BY '$root';")) $true 'legacy deploy: SQL not sent on stdin'
    Expect (($fake.Log -join "`n").Contains($root)) $false 'legacy deploy: the root password is on a docker command line'
    Expect ($fake.Log -contains 'backup') $true 'legacy deploy: no backup before the change'
    Expect (Invoke-Fake @('deploy', '--no-pull')) $true 'deploy after the move failed'
    Expect ($fake.DbStdin.Count -eq 0) $true 'deploy after the move: ran SQL again'
    Expect ((EnvOf 'DB_ROOT_PASSWORD') -eq $root) $true 'deploy after the move: DB_ROOT_PASSWORD changed'

    # backup: once the dump is copied out, its time, name and size go to api's database for Settings,
    # System (last_backup), as root inside db with the SQL on stdin. A refusal (an api without the
    # table yet) warns and keeps the backup.
    $fake.RealBackup = $true
    $backups = Join-Path $work 'backups'
    Remove-Item -LiteralPath $backups -Recurse -Force -ErrorAction SilentlyContinue
    Expect (Invoke-Fake @('backup')) $true "backup failed: $(& $said)"
    $file = @(Get-ChildItem -LiteralPath $backups -Filter '*.sql.gz')[0]
    $mark = @($fake.DbStdin | Where-Object { $_ -like 'REPLACE INTO last_backup*' })
    Expect ($mark.Count -eq 1 -and $mark[0] -cmatch "\AREPLACE INTO last_backup \(id, finished_at, file, size_bytes\) VALUES \(1, '\d{4}-\d\d-\d\d \d\d:\d\d:\d\d', '$([regex]::Escape($file.Name))', $($file.Length)\);\z") $true "backup: not recorded for Settings, System: $mark"
    Expect (@($fake.Log | Where-Object { $_ -like 'exec -T db sh -c*mysql -uroot temperature_alarms' }).Count -eq 1) $true 'backup: the record did not go to mysql as root in db'
    Expect ((& $said) -match 'recorded as the last backup') $true 'backup: the record not reported'
    Remove-Item -LiteralPath $backups -Recurse -Force
    $fake.DbRc = 1
    Expect (Invoke-Fake @('backup')) $true "backup with the record refused failed: $(& $said)"
    Expect ((& $said) -match 'the backup is kept, but Settings, System could not be told') $true 'backup with the record refused: no warning'
    Expect (@(Get-ChildItem -LiteralPath $backups -Filter '*.sql.gz').Count -eq 1) $true 'backup with the record refused: the backup was not kept'
    $fake.DbRc = 0

    # restore: the restored database holds only the records from before its dump, so once api is back
    # (its migrations run), the backup made just before the restore is recorded again.
    Remove-Item -LiteralPath $backups -Recurse -Force
    $older = Join-Path $work 'older.sql.gz'
    Set-Content -LiteralPath $older -Value 'an older dump'
    Expect (Invoke-Fake @('restore', '--file', $older, '--confirm', 'ta-test')) $true "restore failed: $(& $said)"
    $saved = @(Get-ChildItem -LiteralPath $backups -Filter '*.sql.gz')[0].Name
    Expect (@($fake.DbStdin | Where-Object { $_ -like "REPLACE INTO last_backup*'$saved'*" }).Count -eq 2) $true 'restore: the backup before it is not recorded again'
    Expect (@($fake.DbStdin | Where-Object { $_ -like 'REPLACE INTO last_backup*older*' }).Count -eq 0) $true 'restore: the restored file recorded as a backup'
    $up = [array]::LastIndexOf([string[]]$fake.Log, 'up -d --wait api')
    $recorded = -1
    for ($i = 0; $i -lt $fake.Log.Count; $i++) { if ($fake.Log[$i] -like 'exec -T db sh -c tr -d*mysql -uroot temperature_alarms') { $recorded = $i } }
    Expect ($up -ge 0 -and $recorded -gt $up) $true 'restore: recorded before api came back'
    $fake.RealBackup = $false

    # deploy: api's image is built with the checkout's commit and date as APP_VERSION, passed by
    # compose.yaml as a build argument; outside a git checkout it is empty.
    $compose = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\compose.yaml')
    Expect (@($compose | Where-Object { $_ -ceq '        APP_VERSION: ${APP_VERSION:-}' }).Count -eq 1) $true "compose.yaml: api's build does not get APP_VERSION"
    $fake.Built = @()
    Expect (Invoke-Fake @('deploy', '--no-pull')) $true "deploy outside git failed: $(& $said)"
    Expect ((@($fake.Built | Sort-Object -Unique) -join ',') -eq 'APP_VERSION=') $true "deploy outside git: built with $($fake.Built -join ',')"
    & git -C $work init -q
    & git -C $work -c user.name=t -c user.email=t@example.org commit -q --allow-empty -m 'a commit'
    $version = & git -C $work log -1 '--format=%h %cd' --date=short
    $fake.Built = @()
    Expect (Invoke-Fake @('deploy', '--no-pull')) $true "deploy failed: $(& $said)"
    Expect ((@($fake.Built | Sort-Object -Unique) -join ',') -eq "APP_VERSION=$version") $true "deploy: built with $($fake.Built -join ','), not APP_VERSION=$version"
    Remove-Item -LiteralPath (Join-Path $work '.git') -Recurse -Force

    # publish-firmware: the image reaches api as base64 on stdin; --only is passed through and checked.
    $bin = Join-Path $work 'fw.bin.signed'
    $bytes = New-Object byte[] 4096; (New-Object Random 7).NextBytes($bytes); [IO.File]::WriteAllBytes($bin, $bytes)
    Expect (Invoke-Fake @('publish-firmware')) $false 'publish-firmware without --file: succeeded'
    Expect ((& $said) -match '--file') $true 'publish-firmware without --file: no hint'
    Expect (Invoke-Fake @('publish-firmware', '--file', $bin, '--only', 'ESP_A1B2C3;id')) $false 'publish-firmware with a bad --only: succeeded'
    Expect ($fake.FwStdin.Count -eq 0) $true 'publish-firmware with a bad --only: sent the image'
    $fake.FwStdin = @()
    Expect (Invoke-Fake @('publish-firmware', '--file', $bin, '--only', 'ESP_A1B2C3,ESP_D4E5F6')) $true "publish-firmware failed: $(& $said)"
    Expect (@($fake.Log | Where-Object { $_ -eq 'exec -T api node dist/firmwareCli.js publish --only ESP_A1B2C3,ESP_D4E5F6' }).Count -eq 1) $true 'publish-firmware: wrong command'
    Expect ([Convert]::ToBase64String($bytes) -eq ($fake.FwStdin -join '')) $true 'publish-firmware: the image did not arrive intact on stdin'
    Expect ((& $said) -match 'without --only') $true 'publish-firmware --only: no next step'
    # The forms a technician copies from a board's log reach the tool, which reads them as the Device.
    Expect (Invoke-Fake @('publish-firmware', '--file', $bin, '--only', 'ESP-64533B,64533b')) $true "publish-firmware with ESP-64533B failed: $(& $said)"
    Expect (@($fake.Log | Where-Object { $_ -eq 'exec -T api node dist/firmwareCli.js publish --only ESP-64533B,64533b' }).Count -eq 1) $true 'publish-firmware with ESP-64533B: wrong command'
    $fake.FwRc = 1
    Expect (Invoke-Fake @('publish-firmware', '--file', $bin)) $false 'publish-firmware refused by api: succeeded'
    $fake.FwRc = 0
    Expect (Invoke-Fake @('firmware-status')) $true 'firmware-status failed'
    Expect (Invoke-Fake @('withdraw-firmware')) $true 'withdraw-firmware failed'

    # reset-admin-password: the password reaches api as the first line of stdin, never as an argument;
    # one under 8 characters, or a --user that is not a username, stops before api is asked.
    $fake.UserStdin = @()
    Expect (Invoke-FakeStdin "short`n" @('reset-admin-password')) $false 'reset-admin-password with a short password: succeeded'
    Expect ((& $said) -match 'at least 8 characters') $true 'reset-admin-password with a short password: no reason'
    Expect (Invoke-FakeStdin "a-long-password`n" @('reset-admin-password', '--user', 'admin;id')) $false "reset-admin-password --user 'admin;id': succeeded"
    Expect ($fake.UserStdin.Count -eq 0) $true 'reset-admin-password refused: api was asked anyway'
    Expect (Invoke-FakeStdin "a-long-password`r`n" @('reset-admin-password')) $true "reset-admin-password failed: $(& $said)"
    Expect (@($fake.Log | Where-Object { $_ -eq 'exec -T api node dist/userCli.js reset-admin-password admin' }).Count -eq 1) $true 'reset-admin-password: wrong command'
    Expect (($fake.UserStdin -join '|') -ceq 'a-long-password') $true "reset-admin-password: the password did not arrive on stdin, CR dropped: $($fake.UserStdin.Count) lines"
    Expect (@($fake.Log | Where-Object { $_ -match 'a-long-password' }).Count -eq 0) $true 'reset-admin-password: the password is on a docker command line'
    Expect ((& $said) -match 'a-long-password') $false 'reset-admin-password: the password was printed'
    Expect (Invoke-FakeStdin "a-long-password`n" @('reset-admin-password', '--user', 'Sam.Admin')) $true 'reset-admin-password --user Sam.Admin failed'
    Expect (@($fake.Log | Where-Object { $_ -eq 'exec -T api node dist/userCli.js reset-admin-password Sam.Admin' }).Count -eq 1) $true 'reset-admin-password --user: not passed on'
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item Env:DB_ROOT_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:APP_VERSION -ErrorAction SilentlyContinue
}

if ($fails -eq 0) { Write-Output 'deploy.test.ps1: all passed' } else { Write-Output "deploy.test.ps1: $fails failed"; exit 1 }
