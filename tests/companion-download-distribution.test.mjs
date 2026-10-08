import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { companionDownloads, resolveCompanionDownload } from "../src/infrastructure/downloads/index.mjs";

const assets = {
  installer: { filename: "Zhixue-Companion-Setup.exe", host: "zhixue-downloads.zthagyamin.chatgpt.site" },
  portable: { filename: "zhixue-companion-windows.zip", host: "zhixue-portable-downloads.zthagyamin.chatgpt.site" },
};
const version = "1.38.0";
const hash = (data) => createHash("sha256").update(data).digest("hex");

for (const [kind, asset] of Object.entries(assets)) {
  for (const method of ["GET", "HEAD"]) {
    test(`${kind} ${method} preserves the legacy URL and redirects only to its pinned download`, async () => {
      const response = resolveCompanionDownload(new Request(`https://example.test/downloads/${asset.filename}?next=https://untrusted.test/`, { method }));
      assert.equal(response.status, 307);
      assert.equal(response.headers.get("location"), `https://${asset.host}/v${companionDownloads.version}/${asset.filename}`);
      assert.equal(response.headers.get("cache-control"), "public, max-age=300");
      assert.equal(await response.text(), "");
    });
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zhixue-download-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["config", "companion", "public/downloads", "dist/client/downloads", "dist/server"]) {
    await mkdir(join(root, dir), { recursive: true });
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ version }));
  await writeFile(join(root, "companion/version.json"), JSON.stringify({ version }));
  await writeFile(join(root, "dist/server/index.js"), "export default {fetch(){}};");
  const manifest = { schemaVersion: 1, version, downloads: {} };
  for (const [kind, asset] of Object.entries(assets)) {
    const data = Buffer.from(`verified-${kind}-fixture`);
    manifest.downloads[kind] = {
      filename: asset.filename,
      url: `https://${asset.host}/v${version}/${asset.filename}`,
      sha256: hash(data),
      sizeBytes: data.length,
    };
    await writeFile(join(root, "public/downloads", asset.filename), data);
    await writeFile(join(root, "dist/client/downloads", asset.filename), data);
  }
  await writeFile(join(root, "dist/client/downloads/companion-install-guide.md"), "keep the guide");
  const saveManifest = () => writeFile(join(root, "config/companion-downloads.json"), JSON.stringify(manifest));
  await saveManifest();
  return { root, manifest, saveManifest };
}
async function externalize(root) {
  const { externalizeCompanionDownloads } = await import("../scripts/externalize-companion-downloads.mjs");
  const distribution = JSON.parse(await readFile(join(root, "config/companion-downloads.json"), "utf8"));
  return externalizeCompanionDownloads(root, distribution);
}
async function assertBothRetained(root) {
  for (const asset of Object.values(assets)) {
    assert.ok((await stat(join(root, "dist/client/downloads", asset.filename))).isFile());
  }
}

test("build removes only verified published copies and remains repeatable", async (t) => {
  const { root } = await fixture(t);
  const result = await externalize(root);
  assert.deepEqual(result.removed.sort(), Object.values(assets).map((a) => a.filename).sort());
  for (const [kind, asset] of Object.entries(assets)) {
    await assert.rejects(stat(join(root, "dist/client/downloads", asset.filename)), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "public/downloads", asset.filename), "utf8"), `verified-${kind}-fixture`);
  }
  assert.equal(await readFile(join(root, "dist/client/downloads/companion-install-guide.md"), "utf8"), "keep the guide");
  assert.ok((await stat(join(root, "dist/server/index.js"))).isFile());
  assert.deepEqual((await externalize(root)).removed, []);
});

test("a mismatched output aborts before removing either installer", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "dist/client/downloads", assets.portable.filename), "corrupt output");
  await assert.rejects(externalize(root), /hash|size|mismatch/i);
  await assertBothRetained(root);
});

test("changed source packages cannot silently retain stale remote downloads", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "public/downloads", assets.portable.filename), "new package");
  await assert.rejects(externalize(root), /hash|size|mismatch/i);
  await assertBothRetained(root);
});

test("release version drift prevents removing local download fallbacks", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "companion/version.json"), JSON.stringify({ version: "1.38.1" }));
  await assert.rejects(externalize(root), /version/i);
  await assertBothRetained(root);
});

test("invalid download locations cannot trigger pruning", async (t) => {
  const { root, manifest, saveManifest } = await fixture(t);
  manifest.downloads.portable.url = "http://untrusted.test/other.zip?secret=bad";
  await saveManifest();
  await assert.rejects(externalize(root), /url|location|https/i);
  await assertBothRetained(root);
});

test("unexpected filenames cannot remove unrelated build assets", async (t) => {
  const { root, manifest, saveManifest } = await fixture(t);
  manifest.downloads.portable.filename = "../server/index.js";
  await saveManifest();
  await assert.rejects(externalize(root), /filename/i);
  await assertBothRetained(root);
});

test("known download paths reject writes without redirecting", () => {
  const response = resolveCompanionDownload(new Request("https://example.test/downloads/Zhixue-Companion-Setup.exe", { method: "POST" }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
  assert.equal(response.headers.get("location"), null);
});

test("other files and application routes retain their existing handlers", () => {
  for (const path of ["/study", "/api/release", "/downloads/companion-install-guide.md", "/downloads/missing.exe"]) {
    assert.equal(resolveCompanionDownload(new Request("https://example.test" + path)), null);
  }
});
