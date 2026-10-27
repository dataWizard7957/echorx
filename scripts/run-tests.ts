// Runs every tests/*.test.ts with Node's built-in test runner (works on Windows too).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = fs.readdirSync(path.join(ROOT, "tests")).filter((f) => f.endsWith(".test.ts")).map((f) => path.join("tests", f));
const r = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", "--test-reporter=spec", ...files], { cwd: ROOT, stdio: "inherit", env: { ...process.env, SAMPLE_MODE: "true", ECHORX_VAR_DIR: path.join(ROOT, "var-test") } });
fs.rmSync(path.join(ROOT, "var-test"), { recursive: true, force: true });
process.exit(r.status ?? 1);
