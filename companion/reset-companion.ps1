$ErrorActionPreference = "Stop"
$companionRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPython = Join-Path $companionRoot ".venv\Scripts\python.exe"
$port = 43121
$configPath = Join-Path $companionRoot "config.local.json"
if (Test-Path -LiteralPath $configPath) {
    try { $configuredPort = (Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json).port; if ($configuredPort -as [int]) { $port = [int]$configuredPort } } catch { throw "无法读取 Companion 配置，已停止 RESET 以避免删除运行中服务的数据。" }
}
$answer = Read-Host "这会解除账号绑定并删除本地学习数据库。请输入 RESET 继续"
if ($answer -cne "RESET") {
    Write-Host "已取消。"
    exit 0
}
$serverPath = [System.IO.Path]::GetFullPath((Join-Path $companionRoot "server.py"))
try {
    $runningProcess = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($serverPath, [System.StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    if ($runningProcess) { throw "Companion 进程仍在运行。请先关闭 Companion，再重新执行 RESET。" }
} catch {
    if ($_.Exception.Message -like "Companion 进程仍在运行*") { throw }
    throw "无法确认 Companion 进程状态，已停止 RESET 以保护本地数据。"
}

try {
    Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/v1/health" -f $port) -TimeoutSec 1 | Out-Null
    throw "Companion 仍在运行。请先关闭 Companion，再重新执行 RESET。"
} catch {
    if ($_.Exception.Message -like "Companion 仍在运行*") { throw }
}

$accountDatabase = Join-Path $companionRoot "data\account-study.db"
if (Test-Path -LiteralPath $accountDatabase) {
    if (-not (Test-Path -LiteralPath $venvPython)) { throw "缺少 Companion Python 环境，无法安全清除账号凭据。请先修复安装。" }
    & $venvPython (Join-Path $companionRoot "account_sync_reset.py") --database $accountDatabase
    if ($LASTEXITCODE -ne 0) { throw "账号凭据清除失败；数据库尚未删除。" }
}

foreach ($name in @("study-loop.db", "study-loop.db-wal", "study-loop.db-shm", "account-study.db", "account-study.db-wal", "account-study.db-shm")) {
    $target = Join-Path $companionRoot ("data\" + $name)
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Force
    }
}

Write-Host "本地绑定、账号机器凭据和学习数据库已删除。重新启动 Companion 后可绑定新账号。"
