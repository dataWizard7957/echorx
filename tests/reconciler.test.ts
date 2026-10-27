import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { extractMentions, ruleFindings } from "../server/agents/reconciler.ts";

const load = (v: string) => JSON.parse(fs.readFileSync(`data/${v}.json`, "utf-8")).data;
const fills = load("pharmacy_fills").map((f: any) => ({ ...f, days_supply: Number(f.days_supply) }));
const visits = load("visit_history");
const policy = load("triage_policy");
const TODAY = new Date("2026-10-26T12:00:00Z");

test("Razia: dose mismatch (metformin) + overdue amlodipine + vitamin D without a fill, all with evidence", () => {
  const c = {
    claims: [{ id: "C-1", topic: "medicines" as const, text_en: "Metformin, lisinopril, atorvastatin, amlodipine and vitamin D", confidence: "high" as const, source: "patient" as const }],
    photos: [{ id: "PH-1", fields: [{ label: "Drug", value: "Metformin HCl", confidence: "high" as const }, { label: "Strength", value: "500 mg", confidence: "high" as const }], model: "x", ts: "" }],
  };
  const mine = fills.filter((f: any) => f.patient_id === "P-1001");
  const found = ruleFindings(extractMentions(c, mine.map((f: any) => f.drug)), mine, visits.filter((v: any) => v.patient_id === "P-1001"), policy, TODAY);
  const types = found.map((f) => `${f.type}:${f.drug}`).sort();
  assert.deepEqual(types, ["dose_mismatch:metformin", "overdue_refill:amlodipine", "reported_no_record:vitamin d"]);
  const dose = found.find((f) => f.type === "dose_mismatch")!;
  assert.ok(dose.evidence.includes("F-5101") && dose.evidence.includes("V-2208") && dose.evidence.includes("PH-1"));
  assert.equal(dose.routeTo, "nurse");
  assert.equal(dose.policy, "POL-DOSE");
  assert.doesNotMatch(dose.detail, /should|correct dose is|increase|decrease/i);
});

test("Hassan: lisinopril 10 mg vs latest fill 20 mg", () => {
  const c = { claims: [{ id: "C-2", topic: "medicines" as const, text_en: "Lisinopril 10 mg and metformin", confidence: "high" as const, source: "patient" as const }], photos: [] };
  const mine = fills.filter((f: any) => f.patient_id === "P-1002");
  const found = ruleFindings(extractMentions(c, mine.map((f: any) => f.drug)), mine, visits.filter((v: any) => v.patient_id === "P-1002"), policy, TODAY);
  assert.deepEqual(found.map((f) => `${f.type}:${f.drug}`), ["dose_mismatch:lisinopril"]);
});

test("a current fill the patient never mentions is flagged for the nurse", () => {
  const c = { claims: [{ id: "C-3", topic: "medicines" as const, text_en: "Only lisinopril", confidence: "high" as const, source: "patient" as const }], photos: [] };
  const mine = fills.filter((f: any) => f.patient_id === "P-1002");
  const found = ruleFindings(extractMentions(c, mine.map((f: any) => f.drug)), mine, visits, policy, TODAY);
  assert.ok(found.some((f) => f.type === "fill_not_mentioned" && f.drug === "metformin" && f.routeTo === "nurse"));
});
