import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startProdServer } from "../node_modules/vinext/dist/server/prod-server.js";
import { companionDownloads } from "../src/infrastructure/downloads/index.mjs";

test("the actual production build redirects downloads before the public-file index", async (t) => {
  const runtime = await startProdServer({
    host: "127.0.0.1",
    port: 0,
    outDir: fileURLToPath(new URL("../dist", import.meta.url)),
    silent: true,
  });
  t.after(async () => {
    runtime.server.closeAllConnections();
    await new Promise((resolve, reject) => runtime.server.close((error) => error ? reject(error) : resolve()));
  });
  const files = [
    ["Zhixue-Companion-Setup.exe", "https://zhixue-downloads.zthagyamin.chatgpt.site"],
    ["zhixue-companion-windows.zip", "https://zhixue-portable-downloads.zthagyamin.chatgpt.site"],
  ];
  for (const [filename, origin] of files) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/downloads/${filename}`, { method, redirect: "manual" });
      assert.equal(response.status, 307, `${method} ${filename}`);
      assert.equal(response.headers.get("location"), `${origin}/v${companionDownloads.version}/${filename}`);
      assert.equal(await response.text(), "");
    }
  }
  const guide = await fetch(`http://127.0.0.1:${runtime.port}/downloads/companion-install-guide.md`);
  assert.equal(guide.status, 200);
  assert.ok((await guide.text()).includes("Companion"));
});
