// Med Reader: reads a pill-bottle photo on the vision lane. Identifiers are
// stripped twice: by the prompt and again here. Images are never stored.
import { z } from "zod";
import crypto from "node:crypto";
import { callAgent, VisionUnavailable } from "../providers/nightshift.ts";
import { loadPrompt } from "./prompts.ts";
import { trace } from "../trace.ts";
import type { Case, PhotoField, PhotoRead } from "./types.ts";

const Out = z.object({
  fields: z.array(z.object({ label: z.string().max(60), value: z.string().max(200), confidence: z.string().transform((v) => (/high/i.test(v) ? "high" : /med/i.test(v) ? "medium" : "check") as PhotoField["confidence"]) })).max(12),
});

/** Sample bottles shipped in web/public/samples (synthetic labels). */
export const SAMPLE_BOTTLES: Record<string, PhotoField[]> = {
  "metformin-500": [
    { label: "Drug", value: "Metformin HCl", confidence: "high" },
    { label: "Strength", value: "500 mg", confidence: "high" },
    { label: "Directions", value: "Take 1 tablet by mouth twice daily with meals", confidence: "high" },
    { label: "Fill date", value: "05/28/2026", confidence: "medium" },
    { label: "Pharmacy", value: "Hamtramck Community Pharmacy", confidence: "high" },
  ],
  "lisinopril-10": [
    { label: "Drug", value: "Lisinopril", confidence: "high" },
    { label: "Strength", value: "10 mg", confidence: "high" },
    { label: "Directions", value: "Take 1 tablet by mouth once daily", confidence: "high" },
    { label: "Fill date", value: "05/20/2026", confidence: "medium" },
    { label: "Pharmacy", value: "Dearborn Family Pharmacy", confidence: "high" },
  ],
  "atorvastatin-20": [
    { label: "Drug", value: "Atorvastatin", confidence: "high" },
    { label: "Strength", value: "20 mg", confidence: "high" },
    { label: "Directions", value: "Take 1 tablet at bedtime", confidence: "high" },
  ],
};

// Identifiers to drop. Only patient/prescription identifiers: "Drug name" must survive.
const BLOCKED = /\b(patient|address|dob|birth|dea|npi|barcode|member|rx\s*(#|no|num|number)|prescription\s*(#|no|num|number)|refill\s*(#|no))\b|^\s*(name|patient name|id)\s*$/i;
const STRENGTH_RE = /\b\d+(?:\.\d+)?\s*(mg|mcg|g|units?|iu)\b/i;

/** Map whatever labels the vision model used onto Drug / Strength / Directions. */
export function normaliseFields(fields: PhotoField[]): PhotoField[] {
  const out: PhotoField[] = [];
  for (const f of fields) {
    const l = f.label.toLowerCase();
    let label = f.label;
    if (/drug|medic|medicine|generic|brand|product|name/.test(l) && !/pharmac|doctor|prescriber|store/.test(l)) label = "Drug";
    else if (/strength|dose|dosage|mg/.test(l)) label = "Strength";
    else if (/direction|sig|instruction|how to take|take/.test(l)) label = "Directions";
    else if (/fill|date/.test(l)) label = "Fill date";
    else if (/pharmac|store/.test(l)) label = "Pharmacy";
    out.push({ ...f, label });
  }
  // Strength written inside the drug field ("Lisinopril 10 mg"): split it out.
  const drug = out.find((f) => f.label === "Drug");
  if (drug && !out.some((f) => f.label === "Strength")) {
    const m = STRENGTH_RE.exec(drug.value);
    if (m) out.push({ label: "Strength", value: m[0], confidence: drug.confidence });
  }
  return out;
}

export async function readBottle(c: Case, image: { dataUrl?: string; sampleId?: string }): Promise<PhotoRead> {
  let res: { data: { fields: PhotoField[] }; model: string };
  try {
    res = await readWithVision(c, image);
  } catch (err) {
    if (!(err instanceof VisionUnavailable)) throw err;
    // Nightshift is fine, it just has no vision lane. For EchoRx's own synthetic
    // sample bottles the label text is known, so use it and say so in the trace.
    const known = SAMPLE_BOTTLES[image.sampleId ?? ""];
    trace({ caseId: c.id, agent: "Med Reader", action: "vision_unavailable", decision: known ? `no vision model enabled in Nightshift; used the known text of sample label "${image.sampleId}"` : "no vision model enabled in Nightshift; photo not read (patient's spoken list still used)", ok: false, error: err.message.slice(0, 200) });
    res = { data: { fields: known ?? [] }, model: known ? "sample-label-text" : "vision-unavailable" };
  }
  const fields = normaliseFields(res.data.fields.filter((f) => !BLOCKED.test(f.label) && !/\b\d{6,}\b/.test(f.value)));
  if (!fields.some((f) => f.label === "Drug")) {
    trace({ caseId: c.id, agent: "Med Reader", action: "incomplete_read", decision: `no drug name found on the label (labels: ${res.data.fields.map((f) => f.label).join(", ") || "none"}); the patient's spoken list is still used`, ok: false });
  }
  return { id: `PH-${crypto.randomUUID().slice(0, 6)}`, sampleId: image.sampleId, fields, model: res.model, ts: new Date().toISOString() };
}

function readWithVision(c: Case, image: { dataUrl?: string; sampleId?: string }) {
  return callAgent({
    caseId: c.id,
    agent: "Med Reader",
    lane: "vision",
    system: loadPrompt("medReader"),
    user: "Read this pill-bottle label.",
    image: image.dataUrl ? { dataUrl: image.dataUrl } : undefined,
    schema: Out,
    sample: () => ({ fields: SAMPLE_BOTTLES[image.sampleId ?? ""] ?? [{ label: "Drug", value: "Label could not be read in sample mode", confidence: "check" as const }] }),
    summarize: (o) => o.fields.map((f) => `${f.label}: ${f.value}`).join(" · ").slice(0, 160),
  });
}
