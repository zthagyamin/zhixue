param([switch]$NoStart, [switch]$SkipRegistration)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$companionRoot = $PSScriptRoot
. (Join-Path $companionRoot 'runtime-helpers.ps1')
$fresh = -not (Test-Path -LiteralPath (Join-Path $companionRoot 'config.local.json'))
Write-Host '正在检查附带的离线运行环境…'
$python = Get-ZhixueRuntime -Root $companionRoot -Repair
& $python -B (Join-Path $companionRoot 'companion_setup.py') --root $companionRoot
if ($LASTEXITCODE -ne 0) { throw '学习空间初始化未完成；旧配置与记录保留，请检查目录权限。' }
$port = Get-ZhixuePort $companionRoot
if ($fresh) {
    $freePortFound = $false
    for ($candidate = $port; $candidate -lt [Math]::Min(65536,$port+100); $candidate++) {
        $tcp = [Net.Sockets.TcpClient]::new(); $occupied = $false
        try { $connect = $tcp.ConnectAsync('127.0.0.1',$candidate); $occupied = $connect.Wait(300) -and $tcp.Connected } catch { } finally { $tcp.Dispose() }
        if (-not $occupied) {
            $freePortFound = $true
            if ($candidate -ne $port) {
                & $python -B (Join-Path $companionRoot 'companion_setup.py') --root $companionRoot --initial-port $candidate
                if ($LASTEXITCODE -ne 0) { throw '无法保存可用连接端口。' }
                $port = $candidate
            }
            break
        }
    }
    if (-not $freePortFound) { throw '没有找到可用的本机端口，请关闭重复运行的程序后重试。' }
}
if (-not $SkipRegistration) {
    try { & (Join-Path $companionRoot 'register-protocol.ps1') }
    catch { Write-Warning '网页唤起通道未登记；可双击 start-companion.cmd 启动，学习数据不受影响。' }
}
Write-Host ''
Write-Host ('安装检查通过，启动时使用端口：' + $port) -ForegroundColor Green
if ($fresh) {
    Write-Host '下一步：保留启动窗口，使用程序打开的网页登录并配对，再选择一份资料。'
} else {
    Write-Host '原配置与学习记录已保留。回网站检测连接；原配对有效时不必再次配对。'
}
Write-Host '无需另装 Python 或 Obsidian。安装与排错指南：https://zhixue-daily.zthagyamin.chatgpt.site/companion-guide'
if (-not $NoStart) { & (Join-Path $companionRoot 'start-companion.ps1') }
