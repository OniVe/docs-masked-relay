#requires -version 5.1
<#
.SYNOPSIS
  Build a self-hosted CRX + update.xml for DocsMasked Relay (enterprise).

.DESCRIPTION
  Packs the existing extension/.output/chrome-mv3 build with Chrome or Edge,
  derives the stable extension ID from an RSA key, and writes an update.xml
  plus SHA256SUMS into the output directory. Nothing is uploaded and no
  registry policies are changed here; run install-policy.ps1 on target
  machines (or deploy the same values through GPO/Intune).

  The private key is the update identity. Keep it offline and reuse it for
  every release. Losing it means a new extension ID; leaking it means someone
  else can sign updates for your ID.

.PARAMETER BaseUrl
  Public HTTPS base URL where the CRX and update.xml will be hosted, without
  a trailing slash. Example: https://downloads.example.com/docs-masked-relay

.PARAMETER OutDir
  Output directory. Defaults to installer/enterprise/dist.

.PARAMETER Version
  Optional. Must match the version in the built manifest.json. Defaults to
  the manifest version.

.PARAMETER BrowserPath
  Optional path to chrome.exe or msedge.exe. By default Edge stable is tried
  first, then Chrome.

.PARAMETER KeyPath
  Optional RSA private key (PEM). Defaults to <OutDir>/key.pem. Generated on
  first run if absent and never overwritten.

.PARAMETER Force
  Allow replacing an existing CRX/update.xml in OutDir.

.EXAMPLE
  .\build-selfhosted.ps1 -BaseUrl https://downloads.example.com/docs-masked-relay

.EXAMPLE
  .\build-selfhosted.ps1 -BaseUrl https://example.com/ext -OutDir C:\crx-out -Version 0.2.0
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,

    [string]$OutDir,

    [string]$Version,

    [string]$BrowserPath,

    [string]$KeyPath,

    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# Keep the console UTF-8 so paths and messages survive non-English locales.
try {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $utf8
    $OutputEncoding = $utf8
} catch {
    # No interactive console; harmless.
}

function Write-Step {
    param([string]$Message)
    Write-Host ("==> {0}" -f $Message) -ForegroundColor Cyan
}

function Fail {
    param([string]$Message)
    throw $Message
}

function Get-BrowserPath {
    param([string]$ExplicitPath)

    if ($ExplicitPath) {
        $resolved = [System.IO.Path]::GetFullPath($ExplicitPath)
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            Fail ("Browser not found: {0}" -f $resolved)
        }
        return $resolved
    }

    $roots = @(
        ${env:ProgramFiles(x86)},
        $env:ProgramFiles,
        $env:LOCALAPPDATA
    ) | Where-Object { $_ }

    # Edge stable first, then Chrome, matching the documented preference.
    foreach ($relative in @(
            'Microsoft\Edge\Application\msedge.exe',
            'Google\Chrome\Application\chrome.exe')) {
        foreach ($root in $roots) {
            $candidate = [System.IO.Path]::Combine($root, $relative)
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return $candidate
            }
        }
    }

    Fail 'No Chrome/Edge executable found. Pass -BrowserPath explicitly.'
}

function Get-HelperRuntime {
    foreach ($name in @('node', 'bun')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
    }
    Fail 'Node.js or Bun is required to generate/read the RSA key.'
}

function Invoke-ExtensionHelper {
    param(
        [string]$Command,
        [string]$Path
    )

    $output = & $script:HelperRuntime $script:HelperPath $Command $Path
    if ($LASTEXITCODE -ne 0) {
        Fail ("extension-id.mjs {0} failed with exit code {1}" -f $Command, $LASTEXITCODE)
    }
    $text = ($output | Out-String).Trim()
    if (-not $text) {
        Fail ("extension-id.mjs {0} produced no output" -f $Command)
    }
    return ($text -split "`r?`n" | Select-Object -Last 1).Trim()
}

function Format-ProcessArgument {
    param([string]$Value)
    # Start-Process joins array items with spaces and does not quote them.
    if ($Value -match '[\s"]') {
        return '"' + $Value + '"'
    }
    return $Value
}

function Test-CrxFile {
    param([string]$Path)

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 13) {
        Fail ("CRX is too short: {0} bytes" -f $bytes.Length)
    }

    $magic = [System.Text.Encoding]::ASCII.GetString($bytes, 0, 4)
    if ($magic -cne 'Cr24') {
        Fail ("Bad CRX magic: '{0}' (expected Cr24)" -f $magic)
    }

    $crxVersion = [System.BitConverter]::ToUInt32($bytes, 4)
    if ($crxVersion -ne 3) {
        Fail ("Unsupported CRX version {0} (expected 3)" -f $crxVersion)
    }

    $headerSize = [System.BitConverter]::ToUInt32($bytes, 8)
    if ($headerSize -lt 1 -or $headerSize -gt 1048576) {
        Fail ("Invalid CRX header size {0}" -f $headerSize)
    }
    if (([int64]$headerSize + 12) -ge $bytes.Length) {
        Fail 'Invalid CRX: header consumes the whole file, no payload.'
    }

    return [pscustomobject]@{
        Version    = $crxVersion
        HeaderSize = $headerSize
        Length     = $bytes.Length
    }
}

# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

$BaseUrl = $BaseUrl.Trim()
if ($BaseUrl -notmatch '^https://') {
    Fail 'BaseUrl must start with https:// (plain HTTP is rejected).'
}
if ($BaseUrl -match '[\s<>"''&]') {
    Fail 'BaseUrl must not contain whitespace, quotes, angle brackets or &.'
}

$baseUri = $null
if (-not [System.Uri]::TryCreate($BaseUrl, [System.UriKind]::Absolute, [ref]$baseUri)) {
    Fail ("BaseUrl is not a valid absolute URL: {0}" -f $BaseUrl)
}
if ($baseUri.Scheme -ne 'https') {
    Fail 'BaseUrl must use HTTPS.'
}
if (-not $baseUri.Host) {
    Fail 'BaseUrl must include a host.'
}
if ($baseUri.Query -or $baseUri.Fragment) {
    Fail 'BaseUrl must not contain a query string or fragment.'
}
if ($baseUri.UserInfo) {
    Fail 'BaseUrl must not contain credentials.'
}
$BaseUrl = $BaseUrl.TrimEnd('/')

if (-not $OutDir) {
    $OutDir = Join-Path $PSScriptRoot 'dist'
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)

if (-not $KeyPath) {
    $KeyPath = Join-Path $OutDir 'key.pem'
}
$KeyPath = [System.IO.Path]::GetFullPath($KeyPath)

$script:HelperPath = Join-Path $PSScriptRoot 'extension-id.mjs'
if (-not (Test-Path -LiteralPath $script:HelperPath -PathType Leaf)) {
    Fail ("Missing helper: {0}" -f $script:HelperPath)
}
$script:HelperRuntime = Get-HelperRuntime

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$buildDir = Join-Path $repoRoot 'extension\.output\chrome-mv3'
$manifestPath = Join-Path $buildDir 'manifest.json'

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    Fail ("Extension build not found: {0}. Run 'bun run build' in extension/ first." -f $buildDir)
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$buildVersion = [string]$manifest.version
if (-not $buildVersion) {
    Fail 'Built manifest.json has no version.'
}

if ($Version) {
    $Version = $Version.Trim()
    if ($Version -ne $buildVersion) {
        Fail ("-Version {0} does not match the built manifest version {1}. Rebuild the extension with the same version, or omit -Version." -f $Version, $buildVersion)
    }
} else {
    $Version = $buildVersion
}

if ($Version -notmatch '^\d{1,5}(\.\d{1,5}){0,3}$') {
    Fail ("Invalid extension version '{0}'. Chrome accepts 1-4 dot-separated integers." -f $Version)
}
foreach ($part in $Version.Split('.')) {
    if ([int]$part -gt 65535) {
        Fail ("Version component {0} exceeds 65535." -f $part)
    }
}

$browser = Get-BrowserPath -ExplicitPath $BrowserPath

$crxName = 'DocsMaskedRelay-{0}.crx' -f $Version
$crxPath = Join-Path $OutDir $crxName
$updatePath = Join-Path $OutDir 'update.xml'
$sumsPath = Join-Path $OutDir 'SHA256SUMS'

if (-not $Force) {
    foreach ($existing in @($crxPath, $updatePath, $sumsPath)) {
        if (Test-Path -LiteralPath $existing -PathType Leaf) {
            Fail ("Output already exists: {0}. Pass -Force to replace it." -f $existing)
        }
    }
}

# ---------------------------------------------------------------------------
# Key + extension ID
# ---------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $OutDir -PathType Container)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
    $keyParent = Split-Path -Parent $KeyPath
    if ($keyParent -and -not (Test-Path -LiteralPath $keyParent -PathType Container)) {
        New-Item -ItemType Directory -Path $keyParent -Force | Out-Null
    }
    Write-Step ("Generating RSA-2048 key: {0}" -f $KeyPath)
    $null = Invoke-ExtensionHelper -Command 'keygen' -Path $KeyPath
} else {
    Write-Step ("Using existing key: {0}" -f $KeyPath)
}

$extensionId = Invoke-ExtensionHelper -Command 'id' -Path $KeyPath
if ($extensionId -cnotmatch '^[a-p]{32}$') {
    Fail ("Derived extension ID is invalid: '{0}'" -f $extensionId)
}

Write-Step ("Browser: {0}" -f $browser)
Write-Step ("Extension ID: {0}" -f $extensionId)
Write-Step ("Version: {0}" -f $Version)

# ---------------------------------------------------------------------------
# Pack CRX into a staging copy so Chrome does not write next to the build
# ---------------------------------------------------------------------------

$stageToken = [Guid]::NewGuid().ToString('N')
$stageDir = Join-Path $OutDir ('.pack-' + $stageToken)
$stageCrx = $stageDir + '.crx'
$profileDir = Join-Path $OutDir ('.pack-profile-' + $stageToken)

