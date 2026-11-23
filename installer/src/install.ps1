#requires -Version 5.1
<#
    DocsMasked Relay - per-user installer for the unpacked Chrome/Edge MV3 extension.

    What it does:
      * extracts payload.zip into %LOCALAPPDATA%\DocsMaskedRelay\extension (atomically);
      * writes install.json (version, installedAt, source);
      * copies uninstall.ps1 and the instructions into the install root;
      * creates per-user Start Menu shortcuts (optional with -NoShortcuts);
      * opens Explorer and the browser extensions page (optional with -NoOpen).

    What it does NOT do:
      * no admin rights, no HKLM, no registry policies, no ExtensionInstallForcelist;
      * no silent "Load unpacked" (Chrome/Edge do not allow it for off-store extensions);
      * no network access, no telemetry, no downloads;
      * never touches the browser profile, its vault, or user documents.

    Compatible with Windows PowerShell 5.1 only (no PS7-only syntax).
#>
[CmdletBinding()]
param(
    [string]$InstallRoot = '',
    [ValidateSet('Auto', 'Edge', 'Chrome', 'None')]
    [string]$Browser = 'Auto',
    [switch]$NoOpen,
    [switch]$NoShortcuts,
    [string]$PayloadZip = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# The installer UI contains Cyrillic text. Use UTF-8 for console output so it
# renders correctly in Windows Terminal, cmd.exe with chcp 65001 and pipes.
try {
    $utf8Console = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $utf8Console
    $OutputEncoding = $utf8Console
} catch { }

$script:ProductName = 'DocsMasked Relay'
$script:ShortcutFolderName = 'DocsMasked Relay'
$script:ExtensionDir = $null
$script:BrowserInfo = $null

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[DocsMasked Relay] $Message"
}

function Write-WarningLine {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Warning $Message
}

function Show-MessageBox {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Title,
        [int]$Icon = 64
    )
    try {
        $wsh = New-Object -ComObject WScript.Shell
        [void]$wsh.Popup($Text, 0, $Title, $Icon)
    } catch {
        # A message box is a convenience; never fail the installation because of it.
    }
}

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

function Get-ManifestValue {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Test-ExtensionPayload {
    param([Parameter(Mandatory = $true)][string]$Path)

    $manifestPath = Join-Path $Path 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "В payload нет manifest.json (ожидался $manifestPath). Пакет повреждён или собран неправильно."
    }

    try {
        $raw = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8
        $manifest = $raw | ConvertFrom-Json
    } catch {
        throw "Не удалось прочитать manifest.json: $($_.Exception.Message)"
    }

    $manifestVersion = Get-ManifestValue -Object $manifest -Name 'manifest_version'
    if ($manifestVersion -ne 3) {
        throw "manifest.json должен иметь manifest_version = 3, найдено: $manifestVersion"
    }

    $name = [string](Get-ManifestValue -Object $manifest -Name 'name')
    $version = [string](Get-ManifestValue -Object $manifest -Name 'version')
    if ([string]::IsNullOrWhiteSpace($name)) {
        throw 'В manifest.json отсутствует name.'
    }
    if ([string]::IsNullOrWhiteSpace($version)) {
        throw 'В manifest.json отсутствует version.'
    }

    # Validate the entry points that the manifest points at, so a broken build
    # fails before the old working extension is replaced.
    $relativePaths = New-Object System.Collections.Generic.List[string]
    $background = Get-ManifestValue -Object $manifest -Name 'background'
    if ($null -ne $background) {
        $serviceWorker = Get-ManifestValue -Object $background -Name 'service_worker'
        if (-not [string]::IsNullOrWhiteSpace([string]$serviceWorker)) {
            $relativePaths.Add([string]$serviceWorker)
        }
    }
    $action = Get-ManifestValue -Object $manifest -Name 'action'
    if ($null -ne $action) {
        $popup = Get-ManifestValue -Object $action -Name 'default_popup'
        if (-not [string]::IsNullOrWhiteSpace([string]$popup)) {
            $relativePaths.Add([string]$popup)
        }
    }
    $optionsUi = Get-ManifestValue -Object $manifest -Name 'options_ui'
    if ($null -ne $optionsUi) {
        $optionsPage = Get-ManifestValue -Object $optionsUi -Name 'page'
        if (-not [string]::IsNullOrWhiteSpace([string]$optionsPage)) {
            $relativePaths.Add([string]$optionsPage)
        }
    }

    foreach ($relativePath in $relativePaths) {
        $candidate = Join-Path $Path $relativePath
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "manifest.json ссылается на отсутствующий файл: $relativePath"
        }
    }

    return [pscustomobject]@{
        Name    = $name
        Version = $version
    }
}

