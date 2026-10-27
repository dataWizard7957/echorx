// Sample-mode orchestration: critic loop, memory across cases, red-flag branch, safety of outputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as o from "../server/agents/orchestrator.ts";
import { resetMemoryInstance } from "../server/hmem/careMemory.ts";

const RAZIA = ["Review my medicines", "I feel dizzy sometimes", "Metformin, lisinopril, atorvastatin, amlodipine and vitamin D", "No known allergies", "Diabetes and high blood pressure", "No car; needs a stop within walking distance"];

test("critic sends a question back (revise), then escalates; nurse rule is reused for the next patient", async () => {
  let c = await o.createCase("P-1001", "bn");
  for (const a of RAZIA) c = await o.handleMessage(c.id, { text: a, text_en: a });
  c = await o.handlePhoto(c.id, { sampleId: "metformin-500" });
  c = await o.finish(c.id);
  assert.equal(c.status, "needs_patient");
  assert.equal(c.critiques[0].verdict, "revise");
  c = await o.handleMessage(c.id, { text: "২ সপ্তাহ", text_en: "About 2 weeks, mild" });
  assert.equal(c.status, "waiting_nurse");
  assert.ok(c.criticRounds <= 2);
  assert.ok(c.booking, "booked a van stop");
  assert.ok(c.booking!.distanceMi <= 1.5, "walkable for a patient with no car");
  const esc = c.escalations.find((e) => e.status === "open")!;
  c = await o.nurseDecide(c.id, esc.id, "Bottle is old; list the latest fill.", true, "Nurse Janelle Okafor");
  assert.equal(c.status, "ready");

  resetMemoryInstance(); // restart between patients
  let h = await o.createCase("P-1002", "ar");
  for (const a of ["Review my medicines", "No symptoms", "Lisinopril 10 mg and metformin", "No known allergies", "High blood pressure", "No car; needs a stop within walking distance"]) h = await o.handleMessage(h.id, { text: a, text_en: a });
  h = await o.finish(h.id);
  const auto = h.escalations.find((e) => e.status === "auto_resolved");
  assert.ok(auto, "resolved from memory");
  assert.equal(auto!.memory!.sourceCase, c.id);
  assert.equal(h.status, "ready");

  // Nothing the agents wrote is a diagnosis or dose judgement.
  const text = JSON.stringify([c.summary, h.summary, c.discrepancies, h.discrepancies]);
  assert.doesNotMatch(text, /diagnos|you should take|increase the dose|decrease the dose|correct dose is/i);
});

test("red flag ends intake immediately", async () => {
  let l = await o.createCase("P-1003", "es");
  l = await o.handleMessage(l.id, { text: "Tengo dolor en el pecho" });
  assert.equal(l.status, "emergency");
  assert.equal(l.redFlag?.rule, "RF-01");
  const after = await o.handleMessage(l.id, { text: "hola" });
  assert.equal(after.transcript.length, l.transcript.length, "no more intake after an emergency");
});

test("every model call is traced with lane and model", async () => {
  const calls = o.listCases().flatMap((c) => c.trace.filter((t) => t.action === "model_call"));
  assert.ok(calls.length > 0);
  for (const t of calls) assert.ok(t.model && t.lane, `trace event missing model/lane: ${JSON.stringify(t)}`);
});
