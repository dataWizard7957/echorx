// Registers EchoRx's data in Zetaris: runs zetaris/register.sql ONE statement
// at a time over the REST API, then checks each view's row count.
import fs from "node:fs";
import path from "node:path";
import { ROOT, config } from "../server/config.ts";
import { runSql } from "../server/data/zetaris.ts";

const file = path.join(ROOT, "zetaris", "register.sql");
if (!fs.existsSync(file)) {
  console.error("zetaris/register.sql not found. Run `npm run zetaris:sql` first (needs DATA_BASE_URL in .env).");
  process.exit(1);
}
if (!config.zetaris.apiKey) {
  console.error("ZETARIS_API_KEY is missing from .env");
  process.exit(1);
}
const statements = fs.readFileSync(file, "utf-8")
  .split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n")
  .split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean);

let failed = 0;
for (const sql of statements) {
  const label = sql.split("\n")[0].slice(0, 80);
  try {
    await runSql(sql, { timeoutMs: 120_000 });
    console.log(`PASS  ${label}`);
  } catch (err) {
    const msg = (err as Error).message;
    if (/already exists|duplicate/i.test(msg)) console.log(`SKIP  ${label}  (already exists)`);
    else { failed++; console.log(`FAIL  ${label}\n      ${msg.slice(0, 300)}`); }
  }
}

const views = JSON.parse(fs.readFileSync(path.join(ROOT, "zetaris", "views.json"), "utf-8")) as Record<string, string[]>;
console.log("\nRow counts (expected from data/*.json):");
for (const v of Object.keys(views)) {
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, "data", `${v}.json`), "utf-8")).data.length;
  try {
    const r = await runSql(`SELECT COUNT(*) AS n FROM ${config.zetaris.schema}.${v}`);
    const n = Number(r.rows[0]?.[0] ?? 0);
    console.log(`${n === expected ? "PASS" : "FAIL"}  ${config.zetaris.schema}.${v}: ${n} rows (expected ${expected})`);
    if (n !== expected) failed++;
  } catch (err) {
    failed++;
    console.log(`FAIL  ${config.zetaris.schema}.${v}: ${(err as Error).message.slice(0, 200)}`);
  }
}
console.log(failed ? `\n${failed} problem(s). See README › Troubleshooting.` : "\nAll EchoRx views are registered and populated.");
process.exit(failed ? 1 : 0);
