// Clears demo state: cases, traces and H-MEM memory (var/).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.rmSync(path.join(ROOT, "var"), { recursive: true, force: true });
console.log("Cleared var/ (cases, traces, H-MEM memory).");