try {
    New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    Copy-Item -Path (Join-Path $buildDir '*') -Destination $stageDir -Recurse -Force

    if (Test-Path -LiteralPath $stageCrx) {
        Remove-Item -LiteralPath $stageCrx -Force
    }

    Write-Step 'Packing CRX (Chrome/Edge --pack-extension)'
    $packArgs = @(
        (Format-ProcessArgument ('--pack-extension=' + $stageDir)),
        (Format-ProcessArgument ('--pack-extension-key=' + $KeyPath)),
        '--no-message-box',
        (Format-ProcessArgument ('--user-data-dir=' + $profileDir)),
        '--no-first-run',
        '--disable-background-networking'
    )

    $process = Start-Process -FilePath $browser -ArgumentList $packArgs -PassThru -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(120)
    $exitedAt = $null
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $stageCrx) {
            break
        }
        if ($process.HasExited) {
            if (-not $exitedAt) {
                $exitedAt = Get-Date
            }
            # Give a detached child a moment to flush the file.
            if (((Get-Date) - $exitedAt).TotalSeconds -ge 3) {
                break
            }
        }
        Start-Sleep -Milliseconds 200
    }

    $exitCode = $null
    if ($process.HasExited) {
        $exitCode = $process.ExitCode
    } else {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }

    if (-not (Test-Path -LiteralPath $stageCrx -PathType Leaf)) {
        Fail ("CRX packing failed (browser exit code: {0}). Close running browser windows and retry, or pass -BrowserPath." -f $exitCode)
    }

    Copy-Item -LiteralPath $stageCrx -Destination $crxPath -Force
} finally {
    Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stageCrx -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction SilentlyContinue
}

$crxInfo = Test-CrxFile -Path $crxPath
$crxId = Invoke-ExtensionHelper -Command 'crx-id' -Path $crxPath
if ($crxId -ne $extensionId) {
    Fail ("CRX public key ID {0} does not match key ID {1}. The CRX is not usable for this identity." -f $crxId, $extensionId)
}

# ---------------------------------------------------------------------------
# update.xml + checksums
# ---------------------------------------------------------------------------

$codebase = '{0}/{1}' -f $BaseUrl, $crxName
$updateXml = "<?xml version='1.0' encoding='UTF-8'?><gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'><app appid='$extensionId'><updatecheck codebase='$codebase' version='$Version' /></app></gupdate>"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($updatePath, $updateXml, $utf8NoBom)

$crxHash = (Get-FileHash -LiteralPath $crxPath -Algorithm SHA256).Hash.ToLowerInvariant()
$updateHash = (Get-FileHash -LiteralPath $updatePath -Algorithm SHA256).Hash.ToLowerInvariant()
$sums = "{0}  {1}`n{2}  update.xml`n" -f $crxHash, $crxName, $updateHash
[System.IO.File]::WriteAllText($sumsPath, $sums, $utf8NoBom)

$policySource = Join-Path $PSScriptRoot 'install-policy.ps1'
$readmeSource = Join-Path $PSScriptRoot 'README.md'
foreach ($source in @($policySource, $readmeSource)) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        Fail ("Missing package file: {0}" -f $source)
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $OutDir (Split-Path -Leaf $source)) -Force
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

$crxBytes = (Get-Item -LiteralPath $crxPath).Length
Write-Host ''
Write-Host 'Enterprise self-hosted package ready.' -ForegroundColor Green
Write-Host ("  Extension ID : {0}" -f $extensionId)
Write-Host ("  Version      : {0}" -f $Version)
Write-Host ("  CRX size     : {0:N0} bytes" -f $crxBytes)
Write-Host ("  CRX header   : v{0}, {1} bytes, total {2:N0} bytes" -f $crxInfo.Version, $crxInfo.HeaderSize, $crxInfo.Length)
Write-Host ("  Output       : {0}" -f $OutDir)
Write-Host ''
Write-Host 'Files:'
Get-ChildItem -LiteralPath $OutDir -File | Sort-Object Name | ForEach-Object {
    $note = ''
    if ($_.Name -eq 'key.pem') {
        $note = '  [PRIVATE KEY - never upload]'
    }
    Write-Host ("  {0,-40} {1,12:N0} bytes{2}" -f $_.Name, $_.Length, $note)
}
Write-Host ''
Write-Host 'Upload only these two files to the HTTPS host that serves BaseUrl:' -ForegroundColor Yellow
Write-Host ("  {0}" -f $crxName)
Write-Host '  update.xml'
Write-Host ("  BaseUrl: {0}" -f $BaseUrl)
Write-Host ("  Codebase URL baked into update.xml: {0}" -f $codebase)
Write-Host ''
Write-Host 'Installer command for a managed Windows machine (elevated):'
Write-Host ("  powershell -ExecutionPolicy Bypass -File .\install-policy.ps1 -ExtensionId {0} -UpdateUrl {1}/update.xml" -f $extensionId, $BaseUrl)
Write-Host ''
Write-Host 'Keep key.pem offline. Without it you cannot ship updates under this extension ID.' -ForegroundColor Yellow
