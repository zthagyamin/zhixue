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
    $installerSource = @"
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

[assembly: AssemblyTitle("Zhixue Companion Setup")]
[assembly: AssemblyDescription("Install or safely update Zhixue Companion")]
[assembly: AssemblyVersion("$assemblyVersion")]
[assembly: AssemblyFileVersion("$assemblyVersion")]

namespace ZhixueInstaller
{
    internal static class Program
    {
        private static string Quote(string value)
        {
            if (value.IndexOf('"') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
                throw new ArgumentException("安装路径包含无效字符。");
            return "\"" + value + "\"";
        }

        private static int Main(string[] args)
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            bool nonInteractive = Array.IndexOf(args, "--non-interactive") >= 0;
            string temporaryRoot = Path.Combine(Path.GetTempPath(), "zhixue-companion-installer-" + Guid.NewGuid().ToString("N"));
            try
            {
                string target = null;
                for (int i = 0; i < args.Length; i++)
                {
                    if (args[i] == "--target")
                    {
                        if (++i >= args.Length) throw new ArgumentException("--target 后需要安装目录。");
                        target = Path.GetFullPath(args[i]).TrimEnd('\\', '/');
                        if (target.Length <= 3) throw new ArgumentException("请选择一个具体安装文件夹。");
                    }
                    else if (args[i] != "--verify-only" && args[i] != "--no-start" && args[i] != "--skip-registration" && args[i] != "--non-interactive")
                        throw new ArgumentException("无法识别安装参数：" + args[i]);
                }
                Directory.CreateDirectory(temporaryRoot);
                string payloadZip = Path.Combine(temporaryRoot, "payload.zip");
                using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("ZhixuePayload"))
                using (FileStream output = File.Create(payloadZip))
                {
                    if (payload == null) throw new InvalidDataException("Installer payload missing");
                    payload.CopyTo(output);
                }
                ZipFile.ExtractToDirectory(payloadZip, temporaryRoot);
                string payloadRoot = Path.Combine(temporaryRoot, "zhixue-companion");
                string installerScript = Path.Combine(payloadRoot, "install-or-upgrade.ps1");
                if (Array.IndexOf(args, "--verify-only") >= 0)
                {
                    if (!File.Exists(installerScript) || !File.Exists(Path.Combine(payloadRoot, "version.json"))) return 2;
                    Console.WriteLine("Zhixue Companion installer payload verified.");
                    return 0;
                }

                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
                startInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -File " + Quote(installerScript) + " -PayloadRoot " + Quote(payloadRoot);
                if (target != null) startInfo.Arguments += " -TargetPath " + Quote(target);
                if (nonInteractive) startInfo.Arguments += " -NonInteractive";
                if (Array.IndexOf(args, "--no-start") >= 0) startInfo.Arguments += " -NoStart";
                if (Array.IndexOf(args, "--skip-registration") >= 0) startInfo.Arguments += " -SkipRegistration";
                startInfo.WorkingDirectory = payloadRoot;
                startInfo.UseShellExecute = false;
                // Do not pass PowerShell 7's module search path into Windows PowerShell.
                Environment.SetEnvironmentVariable("PSModulePath", null);
                using (Process process = Process.Start(startInfo))
                {
                    process.WaitForExit();
                    if (process.ExitCode != 0 && !nonInteractive)
                    {
                        Console.WriteLine("安装未完成。请保留上方错误信息；不要删除原安装目录或 data 文件夹。");
                        Console.WriteLine("按回车键关闭窗口。");
                        Console.ReadLine();
                    }
                    return process.ExitCode;
                }
            }
            catch (Exception error)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("知学 Companion 安装失败：" + error.Message);
                Console.ResetColor();
                Console.WriteLine("按回车键关闭窗口。");
                if (!nonInteractive) Console.ReadLine();
                return 1;
            }
            finally
            {
                try
                {
                    if (Directory.Exists(temporaryRoot)) Directory.Delete(temporaryRoot, true);
                }
                catch { }
            }
        }
    }
}
"@
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
