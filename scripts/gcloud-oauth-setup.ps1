<#
.SYNOPSIS
  Scripted half of the Google Cloud OAuth setup for a Google API (Drive first): creates the
  project, enables the API, and later moves the OAuth client id and secret from the JSON Google
  lets you download into a gitignored env file, so the secret never goes through a chat.

.DESCRIPTION
  What `gcloud` can and cannot do was read from `gcloud ... --help` (SDK 580.0.0), see
  docs/gcloud-oauth-setup.md. The short version: no gcloud command creates the classic
  "OAuth 2.0 Client ID" an app uses for Google sign-in or the Drive API, so that step stays in
  the browser. `gcloud iam oauth-clients` makes IAM workforce-federation clients (scopes limited
  to cloud-platform, openid, email, groups), and `gcloud iap oauth-brands` is deprecated and shut
  down.

  Two stages, run as separate commands:

    1. Project stage (no -ClientJson): creates the project if it does not exist and enables the
       APIs. Needs an existing `gcloud auth login`; this script never logs in and never runs
       anything that signs in. Ends by printing the browser-only steps.
    2. Secret stage (-ClientJson): reads the client JSON downloaded in the browser, writes
       <Prefix>CLIENT_ID and <Prefix>CLIENT_SECRET into -EnvFile, and optionally deletes the JSON.
       Neither value is printed.

  The env file follows the same rules as the `request_secret` tool: it must sit inside a git
  repository and be gitignored, or the script refuses to write.

.PARAMETER ProjectId
  Globally unique Cloud project id (6-30 chars, lowercase letters, digits, hyphens).

.PARAMETER ProjectName
  Display name for a newly created project. Defaults to the project id.

.PARAMETER Apis
  Services to enable. Defaults to the Drive API.

.PARAMETER ClientJson
  Path to the client_secret_*.json downloaded from the Credentials page. Switches to the secret stage.

.PARAMETER EnvFile
  Gitignored file to write KEY=value lines into. Required for the secret stage.

.PARAMETER Prefix
  Key prefix in the env file. Default "GOOGLE_".

.PARAMETER DeleteJson
  Delete -ClientJson after its values are written.

.EXAMPLE
  scripts\gcloud-oauth-setup.ps1 -ProjectId my-app-oauth -WhatIf
  scripts\gcloud-oauth-setup.ps1 -ProjectId my-app-oauth
  scripts\gcloud-oauth-setup.ps1 -ClientJson $HOME\Downloads\client_secret_123.json -EnvFile .\.env.local -DeleteJson
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$ProjectId,
  [string]$ProjectName,
  [string[]]$Apis = @('drive.googleapis.com'),
  [string]$ClientJson,
  [string]$EnvFile,
  [string]$Prefix = 'GOOGLE_',
  [switch]$DeleteJson
)

$ErrorActionPreference = 'Stop'

# Runs a native command whose stderr is expected noise (Windows PowerShell 5.1 turns stderr into a
# terminating error under 'Stop') and returns its exit code; stdout goes to the pipeline.
function Invoke-Quiet {
  param([scriptblock]$Block)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Block 2>$null } finally { $ErrorActionPreference = $prev }
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# Hard stop on a native command failure; gcloud errors do not raise PowerShell errors on their own.
function Invoke-Gcloud {
  param([string[]]$GcloudArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & gcloud @GcloudArgs 2>&1 | ForEach-Object { Write-Host $_ } } finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { throw "gcloud $($GcloudArgs -join ' ') failed with exit code $LASTEXITCODE" }
}

