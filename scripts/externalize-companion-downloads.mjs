import { createHash } from "node:crypto";
import { readFile, lstat, realpath, unlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { companionDownloads } from "../src/infrastructure/downloads/index.mjs";

const filenames = {
  installer: "Zhixue-Companion-Setup.exe",
  portable: "zhixue-companion-windows.zip",
};
const readJson = async (path) => JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));

async function verifyFile(path, expected) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Expected a regular download file: ${path}`);
  }
  if (info.size !== expected.sizeBytes) throw new Error(`Download size mismatch: ${path}`);
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  if (digest !== expected.sha256) throw new Error(`Download hash mismatch: ${path}`);
}

export async function externalizeCompanionDownloads(projectRoot, distribution = companionDownloads) {
  const root = await realpath(projectRoot);
  const [site, companion] = await Promise.all([
    readJson(join(root, "package.json")),
    readJson(join(root, "companion/version.json")),
  ]);
  if (
    distribution.schemaVersion !== 1 ||
    distribution.version !== site.version ||
    distribution.version !== companion.version ||
    !/^\d+\.\d+\.\d+$/.test(distribution.version)
  ) {
    throw new Error("Download distribution version must match the site and Companion");
  }
  if (
    !distribution.downloads ||
    Object.keys(distribution.downloads).sort().join(",") !== "installer,portable"
  ) {
    throw new Error("Download distribution must contain exactly installer and portable");
  }
  const server = await lstat(join(root, "dist/server/index.js"));
  if (!server.isFile()) throw new Error("Production Worker build is missing");

  const outputDirectory = join(root, "dist/client/downloads");
  if (relative(outputDirectory, await realpath(outputDirectory)) !== "") {
    throw new Error("Download output directory must not resolve outside the build");
  }
  const removals = [];
  for (const [kind, filename] of Object.entries(filenames)) {
    const expected = distribution.downloads[kind];
    if (expected.filename !== filename) throw new Error(`Unexpected download filename: ${kind}`);
    if (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes <= 0 || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
      throw new Error(`Invalid download size or hash: ${kind}`);
    }
    const target = new URL(expected.url);
    if (
      target.protocol !== "https:" || target.username || target.password ||
      target.search || target.hash ||
      target.pathname !== `/v${distribution.version}/${filename}`
    ) {
      throw new Error(`Invalid HTTPS download URL: ${kind}`);
    }
    await verifyFile(join(root, "public/downloads", filename), expected);
    const output = join(outputDirectory, filename);
    try {
      await verifyFile(output, expected);
      removals.push({ filename, output, bytes: expected.sizeBytes });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  // Verify both source files and every existing output before deleting anything.
  for (const file of removals) await unlink(file.output);
  return {
    removed: removals.map((file) => file.filename),
    bytesRemoved: removals.reduce((total, file) => total + file.bytes, 0),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await externalizeCompanionDownloads(fileURLToPath(new URL("..", import.meta.url)))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
