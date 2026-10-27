// Fills zetaris/register.sql.template with DATA_BASE_URL → zetaris/register.sql
import fs from "node:fs";
import path from "node:path";
import { ROOT, config } from "../server/config.ts";

const base = config.dataBaseUrl;
if (!base || base.includes("<you>")) {
  console.error("Set DATA_BASE_URL in .env to where Zetaris can download data/*.json,\nfor example https://raw.githubusercontent.com/<your-github-user>/echorx/main/data");
  process.exit(1);
}
if (!/\/data$/.test(base) && !/raw\.githubusercontent\.com/.test(base)) {
  console.warn(`Note: DATA_BASE_URL usually ends in /data (it should point at the folder holding patients.json). Using: ${base}`);
}
const sql = fs.readFileSync(path.join(ROOT, "zetaris", "register.sql.template"), "utf-8").replaceAll("{{DATA_BASE_URL}}", base);
fs.writeFileSync(path.join(ROOT, "zetaris", "register.sql"), sql);
console.log(`Wrote zetaris/register.sql using ${base}`);
