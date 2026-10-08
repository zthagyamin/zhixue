# Compatible with built-in Windows PowerShell 5.1 and PowerShell 7.
function Get-ZhixueChildPath([string]$Root, [string]$Relative) {
    $basePath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    if ([IO.Path]::IsPathRooted($Relative) -or $Relative.Contains(':') -or ($Relative -split '[\\/]' | Where-Object { $_ -in @('.', '..') })) { throw 'runtime-unsafe-path' }
    $path = [IO.Path]::GetFullPath((Join-Path $basePath $Relative))
    if (-not $path.StartsWith($basePath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'runtime-unsafe-path' }
    return $path
}

function Test-ZhixuePython([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        # stdin avoids the legacy PowerShell 5.1 native-argument quote rewriting.
        $probeCode = 'import sys,json,pypdf,keyring; from zoneinfo import ZoneInfo; assert sys.version_info >= (3,11); ZoneInfo("Asia/Shanghai"); print("ZHIXUE_RUNTIME_OK")'
        $probe = $probeCode | & $Path -I - 2>$null
        return $LASTEXITCODE -eq 0 -and ($probe -contains 'ZHIXUE_RUNTIME_OK')
    } catch { return $false }
}

function Get-ZhixueRuntime {
    param([Parameter(Mandatory=$true)][string]$Root, [switch]$Repair)
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'runtime-requires-64bit-windows' }
    $rootPath = [IO.Path]::GetFullPath($Root)
    $manifestPath = Join-Path $rootPath 'runtime-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'runtime-bundle-missing: 请重新下载完整的 Companion 安装包。' }
    $manifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.architecture -ne 'amd64' -or $manifest.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'runtime-manifest-invalid' }
    $archivePath = Get-ZhixueChildPath $rootPath $manifest.archive
    if (-not (Test-Path -LiteralPath $archivePath) -or (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $manifest.sha256) { throw 'runtime-bundle-invalid: 安装包不完整，请重新下载。' }
    $runtimeBase = Get-ZhixueChildPath $rootPath 'runtime'
    $runtimeRoot = Get-ZhixueChildPath $runtimeBase $manifest.sha256.Substring(0,16)
    $pythonPath = Join-Path $runtimeRoot 'python.exe'
    if (Test-Path -LiteralPath $runtimeRoot) {
        if (Test-ZhixuePython $pythonPath) { return $pythonPath }
        if (-not $Repair) { throw 'runtime-damaged: 请重新运行安装程序修复运行环境，学习数据会保留。' }
        $retired = Get-ZhixueChildPath $runtimeBase ('backup-' + [guid]::NewGuid().ToString('N').Substring(0,8))
        Move-Item -LiteralPath $runtimeRoot -Destination $retired
    }
    New-Item -ItemType Directory -Path $runtimeBase -Force | Out-Null
    $staged = Get-ZhixueChildPath $runtimeBase ('stage-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    New-Item -ItemType Directory -Path $staged | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $total = 0L
        foreach ($entry in $archive.Entries) {
            $total += $entry.Length
            if ($total -gt 200000000) { throw 'runtime-bundle-too-large' }
            [void](Get-ZhixueChildPath $staged $entry.FullName)
        }
    } finally { $archive.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $staged)
    if (-not (Test-ZhixuePython (Join-Path $staged 'python.exe'))) { throw 'runtime-unusable: 当前 Windows 无法启动附带运行环境，请保留错误提示联系维护者。' }
    Move-Item -LiteralPath $staged -Destination $runtimeRoot
    return $pythonPath
}

function Get-ZhixuePort([string]$Root) {
    $path = Join-Path $Root 'config.local.json'
    if (-not (Test-Path -LiteralPath $path)) { return 43121 }
    $config = [IO.File]::ReadAllText($path,[Text.Encoding]::UTF8) | ConvertFrom-Json
    $port = if ($null -eq $config.port) { 43121 } else { $config.port }
    if ($port -isnot [int] -and $port -isnot [long]) { throw 'setup-invalid-port' }
    if ($port -lt 1024 -or $port -gt 65535) { throw 'setup-invalid-port' }
    return [int]$port
}

function Get-ZhixueRunning([int]$Port) {
    try {
        $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/v1/health') -TimeoutSec 2
        if ($health.ok -eq $true -and [string]$health.serverVersion -like 'StudyLoopCompanion/*') { return $health }
        throw 'companion-port-in-use'
    } catch {
        $client = [Net.Sockets.TcpClient]::new()
        try {
            $pending = $client.ConnectAsync('127.0.0.1',$Port)
            if ($pending.Wait(500) -and $client.Connected) { throw 'companion-port-in-use: 此端口已有程序运行，请关闭旧实例或在配置中选择其他端口。' }
        } catch {
            if ($_.Exception.Message -like 'companion-port-in-use*') { throw }
        } finally { $client.Dispose() }
        return $null
    }
}
