export {};
// Runs Razia + Hassan + Lucía in LIVE mode against the mock services.
// Spawned by tests/live-mode.test.ts with SAMPLE_MODE=false and mock URLs.
const { getCase, createCase, handleMessage, handlePhoto, finish, nurseDecide } = await import("../../server/agents/orchestrator.ts");

const answers = ["Review my medicines", "Dizzy for 2 weeks when standing, mild", "Metformin, lisinopril, atorvastatin, amlodipine and vitamin D", "No known allergies", "Diabetes", "No car; needs a stop within walking distance"];
let c = await createCase("P-1001", "bn");
for (const a of answers) c = await handleMessage(c.id, { text: a, text_en: a });
c = await handlePhoto(c.id, { dataUrl: "data:image/png;base64,iVBORw0KGgo=", sampleId: "metformin-500" });
c = await finish(c.id);
const esc = c.escalations.find((e) => e.status === "open");
if (esc) c = await nurseDecide(c.id, esc.id, "Bottle is old; use the latest fill.", true, "Nurse Janelle Okafor");

let h = await createCase("P-1002", "ar");
for (const a of ["Review my medicines", "No symptoms", "Lisinopril 10 mg and metformin", "No known allergies", "High blood pressure", "No car; needs a stop within walking distance"]) h = await handleMessage(h.id, { text: a, text_en: a });
h = await finish(h.id);

let l = await createCase("P-1003", "es");
l = await handleMessage(l.id, { text: "Tengo dolor en el pecho" });

const final = getCase(c.id)!;
console.log(JSON.stringify({
  razia: { status: final.status, discrepancies: final.discrepancies.map((d) => `${d.type}:${d.drug}:${d.foundBy}`), photoFields: final.photos[0]?.fields.map((f) => f.label), escalations: final.escalations.map((e) => `${e.status}:${e.savedRuleId ?? ""}`), booking: final.booking?.stopId, models: [...new Set(final.trace.filter((t) => t.model).map((t) => t.model))], rejected: final.trace.filter((t) => t.action === "rejected_finding").length, overrides: final.trace.filter((t) => t.action === "policy_override").length, sqlProviders: [...new Set(final.trace.filter((t) => t.tool === "run_sql").map((t) => t.provider))] },
  hassan: { status: h.status, escalations: h.escalations.map((e) => `${e.status}:${e.memory?.sourceCase ?? ""}`) },
  lucia: { status: l.status, redFlag: l.redFlag },
}));
