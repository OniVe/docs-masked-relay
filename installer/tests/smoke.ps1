#requires -Version 5.1
<#
    DocsMasked Relay - installer smoke test.

    Installs into a temporary folder (never the real %LOCALAPPDATA%\DocsMaskedRelay),
    validates the extracted extension and install.json, runs an upgrade, then runs
    the uninstaller and checks that everything is gone.

    No browser is opened, no shortcuts are created, no network is used.

    Usage (from the repository root):
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File installer/tests/smoke.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# Use UTF-8 for console output so Cyrillic test messages render correctly.
try {
    $utf8Console = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $utf8Console
    $OutputEncoding = $utf8Console
} catch { }

$script:TestRoot = $null
$script:Passed = 0

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[smoke] $Message"
}

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) {
        throw "ASSERT FAILED: $Message"
    }
    $script:Passed++
    Write-Host ("  ok: {0}" -f $Message)
}

function Get-ZipFileCount {
    param([Parameter(Mandatory = $true)][string]$ZipPath)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        return @($archive.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) }).Count
    } finally {
        $archive.Dispose()
    }
}

function Invoke-Installer {
    param(
        [Parameter(Mandatory = $true)][string]$PowerShellExe,
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$StepName
    )
    Write-Step $StepName
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        throw ("{0} завершился с кодом {1}." -f $StepName, $code)
    }
}

$installerRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $installerRoot
$installScript = Join-Path $installerRoot 'src\install.ps1'
$uninstallScript = Join-Path $installerRoot 'src\uninstall.ps1'
$buildDir = Join-Path $repoRoot 'extension\.output\chrome-mv3'
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

