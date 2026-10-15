param([string]$OutputDirectory = "public/downloads")

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $projectRoot "companion"
if (-not [System.IO.Path]::IsPathRooted($OutputDirectory)) {
    $OutputDirectory = Join-Path $projectRoot $OutputDirectory
}
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$destination = Join-Path $outputRoot "zhixue-companion-windows.zip"
$installerDestination = Join-Path $outputRoot "Zhixue-Companion-Setup.exe"
$siteVersion = ([System.IO.File]::ReadAllText((Join-Path $projectRoot "package.json"), [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version
$companionVersion = ([System.IO.File]::ReadAllText((Join-Path $sourceRoot "version.json"), [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version
if ($siteVersion -ne $companionVersion) {
    throw "网站版本 $siteVersion 与 Companion 版本 $companionVersion 不一致。"
}
$assemblyVersion = "$companionVersion.0"
$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("zhixue-companion-package-" + [guid]::NewGuid().ToString("N"))
$packageRoot = Join-Path $stagingRoot "zhixue-companion"
. (Join-Path $sourceRoot 'program-manifest.ps1')
$files = @(Read-CompanionProgramFiles $sourceRoot)

try {
    New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
    foreach ($relativePath in $files) {
        $source = Join-Path $sourceRoot $relativePath
        $target = Join-Path $packageRoot $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $target
        if ([IO.Path]::GetExtension($target) -eq '.ps1') {
            # The standalone EXE uses Windows' built-in PowerShell 5.1.
            # It otherwise decodes UTF-8 Chinese scripts as the system ANSI page.
            [IO.File]::WriteAllText($target, [IO.File]::ReadAllText($source, [Text.Encoding]::UTF8), [Text.UTF8Encoding]::new($true))
        }
    }
    $temporaryArchive = Join-Path $stagingRoot "zhixue-companion-windows.zip"
    Compress-Archive -LiteralPath $packageRoot -DestinationPath $temporaryArchive -CompressionLevel Optimal

    $temporaryInstaller = Join-Path $stagingRoot "Zhixue-Companion-Setup.exe"
    $installerSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'companion-installer.cs'), [Text.Encoding]::UTF8).Replace('__ASSEMBLY_VERSION__', $assemblyVersion)
    # .NET Framework Add-Type can emit a standalone EXE; PowerShell 7 cannot.
    # Keep this compatibility subprocess limited to compilation.
    $sourceFile = Join-Path $stagingRoot "installer.cs"
    [System.IO.File]::WriteAllText($sourceFile, $installerSource, [System.Text.UTF8Encoding]::new($false))
    $frameworkPowerShell = Join-Path $env:SystemRoot "System32/WindowsPowerShell/v1.0/powershell.exe"
    & $frameworkPowerShell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "compile-companion-installer.ps1") -SourcePath $sourceFile -OutputPath $temporaryInstaller -PayloadPath $temporaryArchive
    if ($LASTEXITCODE -ne 0) { throw "Windows 安装程序编译失败。" }
    if (-not (Test-Path -LiteralPath $temporaryInstaller -PathType Leaf)) {
        throw "无法生成 Windows 一键安装程序。"
    }
    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
    Copy-Item -LiteralPath $temporaryArchive -Destination $destination -Force
    Copy-Item -LiteralPath $temporaryInstaller -Destination $installerDestination -Force
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'README.md') -Destination (Join-Path $outputRoot 'companion-install-guide.md') -Force
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'LEGACY.md') -Destination (Join-Path $outputRoot 'LEGACY.md') -Force
    Write-Output $destination
    Write-Output $installerDestination
} finally {
    if ((Test-Path -LiteralPath $stagingRoot) -and
        [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($stagingRoot)).Equals([System.IO.Path]::GetTempPath().TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase) -and
        [System.IO.Path]::GetFileName($stagingRoot).StartsWith("zhixue-companion-package-")) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}