function Find-BrowserExecutable {
    param(
        [Parameter(Mandatory = $true)][string]$ExecutableName,
        [Parameter(Mandatory = $true)][string[]]$KnownPaths,
        [Parameter(Mandatory = $true)][string]$RegistryName
    )

    foreach ($candidate in $KnownPaths) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [string]$candidate
        }
    }

    $registryKeys = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$RegistryName",
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$RegistryName",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\$RegistryName"
    )
    foreach ($registryKey in $registryKeys) {
        try {
            $item = Get-ItemProperty -LiteralPath $registryKey -ErrorAction Stop
            $defaultProperty = $item.PSObject.Properties | Where-Object { $_.Name -eq '(default)' } | Select-Object -First 1
            if ($null -ne $defaultProperty) {
                $value = [string]$defaultProperty.Value
                if (-not [string]::IsNullOrWhiteSpace($value) -and (Test-Path -LiteralPath $value -PathType Leaf)) {
                    return $value
                }
            }
        } catch {
            # Missing App Paths key is normal.
        }
    }

    return $null
}

function Get-BrowserInfo {
    param([Parameter(Mandatory = $true)][string]$Requested)

    if ($Requested -eq 'None') { return $null }

    $edgePaths = @()
    $chromePaths = @()
    if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
        $edgePaths += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
        $chromePaths += (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
    }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $edgePaths += (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
        $chromePaths += (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $edgePaths += (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
        $chromePaths += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    }

    $edgeExe = Find-BrowserExecutable -ExecutableName 'msedge.exe' -KnownPaths $edgePaths -RegistryName 'msedge.exe'
    $chromeExe = Find-BrowserExecutable -ExecutableName 'chrome.exe' -KnownPaths $chromePaths -RegistryName 'chrome.exe'

    if ($Requested -eq 'Edge') {
        if ($null -eq $edgeExe) {
            Write-WarningLine 'Microsoft Edge не найден. Файлы расширения будут установлены, но страницу edge://extensions/ придётся открыть вручную.'
            return $null
        }
        return [pscustomobject]@{ Name = 'Edge'; ExePath = $edgeExe; Url = 'edge://extensions/' }
    }

    if ($Requested -eq 'Chrome') {
        if ($null -eq $chromeExe) {
            Write-WarningLine 'Google Chrome не найден. Файлы расширения будут установлены, но страницу chrome://extensions/ придётся открыть вручную.'
            return $null
        }
        return [pscustomobject]@{ Name = 'Chrome'; ExePath = $chromeExe; Url = 'chrome://extensions/' }
    }

    # Auto: Edge ships with Windows, so prefer it, then Chrome.
    if ($null -ne $edgeExe) {
        return [pscustomobject]@{ Name = 'Edge'; ExePath = $edgeExe; Url = 'edge://extensions/' }
    }
    if ($null -ne $chromeExe) {
        return [pscustomobject]@{ Name = 'Chrome'; ExePath = $chromeExe; Url = 'chrome://extensions/' }
    }
    Write-WarningLine 'Ни Edge, ни Chrome не найдены. Файлы расширения будут установлены; браузер откройте вручную.'
    return $null
}

function New-Shortcut {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [string]$Arguments = '',
        [string]$WorkingDirectory = '',
        [string]$Description = '',
        [string]$IconLocation = ''
    )

    $wsh = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut($Path)
    $shortcut.TargetPath = $TargetPath
    if ($Arguments -ne '') { $shortcut.Arguments = $Arguments }
    if ($WorkingDirectory -ne '') { $shortcut.WorkingDirectory = $WorkingDirectory }
    if ($Description -ne '') { $shortcut.Description = $Description }
    if ($IconLocation -ne '') { $shortcut.IconLocation = $IconLocation }
    $shortcut.Save()
}

function Create-Shortcuts {
    param(
        [Parameter(Mandatory = $true)][string]$ExtensionPath,
        [Parameter(Mandatory = $true)][string]$RootPath,
        $BrowserInfo
    )

    $startMenuPrograms = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    if (-not (Test-Path -LiteralPath $startMenuPrograms -PathType Container)) {
        New-Item -ItemType Directory -Path $startMenuPrograms -Force | Out-Null
    }
    $shortcutFolder = Join-Path $startMenuPrograms $script:ShortcutFolderName
    if (-not (Test-Path -LiteralPath $shortcutFolder -PathType Container)) {
        New-Item -ItemType Directory -Path $shortcutFolder -Force | Out-Null
    }

    $created = New-Object System.Collections.Generic.List[string]
    $explorerExe = Join-Path $env:WINDIR 'explorer.exe'
    $powershellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

    $folderShortcut = Join-Path $shortcutFolder 'Открыть папку расширения.lnk'
    New-Shortcut -Path $folderShortcut -TargetPath $explorerExe `
        -Arguments ('"{0}"' -f $ExtensionPath) -WorkingDirectory $ExtensionPath `
        -Description 'Папка с распакованным расширением DocsMasked Relay' `
        -IconLocation (Join-Path $env:WINDIR 'System32\shell32.dll,3')
    $created.Add($folderShortcut)

    if ($null -ne $BrowserInfo) {
        $browserShortcut = Join-Path $shortcutFolder ('Открыть страницы расширений {0}.lnk' -f $BrowserInfo.Name)
        New-Shortcut -Path $browserShortcut -TargetPath $BrowserInfo.ExePath `
            -Arguments $BrowserInfo.Url -WorkingDirectory (Split-Path -Parent $BrowserInfo.ExePath) `
            -Description ('Открыть {0} и включить расширение' -f $BrowserInfo.Url)
        $created.Add($browserShortcut)
    }

    $uninstallShortcut = Join-Path $shortcutFolder 'Удалить DocsMasked Relay.lnk'
    $uninstallScript = Join-Path $RootPath 'uninstall.ps1'
    New-Shortcut -Path $uninstallShortcut -TargetPath $powershellExe `
        -Arguments ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $uninstallScript) `
        -WorkingDirectory $RootPath `
        -Description 'Удалить файлы DocsMasked Relay (расширение в браузере удаляется отдельно)' `
        -IconLocation (Join-Path $env:WINDIR 'System32\shell32.dll,131')
    $created.Add($uninstallShortcut)

    return $created.ToArray()
}

function Get-InstructionsText {
    param(
        [Parameter(Mandatory = $true)][string]$ExtensionPath,
        [Parameter(Mandatory = $true)][string]$Version,
        $BrowserInfo
    )

    $browserLine = 'Edge: edge://extensions/   |   Chrome: chrome://extensions/'
    if ($null -ne $BrowserInfo) {
        $browserLine = '{0}: {1}' -f $BrowserInfo.Name, $BrowserInfo.Url
    }

    $lines = @(
        ('DocsMasked Relay {0} - инструкция по включению' -f $Version),
        '',
        'Chrome и Edge не разрешают автоматически включать расширения, установленные не из магазина.',
        'Поэтому последний шаг выполняется вручную (это не ошибка установки).',
        '',
        '1. Откройте страницу расширений:',
        ('   {0}' -f $browserLine),
        '',
        '2. Включите "Режим разработчика" (Developer mode).',
        '3. Нажмите "Загрузить распакованное расширение" (Load unpacked).',
        '4. Выберите папку:',
        ('   {0}' -f $ExtensionPath),
        '5. Убедитесь, что расширение DocsMasked Relay включено, и закрепите его иконку на панели.',
        '',
        'Обновление: запустите новый установщик, затем нажмите "Обновить" (Reload) у расширения',
        'на странице расширений. Папка остаётся той же.',
        '',
        'Удаление: ярлык "Удалить DocsMasked Relay" в меню Пуск, затем удалите расширение',
        ('на странице {0}. Vault и данные расширения хранятся в профиле браузера и' -f $browserLine),
        'этим установщиком не удаляются.',
        '',
        'Установщик не подписан. SmartScreen может предупредить при запуске exe:',
        'запускайте файл только из источника, которому доверяете.',
        '',
        'Установщик не использует сеть, не пишет в HKLM и не меняет политики браузера.'
    )
    return ($lines -join [Environment]::NewLine)
}

function Open-BrowserExtensionsPage {
    param($BrowserInfo)
    if ($null -eq $BrowserInfo) { return }
    try {
        Start-Process -FilePath $BrowserInfo.ExePath -ArgumentList $BrowserInfo.Url | Out-Null
    } catch {
        Write-WarningLine ("Не удалось открыть {0}: {1}. Откройте страницу вручную." -f $BrowserInfo.Url, $_.Exception.Message)
    }
}

function Open-ExtensionFolder {
    param([Parameter(Mandatory = $true)][string]$ExtensionPath)
    try {
        Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList ('"{0}"' -f $ExtensionPath) | Out-Null
    } catch {
        Write-WarningLine ("Не удалось открыть Explorer: {0}" -f $_.Exception.Message)
    }
}

function Invoke-Install {
    # Environment overrides make the IExpress exe testable, because IExpress does
    # not forward command-line arguments to the packaged application.
    if (-not $PSBoundParameters.ContainsKey('InstallRoot') -and -not [string]::IsNullOrWhiteSpace($env:DMRELAY_INSTALL_ROOT)) {
        $InstallRoot = $env:DMRELAY_INSTALL_ROOT
    }
    if (-not $PSBoundParameters.ContainsKey('Browser') -and -not [string]::IsNullOrWhiteSpace($env:DMRELAY_BROWSER)) {
        if (@('Auto', 'Edge', 'Chrome', 'None') -notcontains $env:DMRELAY_BROWSER) {
            throw "DMRELAY_BROWSER должен быть Auto, Edge, Chrome или None."
        }
        $Browser = $env:DMRELAY_BROWSER
    }
    if (-not $NoOpen -and $env:DMRELAY_NO_OPEN -eq '1') { $NoOpen = $true }
    if (-not $NoShortcuts -and $env:DMRELAY_NO_SHORTCUTS -eq '1') { $NoShortcuts = $true }

    if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
        $InstallRoot = Join-Path $env:LOCALAPPDATA 'DocsMaskedRelay'
    }
    $InstallRoot = Resolve-FullPath -Path $InstallRoot -ParameterName 'InstallRoot'
    Assert-SafeInstallRoot -Path $InstallRoot
    $script:InstallRoot = $InstallRoot

    if ([string]::IsNullOrWhiteSpace($PayloadZip)) {
        $PayloadZip = Join-Path $PSScriptRoot 'payload.zip'
    }
    $PayloadZip = Resolve-FullPath -Path $PayloadZip -ParameterName 'PayloadZip'
    if (-not (Test-Path -LiteralPath $PayloadZip -PathType Leaf)) {
        throw "Не найден payload.zip: $PayloadZip. Соберите установщик через installer\build-installer.ps1 или распакуйте portable zip целиком."
    }
    if ((Get-Item -LiteralPath $PayloadZip).Length -le 0) {
        throw "payload.zip пуст: $PayloadZip"
    }

    $uninstallSource = Join-Path $PSScriptRoot 'uninstall.ps1'
    if (-not (Test-Path -LiteralPath $uninstallSource -PathType Leaf)) {
        throw "Рядом с install.ps1 нет uninstall.ps1 ($uninstallSource). Пакет установщика неполный."
    }

    $source = 'portable-zip'
    if ($env:DMRELAY_SOURCE -eq 'iexpress' -or $PayloadZip -match '(?i)[\\/]IXP[0-9A-F]+\.TMP[\\/]') {
        $source = 'iexpress-self-extracting'
    }

    $payloadHash = (Get-FileHash -LiteralPath $PayloadZip -Algorithm SHA256).Hash.ToLowerInvariant()

    Write-Host ''
    Write-Host '============================================================'
    Write-Host ("  {0} - установка" -f $script:ProductName)
    Write-Host '============================================================'
    Write-Host ("  Папка установки: {0}" -f $InstallRoot)
    Write-Host '  Права администратора не нужны, сеть не используется.'
    Write-Host '  Установщик не подписан: SmartScreen может показать предупреждение.'
    Write-Host '  Запускайте файл только из источника, которому доверяете.'
    Write-Host ''

    if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    }

    $newDir = Join-Path $InstallRoot 'extension.new'
    if (Test-Path -LiteralPath $newDir) {
        Write-Step 'Удаляю незавершённую распаковку предыдущего запуска...'
        Remove-Item -LiteralPath $newDir -Recurse -Force
    }

    Write-Step 'Распаковываю расширение во временную папку...'
    try {
        Expand-Archive -LiteralPath $PayloadZip -DestinationPath $newDir -Force
    } catch {
        throw "Не удалось распаковать payload.zip: $($_.Exception.Message). Проверьте свободное место и антивирус."
    }

    Write-Step 'Проверяю manifest.json (MV3, name, version, entry points)...'
    $manifestInfo = Test-ExtensionPayload -Path $newDir

    $extensionDir = Join-Path $InstallRoot 'extension'
    $backupDir = $null
    $swapped = $false

    try {
        if (Test-Path -LiteralPath $extensionDir -PathType Container) {
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            $backupDir = Join-Path $InstallRoot ("extension.old-{0}" -f $stamp)
            if (Test-Path -LiteralPath $backupDir) {
                $backupDir = Join-Path $InstallRoot ("extension.old-{0}-{1}" -f $stamp, [guid]::NewGuid().ToString('N').Substring(0, 8))
            }
            Write-Step 'Сохраняю предыдущую версию и заменяю extension...'
            Move-Item -LiteralPath $extensionDir -Destination $backupDir
        } else {
            Write-Step 'Устанавливаю extension...'
        }
        Move-Item -LiteralPath $newDir -Destination $extensionDir
        $swapped = $true
    } catch {
        if (-not $swapped -and $null -ne $backupDir -and (Test-Path -LiteralPath $backupDir) -and -not (Test-Path -LiteralPath $extensionDir)) {
            try {
                Move-Item -LiteralPath $backupDir -Destination $extensionDir
                Write-WarningLine 'Новая версия не установлена; предыдущая версия восстановлена.'
            } catch {
                Write-WarningLine ("Не удалось автоматически восстановить предыдущую версию: {0}" -f $_.Exception.Message)
            }
        }
        throw "Не удалось заменить папку extension: $($_.Exception.Message). Закройте браузер и повторите запуск."
    }

    $script:ExtensionDir = $extensionDir
    $script:InstalledByThisRun = $true

    Write-Step 'Копирую uninstall.ps1 и инструкцию...'
    Copy-Item -LiteralPath $uninstallSource -Destination (Join-Path $InstallRoot 'uninstall.ps1') -Force
    $uninstallCmdSource = Join-Path $PSScriptRoot 'uninstall.cmd'
    if (Test-Path -LiteralPath $uninstallCmdSource -PathType Leaf) {
        Copy-Item -LiteralPath $uninstallCmdSource -Destination (Join-Path $InstallRoot 'uninstall.cmd') -Force
    }

    $instructionsSource = Join-Path $PSScriptRoot 'INSTALL-INSTRUCTIONS.txt'
    $instructionsPath = Join-Path $InstallRoot 'INSTALL-INSTRUCTIONS.txt'
    if (Test-Path -LiteralPath $instructionsSource -PathType Leaf) {
        $template = Get-Content -LiteralPath $instructionsSource -Raw -Encoding UTF8
        $browserUrl = 'edge://extensions/ или chrome://extensions/'
        if ($Browser -eq 'Edge') { $browserUrl = 'edge://extensions/' }
        if ($Browser -eq 'Chrome') { $browserUrl = 'chrome://extensions/' }
        if ($null -ne $script:BrowserInfo) { $browserUrl = [string]$script:BrowserInfo.Url }
        $text = $template.Replace('{{VERSION}}', $manifestInfo.Version)
        $text = $text.Replace('{{EXTENSION_PATH}}', $extensionDir)
        $text = $text.Replace('{{BROWSER_URL}}', $browserUrl)
        [System.IO.File]::WriteAllText($instructionsPath, $text, (New-Object System.Text.UTF8Encoding($false)))
    } else {
        $text = Get-InstructionsText -ExtensionPath $extensionDir -Version $manifestInfo.Version -BrowserInfo $Browser
        [System.IO.File]::WriteAllText($instructionsPath, $text, (New-Object System.Text.UTF8Encoding($false)))
    }

    $script:BrowserInfo = Get-BrowserInfo -Requested $Browser
    $shortcutList = @()
    if ($NoShortcuts) {
        Write-Step 'Ярлыки пропущены (-NoShortcuts).'
    } else {
        Write-Step 'Создаю ярлыки в меню Пуск (только для текущего пользователя)...'
        try {
            $shortcutList = @(Create-Shortcuts -ExtensionPath $extensionDir -RootPath $InstallRoot -BrowserInfo $script:BrowserInfo)
        } catch {
            Write-WarningLine ("Не удалось создать ярлыки: {0}. Установка продолжится; ярлыки можно создать вручную." -f $_.Exception.Message)
        }
    }

    $installedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $browserName = 'None'
    if ($null -ne $script:BrowserInfo) { $browserName = [string]$script:BrowserInfo.Name }
    $meta = [ordered]@{
        schemaVersion = 1
        name          = $manifestInfo.Name
        version       = $manifestInfo.Version
        installedAt   = $installedAt
        source        = $source
        payloadSha256 = $payloadHash
        installRoot   = $InstallRoot
        extensionPath = $extensionDir
        browser       = $browserName
        shortcuts     = @($shortcutList)
    }
    $json = $meta | ConvertTo-Json -Depth 4
    $tempJson = Join-Path $InstallRoot 'install.json.tmp'
    $installJson = Join-Path $InstallRoot 'install.json'
    [System.IO.File]::WriteAllText($tempJson, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tempJson -Destination $installJson -Force

    # Keep only the newest previous-version backup; older backups are copies of
    # our own payload, never user data.
    if ($null -ne $backupDir) {
        Get-ChildItem -LiteralPath $InstallRoot -Directory -Filter 'extension.old-*' -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -ne $backupDir } |
            ForEach-Object {
                try { Remove-Item -LiteralPath $_.FullName -Recurse -Force } catch { }
            }
    }

    Write-Host ''
    Write-Host ("Готово: {0} {1}" -f $manifestInfo.Name, $manifestInfo.Version)
    Write-Host ("Папка расширения: {0}" -f $extensionDir)
    Write-Host ("Метаданные:      {0}" -f $installJson)
    Write-Host ("Инструкция:      {0}" -f $instructionsPath)
    Write-Host ''
    Write-Host 'Chrome/Edge не разрешают включить off-store расширение без участия пользователя.'
    Write-Host 'Последний шаг выполняется вручную на странице расширений:'
    Write-Host '  1) включите Developer mode;'
    Write-Host '  2) нажмите Load unpacked;'
    Write-Host ("  3) выберите папку {0};" -f $extensionDir)
    Write-Host '  4) закрепите иконку DocsMasked Relay на панели.'
    Write-Host ''

    if (-not $NoOpen) {
        Open-BrowserExtensionsPage -BrowserInfo $script:BrowserInfo
        Open-ExtensionFolder -ExtensionPath $extensionDir
        $browserHint = 'Edge/Chrome: edge://extensions/ или chrome://extensions/'
        if ($null -ne $script:BrowserInfo) {
            $browserHint = '{0}: {1}' -f $script:BrowserInfo.Name, $script:BrowserInfo.Url
        }
        $popup = @(
            ("DocsMasked Relay {0} установлен." -f $manifestInfo.Version),
            '',
            'Chrome и Edge не разрешают автоматически включать расширения не из магазина.',
            'Остался один ручной шаг:',
            '',
            ('1. Откройте {0}' -f $browserHint),
            '2. Включите Developer mode (Режим разработчика).',
            '3. Нажмите Load unpacked (Загрузить распакованное расширение).',
            '4. Выберите папку:',
            ("   {0}" -f $extensionDir),
            '5. Закрепите иконку расширения на панели.',
            '',
            'Подробная инструкция: INSTALL-INSTRUCTIONS.txt в папке установки.',
            'Установщик не подписан (SmartScreen). Запускайте только доверенные файлы.'
        ) -join [Environment]::NewLine
        Show-MessageBox -Text $popup -Title $script:ProductName
    }
}

try {
    Invoke-Install
    exit 0
} catch {
    $message = $_.Exception.Message
    Write-Host ''
    Write-Host 'ОШИБКА УСТАНОВКИ' -ForegroundColor Red
    Write-Host $message -ForegroundColor Red
    Write-Host ''
    Write-Host 'Что можно сделать:'
    Write-Host '  * закройте браузер и повторите запуск;'
    Write-Host '  * проверьте свободное место и права на папку установки;'
    Write-Host '  * при повторной ошибке удалите папку extension.new в каталоге установки.'
    Write-Host ("  * каталог установки: {0}" -f $script:InstallRoot)
    if (-not $NoOpen) {
        Show-MessageBox -Text ("Не удалось установить DocsMasked Relay.`r`n`r`n{0}`r`n`r`nПодробности — в окне установщика." -f $message) -Title 'DocsMasked Relay - ошибка' -Icon 16
    }
    exit 1
}
