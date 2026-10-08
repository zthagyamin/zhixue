import { spawn } from "node:child_process";
import { join } from "node:path";

const mode = process.argv[2] || "dev";
const cli = join(process.cwd(), "node_modules", "vinext", "dist", "cli.js");
const child = spawn(process.execPath, [cli, mode], {
  stdio: "inherit",
  shell: false,
  env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
});

child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
