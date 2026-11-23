#requires -version 5.1
<#
.SYNOPSIS
  Force-install DocsMasked Relay in Chrome and/or Edge via Windows policy.

.DESCRIPTION
  Writes one named value (DocsMaskedRelay) under the browser's
  ExtensionInstallForcelist policy key. Existing force-install entries are
  left untouched. The extension then installs silently from the self-hosted
  CRX/update.xml endpoint; Developer mode and "Load unpacked" are not used.

  Real writes require an elevated 64-bit PowerShell session. -DryRun validates
  all inputs and prints the exact registry operations without writing anything,
  so it can run as a standard user. (#Requires -RunAsAdministrator is
  unconditional, so elevation is checked at runtime to keep -DryRun usable.)

.PARAMETER ExtensionId
  32-character Chrome extension ID (letters a-p), printed by
  build-selfhosted.ps1.

.PARAMETER UpdateUrl
  Public HTTPS URL of update.xml, for example
  https://downloads.example.com/docs-masked-relay/update.xml.
  Required for install; ignored with -Uninstall.

.PARAMETER Browsers
  One or both of Chrome, Edge. Default: both.

.PARAMETER Uninstall
  Remove only the DocsMaskedRelay policy value. The policy key is removed only
  when it has no other values or subkeys.

.PARAMETER DryRun
  Validate and print planned actions without changing the registry.

.EXAMPLE
  .\install-policy.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop `
      -UpdateUrl https://downloads.example.com/docs-masked-relay/update.xml

.EXAMPLE
  .\install-policy.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop -Uninstall

.EXAMPLE
  .\install-policy.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop `
      -UpdateUrl https://example.invalid/ext/update.xml -DryRun
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ExtensionId,

    [string]$UpdateUrl,

    [ValidateSet('Chrome', 'Edge')]
    [string[]]$Browsers = @('Chrome', 'Edge'),

    [switch]$Uninstall,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$ValueName = 'DocsMaskedRelay'

function Fail {
    param([string]$Message)
    throw $Message
}

function Write-Plan {
    param([string]$Message)
    Write-Host ("  {0}" -f $Message) -ForegroundColor DarkYellow
}

if ($env:OS -ne 'Windows_NT') {
    Fail 'This installer only supports Windows.'
}

# ---------------------------------------------------------------------------
# Validation (also performed for -DryRun)
# ---------------------------------------------------------------------------

$ExtensionId = $ExtensionId.Trim()
if ($ExtensionId -cnotmatch '^[a-p]{32}$') {
    Fail ("Invalid extension ID '{0}'. Expected exactly 32 characters in the range a-p." -f $ExtensionId)
}

$Browsers = @($Browsers | ForEach-Object { $_.Trim() } | Select-Object -Unique)
if ($Browsers.Count -eq 0) {
    Fail 'Select at least one browser (Chrome and/or Edge).'
}
foreach ($browser in $Browsers) {
    if ($browser -ne 'Chrome' -and $browser -ne 'Edge') {
        Fail ("Unsupported browser '{0}'. Use Chrome and/or Edge." -f $browser)
    }
}

if (-not $Uninstall) {
    if (-not $UpdateUrl) {
        Fail '-UpdateUrl is required for install (or pass -Uninstall).'
    }
    $UpdateUrl = $UpdateUrl.Trim()
    if ($UpdateUrl -match '\s') {
        Fail 'UpdateUrl must not contain whitespace.'
    }
    $updateUri = $null
    if (-not [System.Uri]::TryCreate($UpdateUrl, [System.UriKind]::Absolute, [ref]$updateUri)) {
        Fail ("UpdateUrl is not a valid absolute URL: {0}" -f $UpdateUrl)
    }
    if ($updateUri.Scheme -ne 'https') {
        Fail 'UpdateUrl must use HTTPS.'
    }
    if (-not $updateUri.Host) {
        Fail 'UpdateUrl must include a host.'
    }
    if ($updateUri.UserInfo) {
        Fail 'UpdateUrl must not contain credentials.'
    }
    if ($updateUri.Query -or $updateUri.Fragment) {
        Fail 'UpdateUrl must not contain a query string or fragment.'
    }
    if ($updateUri.AbsolutePath -cnotmatch 'update\.xml$') {
        Fail 'UpdateUrl must end with update.xml.'
    }
} else {
    $UpdateUrl = $null
}

if (-not $DryRun) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Fail 'Administrator rights are required. Re-run from an elevated PowerShell, or use -DryRun to preview.'
    }
    if (-not [Environment]::Is64BitProcess) {
        Fail 'Run 64-bit PowerShell. A 32-bit process may write to the WOW6432Node registry view, which 64-bit Chrome/Edge do not read.'
    }
}

$policyTargets = @()
if ($Browsers -contains 'Chrome') {
    $policyTargets += [pscustomobject]@{
        Browser = 'Chrome'
        Key     = 'HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist'
    }
}
if ($Browsers -contains 'Edge') {
    $policyTargets += [pscustomobject]@{
        Browser = 'Edge'
        Key     = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist'
    }
}

$policyData = $null
if (-not $Uninstall) {
    $policyData = '{0};{1}' -f $ExtensionId, $UpdateUrl
}