try {
    Write-Host ''
    Write-Host '============================================================'
    Write-Host '  DocsMasked Relay - installer smoke test'
    Write-Host '============================================================'
    Write-Host ''

    Assert-True -Condition (Test-Path -LiteralPath $installScript -PathType Leaf) -Message 'install.ps1 существует'
    Assert-True -Condition (Test-Path -LiteralPath $uninstallScript -PathType Leaf) -Message 'uninstall.ps1 существует'

    $realRoot = Join-Path $env:LOCALAPPDATA 'DocsMaskedRelay'
    $realRootExistedBefore = Test-Path -LiteralPath $realRoot

    $unique = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $script:TestRoot = Join-Path $env:TEMP ("dmrelay smoke тест {0}" -f $unique)
    New-Item -ItemType Directory -Path $script:TestRoot -Force | Out-Null
    $installRoot = Join-Path $script:TestRoot 'DocsMaskedRelay'
    Write-Step ("Временный InstallRoot: {0}" -f $installRoot)

    $payloadZip = Join-Path $script:TestRoot 'payload.zip'
    $existingPayload = @(
        (Join-Path $installerRoot 'dist\payload.zip'),
        (Join-Path $installerRoot 'staging\payload.zip')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

    if ($null -ne $existingPayload) {
        Copy-Item -LiteralPath $existingPayload -Destination $payloadZip -Force
        Write-Step ("Использую существующий payload: {0}" -f $existingPayload)
    } else {
        if (-not (Test-Path -LiteralPath (Join-Path $buildDir 'manifest.json') -PathType Leaf)) {
            throw "Нет ни payload.zip, ни сборки extension (.output/chrome-mv3). Выполните: cd extension; bun run build; затем installer\build-installer.ps1."
        }
        Write-Step 'Создаю временный payload.zip из extension\.output\chrome-mv3...'
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::CreateFromDirectory(
            $buildDir,
            $payloadZip,
            [System.IO.Compression.CompressionLevel]::Optimal,
            $false
        )
    }

    $expectedFileCount = Get-ZipFileCount -ZipPath $payloadZip
    Assert-True -Condition ($expectedFileCount -gt 10) -Message ("payload содержит файлы ({0})" -f $expectedFileCount)

    Invoke-Installer -PowerShellExe $powershellExe -ScriptPath $installScript -StepName 'Установка во временный InstallRoot' -Arguments @(
        '-InstallRoot', $installRoot,
        '-PayloadZip', $payloadZip,
        '-Browser', 'None',
        '-NoOpen',
        '-NoShortcuts'
    )

    $extensionDir = Join-Path $installRoot 'extension'
    $manifestPath = Join-Path $extensionDir 'manifest.json'
    $installJsonPath = Join-Path $installRoot 'install.json'
    Assert-True -Condition (Test-Path -LiteralPath $extensionDir -PathType Container) -Message 'папка extension создана'
    Assert-True -Condition (Test-Path -LiteralPath $manifestPath -PathType Leaf) -Message 'manifest.json распакован'
    Assert-True -Condition (Test-Path -LiteralPath $installJsonPath -PathType Leaf) -Message 'install.json записан'
    Assert-True -Condition (Test-Path -LiteralPath (Join-Path $installRoot 'uninstall.ps1') -PathType Leaf) -Message 'uninstall.ps1 скопирован в InstallRoot'
    Assert-True -Condition (Test-Path -LiteralPath (Join-Path $installRoot 'INSTALL-INSTRUCTIONS.txt') -PathType Leaf) -Message 'инструкция записана'

    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True -Condition ($manifest.manifest_version -eq 3) -Message 'manifest_version = 3'
    Assert-True -Condition (-not [string]::IsNullOrWhiteSpace([string]$manifest.name)) -Message 'manifest name заполнен'
    Assert-True -Condition (-not [string]::IsNullOrWhiteSpace([string]$manifest.version)) -Message 'manifest version заполнен'
    Assert-True -Condition (Test-Path -LiteralPath (Join-Path $extensionDir 'background.js') -PathType Leaf) -Message 'background.js присутствует'

    $actualFileCount = @(Get-ChildItem -LiteralPath $extensionDir -Recurse -File).Count
    Assert-True -Condition ($actualFileCount -eq $expectedFileCount) -Message ("распаковано ровно {0} файлов" -f $expectedFileCount)

    $meta = Get-Content -LiteralPath $installJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True -Condition ([string]$meta.version -eq [string]$manifest.version) -Message 'install.json version совпадает с manifest'
    Assert-True -Condition (-not [string]::IsNullOrWhiteSpace([string]$meta.installedAt)) -Message 'install.json installedAt заполнен'
    Assert-True -Condition (-not [string]::IsNullOrWhiteSpace([string]$meta.source)) -Message 'install.json source заполнен'
    Assert-True -Condition ([string]$meta.source -eq 'portable-zip') -Message 'источник определён как portable-zip'

    # Second run: exercise the atomic replace and backup path.
    Invoke-Installer -PowerShellExe $powershellExe -ScriptPath $installScript -StepName 'Повторная установка (обновление поверх)' -Arguments @(
        '-InstallRoot', $installRoot,
        '-PayloadZip', $payloadZip,
        '-Browser', 'None',
        '-NoOpen',
        '-NoShortcuts'
    )

    $backups = @(Get-ChildItem -LiteralPath $installRoot -Directory -Filter 'extension.old-*' -ErrorAction SilentlyContinue)
    Assert-True -Condition ($backups.Count -eq 1) -Message 'предыдущая версия сохранена в один backup'
    Assert-True -Condition (Test-Path -LiteralPath (Join-Path $backups[0].FullName 'manifest.json') -PathType Leaf) -Message 'backup содержит manifest.json'
    Assert-True -Condition (Test-Path -LiteralPath $manifestPath -PathType Leaf) -Message 'manifest.json на месте после обновления'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $installRoot 'extension.new'))) -Message 'временная папка extension.new удалена'

    Invoke-Installer -PowerShellExe $powershellExe -ScriptPath $uninstallScript -StepName 'Удаление временной установки' -Arguments @(
        '-InstallRoot', $installRoot,
        '-NoShortcuts',
        '-Force'
    )

    Assert-True -Condition (-not (Test-Path -LiteralPath $installRoot)) -Message 'InstallRoot полностью удалён'
    Assert-True -Condition (-not (Test-Path -LiteralPath $extensionDir)) -Message 'папка extension удалена'

    $realRootExistsAfter = Test-Path -LiteralPath $realRoot
    Assert-True -Condition ($realRootExistsAfter -eq $realRootExistedBefore) -Message 'реальный %LOCALAPPDATA%\DocsMaskedRelay не тронут'

    Write-Host ''
    Write-Host ("SMOKE: PASS ({0} проверок)" -f $script:Passed) -ForegroundColor Green
    Write-Host ''
    exit 0
} catch {
    Write-Host ''
    Write-Host ("SMOKE: FAIL - {0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host ("Временный каталог: {0}" -f $script:TestRoot)
    exit 1
} finally {
    if ($null -ne $script:TestRoot -and (Test-Path -LiteralPath $script:TestRoot)) {
        try {
            Set-Location -LiteralPath $env:TEMP
            Remove-Item -LiteralPath $script:TestRoot -Recurse -Force
        } catch {
            Write-Warning ("Не удалось удалить временный каталог: {0}" -f $script:TestRoot)
        }
    }
}
