// Development: rebuilds the web app on change and restarts the server on change.
// One command, works on Windows, macOS and Linux.
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildOptions, copyStatic } from "./web-config.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.rmSync(path.join(ROOT, "web", "dist"), { recursive: true, force: true });
const ctx = await esbuild.context({ ...buildOptions, minify: false });
await ctx.rebuild();
copyStatic();
await ctx.watch();
try {
  fs.watch(path.join(ROOT, "web"), { recursive: true }, (_e, file) => {
    if (file && !String(file).includes("dist") && /\.(css|html|png|svg)$/.test(String(file))) {
      try { copyStatic(); } catch { /* ignore transient */ }
    }
  });
} catch {
  console.warn("CSS/HTML hot-copy unavailable on this Node version; restart `npm run dev` after editing styles.");
}
console.log("\n  EchoRx dev: web rebuilds on change, server restarts on change → http://localhost:" + (process.env.PORT ?? 8787) + "\n");

const server = spawn(process.execPath, ["--import", "tsx", "--watch", "--watch-path=server", path.join("server", "index.ts")], { cwd: ROOT, stdio: "inherit", env: process.env });
const stop = () => { server.kill(); ctx.dispose().finally(() => process.exit(0)); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
