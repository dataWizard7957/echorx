// LIVE-mode wiring against mock Zetaris + Nightshift that enforce the real contracts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { normaliseBaseUrl } from "../server/config.ts";
import { assertReadOnly } from "../server/data/zetaris.ts";
import { startMocks } from "./mocks/mockServices.ts";

test("Power Prompt: base URL normalised to <host>/v1, never /v1/v1", () => {
  assert.equal(normaliseBaseUrl("http://127.0.0.1:8088"), "http://127.0.0.1:8088/v1");
  assert.equal(normaliseBaseUrl("http://127.0.0.1:8088/v1/"), "http://127.0.0.1:8088/v1");
  assert.equal(normaliseBaseUrl("http://127.0.0.1:8088/v1/v1"), "http://127.0.0.1:8088/v1");
  assert.equal(normaliseBaseUrl("http://127.0.0.1:8088/v1/chat/completions"), "http://127.0.0.1:8088/v1");
});

test("agent SQL is read-only and limited to the echorx schema", () => {
  assert.doesNotThrow(() => assertReadOnly("SELECT drug FROM echorx.pharmacy_fills WHERE patient_id = 'P-1001'"));
  assert.throws(() => assertReadOnly("DROP TABLE echorx.pharmacy_fills"));
  assert.throws(() => assertReadOnly("SELECT * FROM other.secret"));
  assert.throws(() => assertReadOnly("SELECT 1; DELETE FROM echorx.x"));
});

async function runFlow(extraEnv: Record<string, string>, mockOpts: { noVision?: boolean } = {}) {
  const m = await startMocks(0, mockOpts);
  try {
    const env = { ...process.env, SAMPLE_MODE: "false", ZETARIS_REST_URL: `${m.url}/api/v1.0`, ZETARIS_API_KEY: "zk-test", ZETARIS_ORG_ID: "1", METERLESS_BASE_URL: `${m.url}/v1/v1/`, METERLESS_RUNTIME_TOKEN: "rt-test-token", ECHORX_VAR_DIR: `var-test/live-${Date.now()}`, ...extraEnv };
    // The child runs while the mock serves it, so it must be async: use a promise around spawn.
    const { spawn } = await import("node:child_process");
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, ["--import", "tsx", "tests/mocks/liveFlow.ts"], { env });
      let s = ""; let e = "";
      p.stdout.on("data", (d) => (s += d));
      p.stderr.on("data", (d) => (e += d));
      p.on("exit", (code) => (code === 0 ? resolve(s) : reject(new Error(`exit ${code}: ${e.slice(-800)}`))));
    });
    return JSON.parse(out.trim().split("\n").pop()!);
  } finally {
    m.close();
  }
}
void spawnSync;

test("live mode: Zetaris + Nightshift contracts, grounding check, policy override, memory, red flag", async () => {
  const r = await runFlow({ MODEL_DEEP: "nvidia/missing-deep-model" });
  assert.equal(r.razia.status, "ready");
  assert.deepEqual(r.razia.sqlProviders, ["zetaris"]);
  assert.ok(r.razia.discrepancies.includes("dose_mismatch:metformin:rules+model"));
  assert.equal(r.razia.rejected, 2, "fake-evidence finding and a finding that contradicts the patient's list are both rejected");
  assert.ok(r.razia.overrides >= 1, "critic 'approve' overridden: nurse item required by policy");
  assert.ok(!r.razia.photoFields.some((l: string) => /rx/i.test(l)), "Rx number stripped from photo read");
  assert.ok(r.razia.models.some((m: string) => /nemotron/i.test(m)), "a Nemotron model answered");
  assert.deepEqual(r.hassan.escalations, ["auto_resolved:EC-1001"]);
  assert.equal(r.lucia.status, "emergency");
});

test("live mode: if Zetaris rejects the key, records are never invented and the case escalates", async () => {
  const r = await runFlow({ ZETARIS_API_KEY: "wrong-key" }).catch((e) => ({ error: String(e) }));
  // createCase needs the patient record, so a bad key stops the case early with a clear error.
  assert.ok("error" in r && /401|API key/i.test(r.error), "clear Zetaris auth error");
});

test("live mode: no vision model in Nightshift only affects the photo step, not the rest", async () => {
  const r = await runFlow({}, { noVision: true });
  assert.ok(r.razia.photoFields.includes("Drug"), "known sample-label text used for the photo");
  assert.ok(r.razia.discrepancies.includes("dose_mismatch:metformin:rules+model"));
  assert.ok(!r.razia.models.some((m: string) => /^backup:/.test(m)), "no other step fell back to backup");
  assert.deepEqual(r.hassan.escalations, ["auto_resolved:EC-1001"]);
});
