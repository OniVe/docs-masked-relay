#requires -Version 5.1
<#
    DocsMasked Relay - Windows installer builder.

    Produces:
      installer\dist\DocsMaskedRelay-Setup-<version>.exe   (IExpress self-extractor)
      installer\dist\DocsMaskedRelay-Portable-<version>.zip
      installer\dist\payload.zip
      installer\dist\SHA256SUMS

    The exe is unsigned. It is a plain IExpress wrapper around install.cmd,
    install.ps1, uninstall.ps1, uninstall.cmd and payload.zip. The installer
    itself never downloads anything and never asks for administrator rights.

    Windows PowerShell 5.1 compatible.
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$SkipExe,
    [switch]$Rebuild,
    [string]$OutputDir = ''
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

$script:ScriptDir = $PSScriptRoot
$script:RepoRoot = Split-Path -Parent $script:ScriptDir
$script:ExtensionDir = Join-Path $script:RepoRoot 'extension'
$script:BuildDir = Join-Path $script:ExtensionDir '.output\chrome-mv3'
$script:StagingDir = Join-Path $script:ScriptDir 'staging'
$script:DistDir = if ([string]::IsNullOrWhiteSpace($OutputDir)) { Join-Path $script:ScriptDir 'dist' } else { [System.IO.Path]::GetFullPath($OutputDir) }

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[build] $Message"
}

function New-CleanDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Get-LatestSourceTime {
    $sources = @(
        (Join-Path $script:ExtensionDir 'entrypoints'),
        (Join-Path $script:ExtensionDir 'src'),
        (Join-Path $script:ExtensionDir 'public'),
        (Join-Path $script:ExtensionDir 'wxt.config.ts'),
        (Join-Path $script:ExtensionDir 'package.json'),
        (Join-Path $script:ExtensionDir 'tsconfig.json'),
        (Join-Path $script:ExtensionDir 'bun.lock')
    )
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($source in $sources) {
        if (-not (Test-Path -LiteralPath $source)) { continue }
        if (Test-Path -LiteralPath $source -PathType Container) {
            Get-ChildItem -LiteralPath $source -Recurse -File -ErrorAction SilentlyContinue |
                ForEach-Object { $items.Add($_) }
        } else {
            $items.Add((Get-Item -LiteralPath $source))
        }
    }
    if ($items.Count -eq 0) { return [datetime]::MinValue }
    return ($items | Measure-Object -Property LastWriteTime -Maximum).Maximum
}

function Test-Manifest {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Не найден manifest.json: $Path"
    }
    $manifest = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.manifest_version -ne 3) {
        throw "manifest_version должен быть 3, найдено: $($manifest.manifest_version)"
    }
    $name = [string]$manifest.name
    $version = [string]$manifest.version
    if ([string]::IsNullOrWhiteSpace($name)) { throw 'В manifest.json отсутствует name.' }
    if ([string]::IsNullOrWhiteSpace($version)) { throw 'В manifest.json отсутствует version.' }
    return [pscustomobject]@{ Name = $name; Version = $version; Manifest = $manifest }
}

function Test-PayloadZip {
    param(
        [Parameter(Mandatory = $true)][string]$ZipPath,
        [Parameter(Mandatory = $true)][int]$ExpectedFileCount
    )
    if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
        throw "payload.zip не создан: $ZipPath"
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $names = @($archive.Entries | ForEach-Object { $_.FullName })
        if ($names -notcontains 'manifest.json') {
            throw 'payload.zip не содержит manifest.json в корне.'
        }
        $fileEntries = @($archive.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) })
        if ($fileEntries.Count -ne $ExpectedFileCount) {
            throw ("payload.zip содержит {0} файлов, ожидалось {1}." -f $fileEntries.Count, $ExpectedFileCount)
        }
    } finally {
        $archive.Dispose()
    }
}

function Get-ShortPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $needsShortening = ($Path -notmatch '^[\x00-\x7F]+$') -or ($Path -match ' ')
    if (-not $needsShortening) { return $Path }
    try {
        if (-not ('Win32ShortPath.NativeMethods' -as [type])) {
            Add-Type -Namespace Win32ShortPath -Name NativeMethods -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern uint GetShortPathName(string longPath, System.Text.StringBuilder shortPath, uint bufferLength);
'@
        }
        $buffer = New-Object System.Text.StringBuilder 4096
        $length = [Win32ShortPath.NativeMethods]::GetShortPathName($Path, $buffer, 4096)
        if ($length -gt 0 -and $length -lt 4096) {
            return $buffer.ToString()
        }
    } catch {
        Write-Warning ("Не удалось получить короткий путь для {0}: {1}" -f $Path, $_.Exception.Message)
    }
    return $Path
}

