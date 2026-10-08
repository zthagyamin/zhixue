import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { validateAnnouncements } from '../app/release-announcements-model.ts';

const execFileAsync = promisify(execFile);

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const version = packageJson.version;
validateAnnouncements(JSON.parse(await readFile(new URL('../app/release-announcements.json', import.meta.url), 'utf8')), version);
const releaseFile = new URL(`../docs/releases/v${version}.md`, import.meta.url);
const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const companionVersion = JSON.parse(
  await readFile(new URL("../companion/version.json", import.meta.url), "utf8")
).version;
const companionArchive = fileURLToPath(
  new URL("../public/downloads/zhixue-companion-windows.zip", import.meta.url)
);
const companionInstaller = fileURLToPath(
  new URL("../public/downloads/Zhixue-Companion-Setup.exe", import.meta.url)
);

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function verifyCompanionReleaseArtifacts() {
  await Promise.all([access(companionArchive), access(companionInstaller)]);
  if (process.platform !== "win32") {
    throw new Error("Companion 发布检查必须在 Windows 上运行，以验证 ZIP 与 EXE 的版本。");
  }
  const script = `
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead(${quotePowerShell(companionArchive)})
    try {
      $entry = $archive.Entries | Where-Object {
        ($_.FullName -replace '\\\\', '/') -eq 'zhixue-companion/version.json'
      } | Select-Object -First 1
      if ($null -eq $entry) { throw 'Companion ZIP 缺少 version.json。' }
      $reader = [System.IO.StreamReader]::new($entry.Open())
      try { $archiveVersion = ($reader.ReadToEnd() | ConvertFrom-Json).version }
      finally { $reader.Dispose() }
    } finally { $archive.Dispose() }
    [PSCustomObject]@{
      archiveVersion = $archiveVersion
      installerVersion = (Get-Item -LiteralPath ${quotePowerShell(companionInstaller)}).VersionInfo.FileVersion
    } | ConvertTo-Json -Compress
  `;
  const { stdout } = await execFileAsync("pwsh.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
  });
  const artifacts = JSON.parse(stdout.trim());
  if (artifacts.archiveVersion !== version) {
    throw new Error(
      `Companion ZIP 版本 ${artifacts.archiveVersion || "未知"} 与网站版本 ${version} 不一致；请先运行 npm run package:companion。`
    );
  }
  if (!String(artifacts.installerVersion || "").startsWith(`${version}.`)) {
    throw new Error(
      `Companion 安装器版本 ${artifacts.installerVersion || "未知"} 与网站版本 ${version} 不一致；请先运行 npm run package:companion。`
    );
  }
  return artifacts;
}

await access(releaseFile);
if (!changelog.includes(`## [${version}]`)) {
  throw new Error(`CHANGELOG.md 缺少 ${version} 的版本说明。`);
}
if (companionVersion !== version) {
  throw new Error(
    `Companion 版本 ${companionVersion} 与网站版本 ${version} 不一致，请同步 companion/version.json。`
  );
}
const companionArtifacts = await verifyCompanionReleaseArtifacts();

console.log(
  `Release notes verified for v${version} (companion v${companionVersion}; ZIP ${companionArtifacts.archiveVersion}; installer ${companionArtifacts.installerVersion}).`
);
