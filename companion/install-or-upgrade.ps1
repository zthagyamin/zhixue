param(
    [string]$PayloadRoot = $PSScriptRoot,
    [string]$TargetPath = "",
    [string]$BackupBasePath = "",
    [switch]$NonInteractive,
    [switch]$NoStart,
    [switch]$SkipSetup,
    [switch]$SkipRegistration
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PayloadRoot 'program-manifest.ps1')
$programFiles = @(Read-CompanionProgramFiles $PayloadRoot)

function Normalize-Directory([string]$PathValue) {
    return [System.IO.Path]::GetFullPath($PathValue).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}

function Test-CompanionRoot([string]$PathValue) {
    if ([string]::IsNullOrWhiteSpace($PathValue) -or -not (Test-Path -LiteralPath $PathValue -PathType Container)) {
        return $false
    }
    return (Test-Path -LiteralPath (Join-Path $PathValue "server.py")) -and
        (Test-Path -LiteralPath (Join-Path $PathValue "start-companion.ps1"))
}

function Get-RegisteredInstallLocation {
    $installKey = "HKCU:\Software\Zhixue\Companion"
    try {
        $registered = Get-ItemPropertyValue -LiteralPath $installKey -Name "InstallLocation" -ErrorAction Stop
        if (Test-CompanionRoot $registered) { return (Normalize-Directory $registered) }
    } catch {
        # Older portable versions did not write a dedicated install location.
    }

    try {
        $commandKey = "HKCU:\Software\Classes\zhixue-companion\shell\open\command"
        $command = (Get-Item -LiteralPath $commandKey -ErrorAction Stop).GetValue("")
        $match = [regex]::Match([string]$command, '-File\s+"(?<launcher>[^"]*start-companion\.ps1)"', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($match.Success) {
            $candidate = Split-Path -Parent $match.Groups["launcher"].Value
            if (Test-CompanionRoot $candidate) { return (Normalize-Directory $candidate) }
        }
    } catch {
        # Fall through to the safe user choice or the standard install folder.
    }

    return $null
}

function Select-LegacyInstallLocation([string]$DefaultPath) {
    if ($NonInteractive) { return $DefaultPath }

    try {
        Add-Type -AssemblyName System.Windows.Forms
        $choice = [System.Windows.Forms.MessageBox]::Show(
            "没有检测到已注册的 Companion。`n`n如果你以前安装过，请选择 [是] 并找到旧版文件夹；第一次安装请选择 [否]。",
            "知学 Companion 安装或更新",
            [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,
            [System.Windows.Forms.MessageBoxIcon]::Question
        )
        if ($choice -eq [System.Windows.Forms.DialogResult]::Cancel) { throw "用户取消安装。" }
        if ($choice -eq [System.Windows.Forms.DialogResult]::No) { return $DefaultPath }

        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = "请选择旧版 Companion 文件夹（其中应包含 server.py）"
        $dialog.ShowNewFolderButton = $false
        if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { throw "用户取消安装。" }
        if (-not (Test-CompanionRoot $dialog.SelectedPath)) { throw "所选文件夹不是有效的 Companion 目录。" }
        return (Normalize-Directory $dialog.SelectedPath)
    } catch [System.Management.Automation.RuntimeException] {
        throw
    } catch {
        Write-Host "没有检测到已注册的 Companion。"
        $legacy = Read-Host "如需更新旧版，请输入旧版文件夹完整路径；第一次安装直接回车"
        if ([string]::IsNullOrWhiteSpace($legacy)) { return $DefaultPath }
        if (-not (Test-CompanionRoot $legacy)) { throw "输入的文件夹不是有效的 Companion 目录。" }
        return (Normalize-Directory $legacy)
    }
}

function Assert-SafeInstallLocation([string]$PathValue) {
    $fullPath = Normalize-Directory $PathValue
    $rootPath = [System.IO.Path]::GetPathRoot($fullPath).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $profilePath = if ($env:USERPROFILE) { Normalize-Directory $env:USERPROFILE } else { "" }
    if ($fullPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar) -eq $rootPath -or
        ($profilePath -and $fullPath.Equals($profilePath, [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "出于安全考虑，不能把磁盘根目录或用户主目录作为 Companion 安装位置。"
    }
    return $fullPath
}

function Stop-InstalledCompanion([string]$InstallRoot) {
    $normalizedRoot = Normalize-Directory $InstallRoot
    $matching = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        ($_.Name -in @("python.exe", "pythonw.exe")) -and
        $_.CommandLine -and
        $_.CommandLine.IndexOf($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine.IndexOf("server.py", [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    foreach ($process in $matching) {
        Write-Host "正在关闭旧版 Companion…"
        # CPython's venv launcher and base interpreter can both appear in WMI.
        # Stopping one may terminate the other before this loop reaches it.
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if ($matching.Count -gt 0) { Start-Sleep -Milliseconds 800 }
}

function Copy-RelativeFile([string]$SourceRoot, [string]$DestinationRoot, [string]$RelativePath) {
    $source = Join-Path $SourceRoot $RelativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "安装包缺少文件：$RelativePath" }
    $destination = Join-Path $DestinationRoot $RelativePath
    $parent = Split-Path -Parent $destination
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item -LiteralPath $source -Destination $destination -Force
}

$payload = Normalize-Directory $PayloadRoot
if (-not (Test-Path -LiteralPath (Join-Path $payload "version.json") -PathType Leaf)) {
    throw "安装包不完整：缺少 version.json。"
}
$version = (Get-Content -Raw -LiteralPath (Join-Path $payload "version.json") | ConvertFrom-Json).version
$defaultTarget = Join-Path $env:LOCALAPPDATA "Zhixue Companion"

if ([string]::IsNullOrWhiteSpace($TargetPath)) {
    if ((Test-Path -LiteralPath (Join-Path $payload "config.local.json")) -or (Test-Path -LiteralPath (Join-Path $payload "data\study-loop.db"))) {
        $TargetPath = $payload
    } else {
        $TargetPath = Get-RegisteredInstallLocation
        if ([string]::IsNullOrWhiteSpace($TargetPath)) { $TargetPath = Select-LegacyInstallLocation $defaultTarget }
    }
}

$target = Assert-SafeInstallLocation $TargetPath
$targetExisted = Test-Path -LiteralPath $target -PathType Container
New-Item -ItemType Directory -Path $target -Force | Out-Null

$stagedPayload = $payload
$temporaryPayload = $null
$targetPrefix = $target + [System.IO.Path]::DirectorySeparatorChar
if (-not $payload.Equals($target, [System.StringComparison]::OrdinalIgnoreCase) -and
    $payload.StartsWith($targetPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    $temporaryPayload = Join-Path ([System.IO.Path]::GetTempPath()) ("zhixue-upgrade-payload-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $temporaryPayload -Force | Out-Null
    foreach ($relativePath in $programFiles) { Copy-RelativeFile $payload $temporaryPayload $relativePath }
    $stagedPayload = $temporaryPayload
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupBase = if ([string]::IsNullOrWhiteSpace($BackupBasePath)) {
    Join-Path $env:LOCALAPPDATA "Zhixue Companion Backups"
} else {
    Normalize-Directory $BackupBasePath
}
$backupRoot = Join-Path $backupBase $timestamp
$programBackup = Join-Path $backupRoot "program"
$userBackup = Join-Path $backupRoot "user-data"
$createdFiles = New-Object System.Collections.Generic.List[string]
$backupCreated = $false

try {
    Stop-InstalledCompanion $target

    if ($targetExisted) {
        New-Item -ItemType Directory -Path $programBackup -Force | Out-Null
        New-Item -ItemType Directory -Path $userBackup -Force | Out-Null
        foreach ($relativePath in $programFiles) {
            $existing = Join-Path $target $relativePath
            if (Test-Path -LiteralPath $existing -PathType Leaf) {
                Copy-RelativeFile $target $programBackup $relativePath
            } else {
                $createdFiles.Add($relativePath)
            }
        }
        $localConfig = Join-Path $target "config.local.json"
        if (Test-Path -LiteralPath $localConfig -PathType Leaf) {
            Copy-Item -LiteralPath $localConfig -Destination (Join-Path $userBackup "config.local.json") -Force
        }
        $localData = Join-Path $target "data"
        if (Test-Path -LiteralPath $localData -PathType Container) {
            Copy-Item -LiteralPath $localData -Destination $userBackup -Recurse -Force
        }
        $backupCreated = $true
    }

    if (-not $payload.Equals($target, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Host "正在安装知学 Companion $version…"
        foreach ($relativePath in $programFiles) { Copy-RelativeFile $stagedPayload $target $relativePath }
    }

    if (-not $SkipSetup) {
        & (Join-Path $target "setup-and-start.ps1") -NoStart -SkipRegistration:$SkipRegistration
        if ($LASTEXITCODE -ne 0) { throw "Companion 环境更新失败。" }
    }

    if (-not $SkipRegistration) {
        $installKey = "HKCU:\Software\Zhixue\Companion"
        New-Item -Path $installKey -Force | Out-Null
        New-ItemProperty -Path $installKey -Name "InstallLocation" -Value $target -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $installKey -Name "Version" -Value $version -PropertyType String -Force | Out-Null

        try {
            $startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut((Join-Path $startMenu "知学 Companion.lnk"))
            $shortcut.TargetPath = Join-Path $target "start-companion.cmd"
            $shortcut.WorkingDirectory = $target
            $shortcut.Description = "启动知学 Companion"
            $shortcut.Save()
        } catch {
            Write-Warning "未能创建开始菜单快捷方式，但 Companion 仍可正常使用。"
        }
    }

    Write-Host ""
    Write-Host "知学 Companion $version 已安装或更新完成。" -ForegroundColor Green
    if ($backupCreated) { Write-Host "旧版个人数据备份：$backupRoot" }
    if (-not $NoStart) {
        Start-Process -FilePath (Join-Path $target "start-companion.cmd") -WorkingDirectory $target
    }
} catch {
    Write-Host "安装或更新失败：$($_.Exception.Message)" -ForegroundColor Red
    if ($backupCreated) {
        Write-Host "正在恢复旧版程序和个人数据…"
        foreach ($relativePath in $createdFiles) {
            $created = Join-Path $target $relativePath
            if (Test-Path -LiteralPath $created -PathType Leaf) { Remove-Item -LiteralPath $created -Force }
        }
        foreach ($relativePath in $programFiles) {
            $saved = Join-Path $programBackup $relativePath
            if (Test-Path -LiteralPath $saved -PathType Leaf) { Copy-RelativeFile $programBackup $target $relativePath }
        }
        $savedConfig = Join-Path $userBackup "config.local.json"
        if (Test-Path -LiteralPath $savedConfig -PathType Leaf) {
            Copy-Item -LiteralPath $savedConfig -Destination (Join-Path $target "config.local.json") -Force
        }
        $savedData = Join-Path $userBackup "data"
        if (Test-Path -LiteralPath $savedData -PathType Container) {
            Copy-Item -LiteralPath $savedData -Destination $target -Recurse -Force
        }
        Write-Host "旧版文件已恢复。备份仍保留在：$backupRoot"
    } elseif (-not $targetExisted -and (Test-Path -LiteralPath $target) -and
        $target.StartsWith($env:LOCALAPPDATA, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Host "全新安装失败，正在清理残留目录…"
        Remove-Item -LiteralPath $target -Recurse -Force
        Write-Host "已清理 $target"
    }
    throw
} finally {
    if ($temporaryPayload -and (Test-Path -LiteralPath $temporaryPayload) -and
        $temporaryPayload.StartsWith([System.IO.Path]::GetTempPath(), [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $temporaryPayload -Recurse -Force
    }
}