function New-PayloadZip {
    param(
        [Parameter(Mandatory = $true)][string]$SourceDir,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $SourceDir,
        $Destination,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )
}

function New-ZipFromDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$SourceDir,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][bool]$IncludeBaseDirectory
    )
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $SourceDir,
        $Destination,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $IncludeBaseDirectory
    )
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text
    )
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-BuildInstaller {
    if (-not (Test-Path -LiteralPath $script:ExtensionDir -PathType Container)) {
        throw "Не найдена папка extension: $script:ExtensionDir"
    }

    $manifestPath = Join-Path $script:BuildDir 'manifest.json'
    $needBuild = $false
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        $needBuild = $true
    } elseif (-not $SkipBuild) {
        $latestSource = Get-LatestSourceTime
        $manifestTime = (Get-Item -LiteralPath $manifestPath).LastWriteTime
        if ($Rebuild -or $latestSource -gt $manifestTime.AddSeconds(2)) {
            $needBuild = $true
        }
    }

    if ($SkipBuild -and -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "-SkipBuild указан, но сборки нет: $manifestPath. Сначала выполните bun run build в extension."
    }

    if ($needBuild) {
        Write-Step 'Сборка расширения: bun run build...'
        $bun = Get-Command bun -ErrorAction SilentlyContinue
        if ($null -eq $bun) {
            throw 'bun не найден в PATH. Установите Bun 1.4+ или соберите расширение вручную: cd extension; bun run build.'
        }
        if (-not (Test-Path -LiteralPath (Join-Path $script:ExtensionDir 'node_modules') -PathType Container)) {
            throw 'В extension нет node_modules. Выполните: cd extension; bun install (нужна сеть только для сборки, не для установщика).'
        }
        Push-Location -LiteralPath $script:ExtensionDir
        try {
            & $bun.Source run build
            if ($LASTEXITCODE -ne 0) {
                throw "bun run build завершился с кодом $LASTEXITCODE."
            }
        } finally {
            Pop-Location
        }
    } else {
        Write-Step 'Использую существующую сборку extension\.output\chrome-mv3.'
    }

    $manifestInfo = Test-Manifest -Path $manifestPath
    $version = $manifestInfo.Version
    $safeVersion = ($version -replace '[^0-9A-Za-z\.\-]', '-')
    if ([string]::IsNullOrWhiteSpace($safeVersion)) {
        throw "Некорректная версия manifest.json: '$version'"
    }

    $distPath = $script:DistDir
    if (-not (Test-Path -LiteralPath $distPath -PathType Container)) {
        New-Item -ItemType Directory -Path $distPath -Force | Out-Null
    }
    # dist is a build-output directory. Remove previous self-extractors and
    # portable zips so a renamed version or a failed build cannot leave stale
    # artifacts that would then be hashed and handed out.
    Get-ChildItem -LiteralPath $distPath -File -Filter 'DocsMaskedRelay-Setup-*.exe' -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
    Get-ChildItem -LiteralPath $distPath -File -Filter 'DocsMaskedRelay-Portable-*.zip' -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
    $stagingPath = $script:StagingDir
    New-CleanDirectory -Path $stagingPath

    $payloadDir = Join-Path $stagingPath 'payload'
    New-Item -ItemType Directory -Path $payloadDir -Force | Out-Null
    Write-Step 'Копирую собранное расширение в staging\payload...'
    Get-ChildItem -LiteralPath $script:BuildDir -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $payloadDir -Recurse -Force
    }

    $sourceFiles = @(Get-ChildItem -LiteralPath $payloadDir -Recurse -File)
    if ($sourceFiles.Count -eq 0) {
        throw "Сборка расширения пуста: $script:BuildDir"
    }
    Test-Manifest -Path (Join-Path $payloadDir 'manifest.json') | Out-Null

    $payloadZip = Join-Path $stagingPath 'payload.zip'
    Write-Step ("Упаковываю payload.zip ({0} файлов)..." -f $sourceFiles.Count)
    New-PayloadZip -SourceDir $payloadDir -Destination $payloadZip
    Test-PayloadZip -ZipPath $payloadZip -ExpectedFileCount $sourceFiles.Count

    $packageDir = Join-Path $stagingPath 'package'
    New-Item -ItemType Directory -Path $packageDir -Force | Out-Null
    $packageFiles = @(
        'install.ps1',
        'install.cmd',
        'uninstall.ps1',
        'uninstall.cmd',
        'INSTALL-INSTRUCTIONS.txt'
    )
    foreach ($fileName in $packageFiles) {
        $source = Join-Path (Join-Path $script:ScriptDir 'src') $fileName
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Не найден обязательный файл установщика: $source"
        }
        Copy-Item -LiteralPath $source -Destination (Join-Path $packageDir $fileName) -Force
    }
    Copy-Item -LiteralPath $payloadZip -Destination (Join-Path $packageDir 'payload.zip') -Force

    $readmePath = Join-Path $script:ScriptDir 'README.md'
    if (Test-Path -LiteralPath $readmePath -PathType Leaf) {
        Copy-Item -LiteralPath $readmePath -Destination (Join-Path $packageDir 'README.md') -Force
    }

    $portableName = "DocsMaskedRelay-Portable-{0}" -f $safeVersion
    $portableRoot = Join-Path (Join-Path $stagingPath 'portable') $portableName
    New-Item -ItemType Directory -Path $portableRoot -Force | Out-Null
    Get-ChildItem -LiteralPath $packageDir -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $portableRoot -Recurse -Force
    }
    $portableZip = Join-Path $distPath ($portableName + '.zip')
    Write-Step 'Создаю portable zip...'
    New-ZipFromDirectory -SourceDir $portableRoot -Destination $portableZip -IncludeBaseDirectory $true

    $distPayloadZip = Join-Path $distPath 'payload.zip'
    Copy-Item -LiteralPath $payloadZip -Destination $distPayloadZip -Force

    # IExpress does not preserve directory trees, so the extension itself travels
    # as a single payload.zip; install.ps1 extracts it into extension.new.
    $sedPath = Join-Path $stagingPath ("DocsMaskedRelay-Setup-{0}.sed" -f $safeVersion)
    $exeName = "DocsMaskedRelay-Setup-{0}.exe" -f $safeVersion
    $exePath = Join-Path $distPath $exeName
    $exeBuilt = $false
    $exeFailure = $null

    if ($SkipExe) {
        Write-Step 'IExpress пропущен (-SkipExe).'
    } else {
        Write-Step 'Генерирую IExpress SED...'
        $sedPackageDir = Get-ShortPath -Path $packageDir
        $sedDistDir = Get-ShortPath -Path $distPath
        if (-not $sedPackageDir.EndsWith('\')) { $sedPackageDir += '\' }
        $sedExePath = Join-Path $sedDistDir $exeName

        $sedFileNames = @(
            'install.cmd',
            'install.ps1',
            'uninstall.ps1',
            'uninstall.cmd',
            'INSTALL-INSTRUCTIONS.txt',
            'payload.zip'
        )
        if (Test-Path -LiteralPath (Join-Path $packageDir 'README.md') -PathType Leaf) {
            $sedFileNames += 'README.md'
        }

        $sed = New-Object System.Collections.Generic.List[string]
        $sed.Add('[Version]')
        $sed.Add('Class=IEXPRESS')
        $sed.Add('SEDVersion=3')
        $sed.Add('[Options]')
        $sed.Add('PackagePurpose=InstallApp')
        $sed.Add('ShowInstallProgramWindow=1')
        $sed.Add('HideExtractAnimation=0')
        $sed.Add('UseLongFileName=1')
        $sed.Add('InsideCompressed=0')
        $sed.Add('CAB_FixedSize=0')
        $sed.Add('CAB_ResvCodeSigning=0')
        $sed.Add('RebootMode=N')
        $sed.Add('InstallPrompt=%InstallPrompt%')
        $sed.Add('DisplayLicense=%DisplayLicense%')
        $sed.Add('FinishMessage=%FinishMessage%')
        $sed.Add('TargetName=%TargetName%')
        $sed.Add('FriendlyName=%FriendlyName%')
        $sed.Add('AppLaunched=%AppLaunched%')
        $sed.Add('PostInstallCmd=%PostInstallCmd%')
        $sed.Add('AdminQuietInstCmd=%AdminQuietInstCmd%')
        $sed.Add('UserQuietInstCmd=%UserQuietInstCmd%')
        $sed.Add('SourceFiles=SourceFiles')
        $sed.Add('[Strings]')
        $sed.Add('InstallPrompt=')
        $sed.Add('DisplayLicense=')
        $sed.Add('FinishMessage=')
        $sed.Add(('TargetName={0}' -f $sedExePath))
        $sed.Add('FriendlyName=DocsMasked Relay Setup')
        $sed.Add('AppLaunched=cmd.exe /c install.cmd')
        $sed.Add('PostInstallCmd=<None>')
        $sed.Add('AdminQuietInstCmd=')
        $sed.Add('UserQuietInstCmd=')
        for ($index = 0; $index -lt $sedFileNames.Count; $index++) {
            $sed.Add(('FILE{0}="{1}"' -f $index, $sedFileNames[$index]))
        }
        $sed.Add('[SourceFiles]')
        $sed.Add(('SourceFiles0={0}' -f $sedPackageDir))
        $sed.Add('[SourceFiles0]')
        for ($index = 0; $index -lt $sedFileNames.Count; $index++) {
            $sed.Add(('%FILE{0}%=' -f $index))
        }
        $sedText = ($sed -join "`r`n") + "`r`n"

        $ansiEncoding = [System.Text.Encoding]::Default
        $roundTrip = $ansiEncoding.GetString($ansiEncoding.GetBytes($sedText))
        if ($roundTrip -ne $sedText) {
            $exeFailure = 'IExpress SED не может быть представлен в системной ANSI-кодировке (путь содержит несовместимые символы).'
            Write-Warning $exeFailure
        } else {
            [System.IO.File]::WriteAllText($sedPath, $sedText, $ansiEncoding)
            $iexpress = Join-Path $env:SystemRoot 'System32\iexpress.exe'
            if (-not (Test-Path -LiteralPath $iexpress -PathType Leaf)) {
                $exeFailure = "IExpress не найден: $iexpress"
                Write-Warning $exeFailure
            } else {
                if (Test-Path -LiteralPath $exePath) { Remove-Item -LiteralPath $exePath -Force }
                Write-Step 'Запускаю IExpress (это может занять до минуты)...'
                $temporarySed = $null
                try {
                    # IExpress /N treats quotes as part of the SED path. Use an
                    # unquoted path; 8.3 shortening avoids spaces when needed.
                    $sedInvokePath = Get-ShortPath -Path $sedPath
                    if ($sedInvokePath -match ' ') {
                        $temporarySed = Join-Path ([System.IO.Path]::GetTempPath()) ("dmrelay-{0}.sed" -f [guid]::NewGuid().ToString('N'))
                        Copy-Item -LiteralPath $sedPath -Destination $temporarySed -Force
                        $sedInvokePath = Get-ShortPath -Path $temporarySed
                        if ($sedInvokePath -match ' ') {
                            throw "IExpress /N не поддерживает пробелы в пути к SED: $sedInvokePath"
                        }
                    }
                    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
                    $processInfo.FileName = $iexpress
                    $processInfo.Arguments = ('/N /Q {0}' -f $sedInvokePath)
                    $processInfo.UseShellExecute = $false
                    $processInfo.CreateNoWindow = $true
                    $process = [System.Diagnostics.Process]::Start($processInfo)
                    if (-not $process.WaitForExit(180000)) {
                        try { $process.Kill() } catch { }
                        throw 'IExpress не завершился за 180 секунд.'
                    }
                    $iexpressExitCode = $process.ExitCode
                    if ($iexpressExitCode -ne 0) {
                        throw "IExpress завершился с кодом $iexpressExitCode."
                    }

                    $deadline = (Get-Date).AddSeconds(45)
                    $lastSize = -1
                    $stableChecks = 0
                    while ((Get-Date) -lt $deadline) {
                        if (Test-Path -LiteralPath $exePath -PathType Leaf) {
                            $size = (Get-Item -LiteralPath $exePath).Length
                            if ($size -gt 0 -and $size -eq $lastSize) {
                                $stableChecks++
                            } else {
                                $stableChecks = 0
                            }
                            $lastSize = $size
                            if ($stableChecks -ge 2) { break }
                        }
                        Start-Sleep -Milliseconds 500
                    }

                    if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
                        throw "IExpress завершился без ошибки, но exe не появился: $exePath"
                    }
                    if ((Get-Item -LiteralPath $exePath).Length -lt 100000) {
                        throw "IExpress создал подозрительно маленький exe: $((Get-Item -LiteralPath $exePath).Length) байт."
                    }
                    $stream = [System.IO.File]::OpenRead($exePath)
                    try {
                        $header = New-Object byte[] 2
                        [void]$stream.Read($header, 0, 2)
                        if ($header[0] -ne 0x4D -or $header[1] -ne 0x5A) {
                            throw 'Созданный файл не является PE-исполняемым (нет сигнатуры MZ).'
                        }
                    } finally {
                        $stream.Dispose()
                    }
                    $exeBuilt = $true
                } catch {
                    $exeFailure = $_.Exception.Message
                    Write-Warning ("IExpress не смог собрать exe: {0}" -f $exeFailure)
                    if (Test-Path -LiteralPath $exePath) {
                        try { Remove-Item -LiteralPath $exePath -Force } catch { }
                    }
                } finally {
                    if ($null -ne $temporarySed -and (Test-Path -LiteralPath $temporarySed)) {
                        try { Remove-Item -LiteralPath $temporarySed -Force } catch { }
                    }
                }
            }
        }
    }

    $fallbackNote = Join-Path $distPath 'BUILD-FALLBACK.txt'
    if (-not $exeBuilt -and -not $SkipExe) {
        $note = @(
            'DocsMasked Relay: exe не собран, используйте portable zip.',
            '',
            ("Причина: {0}" -f $exeFailure),
            '',
            'Portable zip содержит те же файлы и работает без администратора:',
            ("  {0}" -f (Split-Path -Leaf $portableZip)),
            'Распакуйте его целиком и запустите install.cmd.',
            '',
            'Exe не подписан; при успешной сборке SmartScreen всё равно может предупредить.',
            'Ничего не публикуйте: это локальная сборка.'
        ) -join [Environment]::NewLine
        Write-Utf8NoBom -Path $fallbackNote -Text ($note + [Environment]::NewLine)
    } elseif (Test-Path -LiteralPath $fallbackNote) {
        Remove-Item -LiteralPath $fallbackNote -Force
    }

    $hashFiles = @(Get-ChildItem -LiteralPath $distPath -File | Where-Object { $_.Name -ne 'SHA256SUMS' -and $_.Name -ne 'BUILD-FALLBACK.txt' } | Sort-Object Name)
    $hashLines = New-Object System.Collections.Generic.List[string]
    foreach ($file in $hashFiles) {
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $hashLines.Add(('{0}  {1}' -f $hash, $file.Name))
    }
    $shaPath = Join-Path $distPath 'SHA256SUMS'
    Write-Utf8NoBom -Path $shaPath -Text (($hashLines -join "`r`n") + "`r`n")

    Write-Host ''
    Write-Host '============================================================'
    Write-Host ("  {0} {1}: сборка завершена" -f $manifestInfo.Name, $version)
    Write-Host '============================================================'
    foreach ($file in $hashFiles) {
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        Write-Host ("  {0}" -f $file.FullName)
        Write-Host ("    {0:N2} MB  SHA256 {1}" -f ($file.Length / 1MB), $hash)
    }
    Write-Host ("  SHA256SUMS: {0}" -f $shaPath)
    Write-Host ("  staging:    {0}" -f $stagingPath)
    Write-Host ''

    if ($exeBuilt) {
        Write-Host 'EXE: OK (IExpress, unsigned).'
    } elseif (-not $SkipExe) {
        Write-Host 'EXE: НЕ СОБРАН. Portable zip готов; подробности в BUILD-FALLBACK.txt.' -ForegroundColor Yellow
    }
    if ($SkipExe) {
        Write-Host 'EXE: пропущен по -SkipExe.'
    }
    Write-Host 'Ничего не публикуйте: сборка локальная и не подписана.'
    Write-Host ''
}

try {
    Invoke-BuildInstaller
    exit 0
} catch {
    Write-Host ''
    Write-Host 'ОШИБКА СБОРКИ' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ''
    Write-Host 'Проверьте: bun install в extension, свободное место, путь без несовместимых символов.'
    exit 1
}
