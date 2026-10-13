<#
.SYNOPSIS
  server_supervisor local-API helpers shared by live-verify.ps1 and wdio-sweep.ps1, dot-sourced.

.DESCRIPTION
  Both scripts run their app windows headless under server_supervisor so a test never reaches the
  dev's screen or steals focus. The API binds 127.0.0.1 only; the bearer token comes from the same
  files the supervised-run skill reads and only ever goes into the request header.
#>

function Get-SupervisorApi {
    $dir = Join-Path $env:APPDATA 'com.sirbepy.server-supervisor\supervisor'
    $tokenPath = Join-Path $dir 'api_token.txt'
    $portPath = Join-Path $dir 'api_port.txt'
    if (-not (Test-Path $tokenPath) -or -not (Test-Path $portPath)) { return $null }
    $api = [pscustomobject]@{
        Token   = (Get-Content -Path $tokenPath -Raw).Trim()
        BaseUrl = "http://127.0.0.1:$((Get-Content -Path $portPath -Raw).Trim())"
    }
    # The port file outlives a quit supervisor, so its existence alone proves nothing.
    try { Invoke-RestMethod -Uri "$($api.BaseUrl)/health" -TimeoutSec 3 | Out-Null } catch { return $null }
    return $api
}

function Invoke-Supervisor($api, [string]$Method, [string]$Path, $Body) {
    $req = @{ Method = $Method; Uri = "$($api.BaseUrl)$Path"; Headers = @{ Authorization = "Bearer $($api.Token)" } }
    if ($Body) { $req.Body = ($Body | ConvertTo-Json -Depth 5); $req.ContentType = 'application/json' }
    return Invoke-RestMethod @req
}

# One proc per pipeline item. PowerShell 5.1's Invoke-RestMethod emits a JSON array as ONE object,
# so piping it straight into Where-Object hands the filter the whole array and lets every proc
# through whenever any one matches; returning it from a function enumerates it.
function Get-SupervisorProcs($api) {
    $procs = Invoke-Supervisor $api 'GET' '/procs'
    return $procs
}

# The supervisor deduplicates /run by command name, so a leftover entry from a crashed run would be
# returned instead of a fresh launch. Only entries the calling script names are touched.
function Remove-SupervisorRig($api, [string]$procId) {
    if (-not $procId) { return }
    try { Invoke-Supervisor $api 'POST' "/procs/$procId/stop" | Out-Null } catch { }
    try { Invoke-Supervisor $api 'DELETE' "/procs/$procId" | Out-Null } catch { }
}

# Launches `$Cmd` under the supervisor with its whole process tree headless. `dock_headless` on
# /run registers the root pid with the window-park hook at spawn; supervisors from before that
# field ignore it, so the /dock call follows as the fallback: it persists the headless flag on the
# command BEFORE trying to embed, so even its "no window yet" 400 leaves the flag set, and the
# supervisor's headless tick then docks and parks every window the tree opens, restarts included.
function Start-SupervisorHeadless($api, [string]$Root, [string]$Cmd, [string]$Name, [string]$EnvBlock) {
    foreach ($stale in @(Get-SupervisorProcs $api | Where-Object { $_.id -like "*:$Name" })) {
        Remove-SupervisorRig $api $stale.id
    }
    $body = @{
        root             = $Root
        cmd              = $Cmd
        name             = $Name
        kind             = 'ephemeral'
        use_dynamic_port = $false
        dock_headless    = $true
    }
    if ($EnvBlock) { $body.env = $EnvBlock }
    $started = Invoke-Supervisor $api 'POST' '/run' $body
    try { Invoke-Supervisor $api 'POST' "/procs/$($started.id)/dock" @{ headless = $true } | Out-Null } catch { }
    return $started
}
