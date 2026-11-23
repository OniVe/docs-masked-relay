#requires -Version 5.1
<#
    DocsMasked Relay - per-user uninstaller.

    Removes only:
      * %LOCALAPPDATA%\DocsMaskedRelay (or a custom -InstallRoot);
      * the Start Menu shortcuts created by install.ps1.

    It never touches the browser profile, the extension vault, registry
    policies, HKLM, or any other user data.
#>
[CmdletBinding()]
param(
    [string]$InstallRoot = '',
    [switch]$NoShortcuts,
    [switch]$Force
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# The uninstaller UI contains Cyrillic text. Use UTF-8 for console output.
try {
    $utf8Console = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $utf8Console
    $OutputEncoding = $utf8Console
} catch { }

$script:ProductName = 'DocsMasked Relay'
$script:ShortcutFolderName = 'DocsMasked Relay'
$script:ResolvedRoot = $null

function Resolve-FullPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ParameterName
    )
    try {
        $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
        return [System.IO.Path]::GetFullPath($resolved)
    } catch {
        throw "$ParameterName '$Path' не является корректным путём: $($_.Exception.Message)"
    }
}

function Assert-SafeInstallRoot {
    param([Parameter(Mandatory = $true)][string]$Path)
    $trimmed = $Path.TrimEnd('\', '/')
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        throw 'InstallRoot пуст.'
    }
    $pathRoot = [System.IO.Path]::GetPathRoot($trimmed)
    if ($pathRoot -and ($trimmed -eq $pathRoot.TrimEnd('\', '/'))) {
        throw "InstallRoot не может быть корнем диска: $trimmed"
    }
    foreach ($forbidden in @($env:LOCALAPPDATA, $env:USERPROFILE, $env:APPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ([string]::IsNullOrWhiteSpace($forbidden)) { continue }
        $forbiddenFull = [System.IO.Path]::GetFullPath($forbidden).TrimEnd('\', '/')
        if ($trimmed -eq $forbiddenFull) {
            throw "InstallRoot не может совпадать с системной папкой: $forbiddenFull"
        }
    }
}

function Remove-Shortcuts {
    $startMenuPrograms = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $shortcutFolder = Join-Path $startMenuPrograms $script:ShortcutFolderName
    if (-not (Test-Path -LiteralPath $shortcutFolder -PathType Container)) {
        Write-Host 'Ярлыки в меню Пуск не найдены (уже удалены).'
        return
    }

    $names = @(
        'Открыть папку расширения.lnk',
        'Удалить DocsMasked Relay.lnk'
    )
    foreach ($name in $names) {
        $path = Join-Path $shortcutFolder $name
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Remove-Item -LiteralPath $path -Force
        }
    }
    Get-ChildItem -LiteralPath $shortcutFolder -Filter 'Открыть страницы расширений *.lnk' -File -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }

    $remaining = @(Get-ChildItem -LiteralPath $shortcutFolder -Force -ErrorAction SilentlyContinue)
    if ($remaining.Count -eq 0) {
        Remove-Item -LiteralPath $shortcutFolder -Force
    } else {
        Write-Warning ("В папке ярлыков остались посторонние файлы, папка сохранена: {0}" -f $shortcutFolder)
    }
}

function Invoke-Uninstall {
    if (-not $PSBoundParameters.ContainsKey('InstallRoot') -and -not [string]::IsNullOrWhiteSpace($env:DMRELAY_INSTALL_ROOT)) {
        $InstallRoot = $env:DMRELAY_INSTALL_ROOT
    }
    if (-not $NoShortcuts -and $env:DMRELAY_NO_SHORTCUTS -eq '1') { $NoShortcuts = $true }
    if (-not $Force -and $env:DMRELAY_FORCE -eq '1') { $Force = $true }

    if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
        $InstallRoot = Join-Path $env:LOCALAPPDATA 'DocsMaskedRelay'
    }
    $InstallRoot = Resolve-FullPath -Path $InstallRoot -ParameterName 'InstallRoot'
    Assert-SafeInstallRoot -Path $InstallRoot
    $script:ResolvedRoot = $InstallRoot

    Write-Host ''
    Write-Host '============================================================'
    Write-Host ("  {0} - удаление" -f $script:ProductName)
    Write-Host '============================================================'
    Write-Host ("  Папка установки: {0}" -f $InstallRoot)
    Write-Host ''

    if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) {
        Write-Host 'Папка установки не найдена: компоненты уже удалены.'
        if (-not $NoShortcuts) { Remove-Shortcuts }
        Write-Host ''
        Write-Host 'Если расширение всё ещё загружено в браузере, удалите его на странице расширений.'
        return
    }

    $installJson = Join-Path $InstallRoot 'install.json'
    $extensionManifest = Join-Path $InstallRoot 'extension\manifest.json'
    $stagingManifest = Join-Path $InstallRoot 'extension.new\manifest.json'
    if (-not (Test-Path -LiteralPath $installJson -PathType Leaf) -and
        -not (Test-Path -LiteralPath $extensionManifest -PathType Leaf) -and
        -not (Test-Path -LiteralPath $stagingManifest -PathType Leaf)) {
        Write-Host 'В указанной папке нет следов установки DocsMasked Relay. Ничего не удаляю.'
        return
    }

    if (-not $Force) {
        Write-Host 'Будут удалены файлы расширения и ярлыки из меню Пуск.'
        Write-Host 'Расширение, загруженное в браузере, и vault в профиле браузера НЕ удаляются.'
        Write-Host ''
        $answer = Read-Host 'Продолжить? [y/N]'
        if ($answer -notmatch '^(?i)y(es)?$') {
            Write-Host 'Удаление отменено.'
            return
        }
    }

    Write-Host ''
    Write-Host 'ВАЖНО: после удаления файлов расширение может остаться в браузере.'
    Write-Host 'Удалите его вручную: edge://extensions/ или chrome://extensions/ -> Удалить (Remove).'
    Write-Host 'Vault и данные расширения хранятся в профиле браузера; этот скрипт их не трогает.'
    Write-Host ''

    if (-not $NoShortcuts) {
        Write-Host 'Удаляю ярлыки из меню Пуск...'
        Remove-Shortcuts
    }

    # Leave the install directory before deleting it: a process cannot reliably
    # delete the directory that is its current working directory on Windows.
    Set-Location -LiteralPath $env:TEMP

    Write-Host 'Удаляю файлы установки...'
    try {
        Remove-Item -LiteralPath $InstallRoot -Recurse -Force
    } catch {
        throw ("Не удалось удалить {0}: {1}.`r`nЗакройте браузер (он может держать файлы расширения открытыми), удалите расширение на странице расширений и повторите запуск." -f $InstallRoot, $_.Exception.Message)
    }

    if (Test-Path -LiteralPath $InstallRoot) {
        throw "Папка установки всё ещё существует после удаления: $InstallRoot"
    }

    Write-Host ''
    Write-Host 'Файлы DocsMasked Relay удалены.'
    Write-Host 'Остался ручной шаг: удалите расширение на странице edge://extensions/ или chrome://extensions/.'
    Write-Host 'Vault в профиле браузера этим скриптом не удалялся.'
    Write-Host ''
}

try {
    Invoke-Uninstall
    exit 0
} catch {
    $message = $_.Exception.Message
    Write-Host ''
    Write-Host 'ОШИБКА УДАЛЕНИЯ' -ForegroundColor Red
    Write-Host $message -ForegroundColor Red
    Write-Host ("Каталог установки: {0}" -f $script:ResolvedRoot)
    exit 1
}