if ($ClientJson) {
  # ---- Secret stage ----
  if (-not $EnvFile) { throw '-EnvFile is required with -ClientJson.' }
  if (-not (Test-Path -LiteralPath $ClientJson -PathType Leaf)) { throw "Client JSON not found: $ClientJson" }

  # Resolve against PowerShell's location, not the .NET process directory.
  $envPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($EnvFile)
  $ClientJson = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ClientJson)
  $envDir = Split-Path -Parent $envPath
  if (-not (Test-Path -LiteralPath $envDir -PathType Container)) { throw "Folder of -EnvFile does not exist: $envDir" }
  $null = Invoke-Quiet { git -C $envDir rev-parse --is-inside-work-tree }
  if ($LASTEXITCODE -ne 0) { throw "-EnvFile must be inside a git repository so it can be gitignored: $envPath" }
  $null = Invoke-Quiet { git -C $envDir check-ignore -q -- $envPath }
  if ($LASTEXITCODE -ne 0) { throw "Refusing to write: $envPath is not gitignored. Add it to .gitignore first." }

  # Fixed message on purpose: Windows PowerShell 5.1 parse errors can quote a fragment of the input.
  try { $json = Get-Content -LiteralPath $ClientJson -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { throw "$ClientJson is not valid JSON." }
  # Desktop clients use the "installed" key, web clients "web".
  $client = if ($json.installed) { $json.installed } elseif ($json.web) { $json.web } else { $null }
  if (-not $client -or -not $client.client_id -or -not $client.client_secret) {
    throw "$ClientJson has no installed/web client_id and client_secret."
  }

  $values = [ordered]@{
    "${Prefix}CLIENT_ID"     = [string]$client.client_id
    "${Prefix}CLIENT_SECRET" = [string]$client.client_secret
  }
  if ($PSCmdlet.ShouldProcess($envPath, "write $($values.Keys -join ', ')")) {
    $existing = if (Test-Path -LiteralPath $envPath) { @(Get-Content -LiteralPath $envPath -Encoding UTF8) } else { @() }
    $kept = @($existing | Where-Object { $line = $_; -not ($values.Keys | Where-Object { $line -match "^\s*(export\s+)?$([regex]::Escape($_))\s*=" }) })
    $lines = $kept + ($values.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })
    Write-Utf8NoBom $envPath (($lines -join "`n") + "`n")
    Write-Host "Wrote $($values.Keys -join ', ') to $envPath"
    if ($DeleteJson) {
      Remove-Item -LiteralPath $ClientJson -Force
      Write-Host "Deleted $ClientJson"
    }
  }
  return
}

# ---- Project stage ----
if (-not $ProjectId) { throw '-ProjectId is required.' }
if ($ProjectId -notmatch '^[a-z][a-z0-9-]{4,28}[a-z0-9]$') { throw "ProjectId must be 6-30 chars: lowercase letters, digits, hyphens, starting with a letter." }
if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) { throw 'gcloud is not on PATH.' }
if (-not $ProjectName) { $ProjectName = $ProjectId }

# Read-only check; the sign-in itself (`gcloud auth login`) is a browser step only the account owner does.
$account = Invoke-Quiet { gcloud auth list --filter=status:ACTIVE --format='value(account)' }
if (-not $account) { throw 'No active gcloud account. Run `gcloud auth login` yourself first, then rerun this script.' }
Write-Host "Using gcloud account: $account"

$null = Invoke-Quiet { gcloud projects describe $ProjectId --format='value(projectId)' }
$exists = ($LASTEXITCODE -eq 0)
if ($exists) {
  Write-Host "Project $ProjectId already exists, skipping create."
} elseif ($PSCmdlet.ShouldProcess($ProjectId, 'gcloud projects create')) {
  # A failed describe means "missing" or "no access" (expired login, someone else's id); a failed create then names the real cause.
  Invoke-Gcloud @('projects', 'create', $ProjectId, "--name=$ProjectName")
}

if ($PSCmdlet.ShouldProcess($ProjectId, "gcloud services enable $($Apis -join ' ')")) {
  Invoke-Gcloud (@('services', 'enable') + $Apis + @("--project=$ProjectId"))
}

if ($WhatIfPreference) { return }
@"

Project stage done. These steps have no gcloud command; do them in the browser
(details in docs/gcloud-oauth-setup.md):

  1. Branding / consent screen (app name, support email, homepage URL, privacy policy URL):
     https://console.cloud.google.com/auth/branding?project=$ProjectId
  2. Audience: set the user type, add test users, then "Publish app" to move out of Testing:
     https://console.cloud.google.com/auth/audience?project=$ProjectId
  3. Clients > Create client (Desktop app or Web application, add redirect URIs for Web),
     then use "Download JSON" in the dialog (the secret is only shown there):
     https://console.cloud.google.com/auth/clients?project=$ProjectId
  4. Back here:
     scripts\gcloud-oauth-setup.ps1 -ClientJson <downloaded client_secret_*.json> -EnvFile <gitignored file> -DeleteJson
"@ | Write-Host