$mode = 'INSTALL'
if ($Uninstall) {
    $mode = 'UNINSTALL'
}
if ($DryRun) {
    Write-Host ("DRY RUN: {0} DocsMasked Relay policy. No registry changes will be made." -f $mode) -ForegroundColor Yellow
} else {
    Write-Host ("{0} DocsMasked Relay policy (administrator)." -f $mode) -ForegroundColor Cyan
}
Write-Host ''
Write-Host ("Extension ID : {0}" -f $ExtensionId)
if ($policyData) {
    Write-Host ("Policy value : {0}" -f $policyData)
}
Write-Host ("Browsers     : {0}" -f ($Browsers -join ', '))
Write-Host ''

# ---------------------------------------------------------------------------
# Apply / plan
# ---------------------------------------------------------------------------

foreach ($target in $policyTargets) {
    $key = $target.Key
    Write-Host ("[{0}] {1}" -f $target.Browser, $key)

    $keyExists = Test-Path -LiteralPath $key

    if ($Uninstall) {
        if (-not $keyExists) {
            Write-Host '  Policy key is absent; nothing to remove.' -ForegroundColor Gray
            continue
        }

        $item = Get-Item -LiteralPath $key
        $valueNames = @($item.GetValueNames())
        if ($valueNames -contains $ValueName) {
            if ($DryRun) {
                Write-Plan ("Remove-ItemProperty -Path '{0}' -Name '{1}'" -f $key, $ValueName)
            } else {
                Remove-ItemProperty -LiteralPath $key -Name $ValueName
                Write-Host ("  Removed value '{0}'." -f $ValueName) -ForegroundColor Green
                $item = Get-Item -LiteralPath $key
            }
        } else {
            Write-Host ("  Value '{0}' is not present." -f $ValueName) -ForegroundColor Gray
        }

        $remainingValues = @($item.GetValueNames() | Where-Object { $_ -ne $ValueName })
        $remainingSubkeys = @($item.GetSubKeyNames())
        if ($remainingValues.Count -eq 0 -and $remainingSubkeys.Count -eq 0) {
            if ($DryRun) {
                Write-Plan ("Remove-Item -Path '{0}' -Force  # key would be empty" -f $key)
            } else {
                Remove-Item -LiteralPath $key -Force
                Write-Host '  Removed empty policy key.' -ForegroundColor Green
            }
        } else {
            Write-Host '  Policy key kept: it still contains other values or subkeys.' -ForegroundColor Gray
        }
    } else {
        if (-not $keyExists) {
            if ($DryRun) {
                Write-Plan ("New-Item -Path '{0}' -Force" -f $key)
            } else {
                New-Item -Path $key -Force | Out-Null
                Write-Host '  Created policy key.' -ForegroundColor Green
            }
        }

        if ($DryRun) {
            Write-Plan ("New-ItemProperty -Path '{0}' -Name '{1}' -PropertyType String -Value '{2}' -Force" -f $key, $ValueName, $policyData)
            $existingValue = $null
            if ($keyExists) {
                $existing = Get-Item -LiteralPath $key
                if (@($existing.GetValueNames()) -contains $ValueName) {
                    $existingValue = $existing.GetValue($ValueName)
                }
            }
            if ($existingValue) {
                Write-Plan ("# would replace current value: {0}" -f $existingValue)
            }
        } else {
            New-ItemProperty -LiteralPath $key -Name $ValueName -PropertyType String -Value $policyData -Force | Out-Null
            $written = (Get-ItemProperty -LiteralPath $key -Name $ValueName).$ValueName
            if ($written -ne $policyData) {
                Fail ("Policy write verification failed for {0}." -f $key)
            }
            Write-Host ("  Set '{0}' = '{1}'." -f $ValueName, $policyData) -ForegroundColor Green
        }
    }
    Write-Host ''
}

# ---------------------------------------------------------------------------
# Operator guidance
# ---------------------------------------------------------------------------

if ($DryRun) {
    Write-Host 'Dry run complete. No registry writes were performed.' -ForegroundColor Yellow
    Write-Host 'Re-run without -DryRun from an elevated 64-bit PowerShell to apply.'
    return
}

Write-Host 'Next steps:'
if ($Uninstall) {
    Write-Host '  1. Fully quit and restart Chrome/Edge (check Task Manager for background processes).'
    Write-Host '  2. The force-installed extension is removed at the next policy refresh.'
} else {
    Write-Host '  1. Fully quit and restart Chrome/Edge (check Task Manager for background processes).'
    Write-Host '  2. Open chrome://policy or edge://policy and confirm ExtensionInstallForcelist'
    Write-Host '     lists this ID with status OK. Use "Reload policies" to avoid waiting.'
    Write-Host '  3. Open chrome://extensions or edge://extensions. DocsMasked Relay should be'
    Write-Host '     installed and enabled, with a managed/administrator badge, without'
    Write-Host '     Developer mode or Load unpacked.'
}
Write-Host ''
Write-Host 'The browser downloads the CRX from the update URL over HTTPS and verifies its signature.'
Write-Host 'If installation does not appear, confirm the host serves update.xml and the CRX, that'
Write-Host 'the codebase URL in update.xml is reachable, and that the policy value has no extra spaces.'
