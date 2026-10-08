param([string]$ProtocolUrl = '', [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
[Environment]::SetEnvironmentVariable('PSModulePath', $null)
trap {
    Write-Host ('Companion 启动失败：' + $_.Exception.Message) -ForegroundColor Red
    if (-not $NoBrowser) { [void](Read-Host '请保留上方错误信息，按回车关闭') }
    exit 1
}
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$companionRoot = $PSScriptRoot
. (Join-Path $companionRoot 'runtime-helpers.ps1')
if (-not (Test-Path -LiteralPath (Join-Path $companionRoot 'config.local.json'))) {
    & (Join-Path $companionRoot 'setup-and-start.ps1') -NoStart
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Companion 初始化失败。' }
}
function Open-ZhixueWebsite {
if (-not $NoBrowser -and -not $ProtocolUrl) {
    $config = [IO.File]::ReadAllText((Join-Path $companionRoot 'config.local.json'),[Text.Encoding]::UTF8) | ConvertFrom-Json
    $origin = @($config.allowed_origins)[0]
    $uri = $null
    if ([Uri]::TryCreate($origin,[UriKind]::Absolute,[ref]$uri) -and $uri.Scheme -eq 'https' -and -not $uri.UserInfo) {
        Start-Process -FilePath ($origin.TrimEnd('/') + '/?companionPort=' + $port)
    }
}
}
$port = Get-ZhixuePort $companionRoot
$running = Get-ZhixueRunning $port
if ($running) {
    $instancePath = Join-Path $companionRoot 'data/runtime-instance.json'
    $expected = if (Test-Path -LiteralPath $instancePath) { ([IO.File]::ReadAllText($instancePath,[Text.Encoding]::UTF8) | ConvertFrom-Json).instanceId } else { $null }
    if (-not $expected -or $running.instanceId -ne $expected) { throw 'companion-different-instance: 此端口正在运行另一份或旧版 Companion，请先核对安装位置，不会接管它的数据。' }
    Write-Host '这份 Companion 已经在运行。'
    Open-ZhixueWebsite
    exit 0
}
$python = Get-ZhixueRuntime -Root $companionRoot
Set-Location -LiteralPath $companionRoot
Open-ZhixueWebsite
Write-Host ('配对时如网站要求端口，请填写：' + $port)
Write-Host '保持本窗口运行（可最小化）；下方配对码仅用于当前电脑。'
& $python -B (Join-Path $companionRoot 'server.py')
exit $LASTEXITCODE