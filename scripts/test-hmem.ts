// Runs the official Meterless H-MEM conformance suite against server/hmem/index.ts
// and saves the scorecard to docs/hmem-conformance.txt (submission evidence).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const impl = path.join(ROOT, "server", "hmem", "index.ts").replace(/\\/g, "/");
const r = spawnSync(process.execPath, ["--import", "tsx", path.join("tests", "hmem-conformance", "runner.ts")], { cwd: ROOT, encoding: "utf-8", env: { ...process.env, HMEM_IMPL: impl } });
const out = `${r.stdout}${r.stderr}`;
process.stdout.write(out);
fs.mkdirSync(path.join(ROOT, "docs"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs", "hmem-conformance.txt"), `H-MEM conformance scorecard (official Meterless suite) · ${new Date().toISOString()}\nImplementation: server/hmem/index.ts\n\n${out}`);
console.log(`\nScorecard saved to docs/hmem-conformance.txt (exit ${r.status})`);
process.exit(r.status ?? 1);
