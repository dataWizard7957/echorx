// One-shot PASS/FAIL check for every layer: Zetaris, Nightshift, Nemotron lanes, H-MEM.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { ROOT, config, liveConfigProblems } from "../server/config.ts";
import { runSql } from "../server/data/zetaris.ts";
import { listModels, pingModel } from "../server/providers/nightshift.ts";

const results: [string, string, string][] = [];
const check = async (name: string, fn: () => Promise<string | void>) => {
  try { results.push(["PASS", name, (await fn()) ?? ""]); }
  catch (err) { results.push(["FAIL", name, (err as Error).message.slice(0, 220)]); }
};

if (config.sampleMode) {
  const envFile = path.join(ROOT, ".env");
  const fromShell = process.env.SAMPLE_MODE !== undefined && fs.existsSync(envFile) && !fs.readFileSync(path.join(ROOT, ".env"), "utf-8").includes(`SAMPLE_MODE=${process.env.SAMPLE_MODE}`);
  console.log(`SAMPLE_MODE=true: live checks skipped. Set SAMPLE_MODE=false in .env (${path.join(ROOT, ".env")})${fromShell ? " — note: SAMPLE_MODE is also set in this terminal's environment" : ""}.\n`);
} else {
  for (const p of liveConfigProblems()) results.push(["FAIL", "config", p]);
  await check("Data: Zetaris runs SQL over REST", async () => {
    const r = await runSql("SELECT 1");
    if (String(r.rows[0]?.[0]) !== "1") throw new Error(`unexpected reply ${JSON.stringify(r.rows).slice(0, 80)}`);
    return `${r.ms} ms`;
  });
  const views = JSON.parse(fs.readFileSync(path.join(ROOT, "zetaris", "views.json"), "utf-8")) as Record<string, string[]>;
  for (const v of Object.keys(views)) {
    await check(`Data: ${config.zetaris.schema}.${v} has rows`, async () => {
      const r = await runSql(`SELECT COUNT(*) AS n FROM ${config.zetaris.schema}.${v}`);
      const n = Number(r.rows[0]?.[0] ?? 0);
      if (!n) throw new Error("0 rows — run `npm run zetaris:register`");
      return `${n} rows`;
    });
  }
  await check("Power: Nightshift /v1/models", async () => {
    const m = await listModels();
    if (m.status !== "online") throw new Error(`${m.status}${m.detail ? ` (${m.detail})` : ""}`);
    const nemo = m.models.filter((x) => /nemotron/i.test(x));
    return `${m.models.length} models, ${nemo.length} Nemotron`;
  });
  for (const lane of ["fast", "deep"] as const) {
    await check(`Power: ${lane} lane replies (${lane === "fast" ? config.models.fast : config.models.deep})`, async () => {
      const r = await pingModel(lane);
      const nemo = /nemotron/i.test(r.model) ? "Nemotron ✓" : "NOT Nemotron — pin a Nemotron lane for the NVIDIA award";
      return `answered by ${r.model}${r.fallbackUsed ? " (fallback)" : ""} · ${nemo} · ${r.ms} ms`;
    });
  }
}

await check("Build: H-MEM conformance suite", async () => {
  const r = spawnSync(process.execPath, ["--import", "tsx", path.join("tests", "hmem-conformance", "runner.ts")], { cwd: ROOT, encoding: "utf-8", env: { ...process.env, HMEM_IMPL: path.join(ROOT, "server", "hmem", "index.ts").replace(/\\/g, "/"), HMEM_TMP: os.tmpdir() } });
  const line = (r.stdout.match(/\d+\/\d+ checks passed/) ?? [""])[0];
  if (r.status !== 0) throw new Error(line || r.stderr.slice(0, 200));
  return line;
});

for (const [s, n, d] of results) console.log(`${s} ${n}${d ? `  ·  ${d}` : ""}`);
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
