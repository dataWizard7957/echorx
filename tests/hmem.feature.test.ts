import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveNurseRule, recallRule, resetMemoryInstance, ruleFeedback, listRules } from "../server/hmem/careMemory.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echorx-hmem-"));

test("a nurse decision is remembered across a restart and applied to a similar case, with its source", () => {
  assert.equal(recallRule("dose_mismatch", "lisinopril bottle 10 mg, latest fill 20 mg", dir), undefined);
  saveNurseRule({ situation: "dose_mismatch", generalRule: "Treat the bottle as outdated and list the latest fill as current.", nurse: "Nurse Janelle Okafor", caseId: "EC-1001", drugs: ["metformin"] }, dir);
  resetMemoryInstance(); // simulate a server restart: new H-MEM instance, same directory
  assert.ok(fs.existsSync(path.join(dir, "state.json")) && fs.existsSync(path.join(dir, "ledger.jsonl")));
  const hit = recallRule("dose_mismatch", "lisinopril bottle 10 mg, latest fill 20 mg, visit V-2311", dir);
  assert.ok(hit, "expected a memory hit");
  assert.equal(hit!.rule.nurse, "Nurse Janelle Okafor");
  assert.equal(hit!.rule.sourceCase, "EC-1001");
  assert.ok(hit!.relevance >= 0.35);
});

test("rules don't leak across situations", () => {
  assert.equal(recallRule("overdue_refill", "amlodipine ran out 40 days ago", dir), undefined);
});

test("nurse feedback changes confidence by the H-MEM deltas and 'wrong' blocks reuse", () => {
  const rule = listRules(dir)[0];
  const helpful = ruleFeedback(rule.id, "helpful", dir)!;
  assert.equal(Number(helpful.confidence.toFixed(2)), 0.95);
  const wrong = ruleFeedback(rule.id, "wrong", dir)!;
  assert.equal(Number(wrong.confidence.toFixed(2)), 0.75);
  assert.ok(wrong.tags.includes("review"));
  assert.equal(recallRule("dose_mismatch", "lisinopril bottle 10 mg, latest fill 20 mg", dir), undefined);
});
