// Reconciler: lines up what the patient said and photographed with pharmacy
// fills and visit history from Zetaris. Deterministic rules find the obvious
// discrepancies; the deep model reviews them and may add findings. Any finding
// that cites a record ID that doesn't exist is rejected (grounding check).
import { z } from "zod";
import { callAgent } from "../providers/nightshift.ts";
import { repo, type Fill, type PolicyRule, type Visit } from "../data/repository.ts";
import { trace } from "../trace.ts";
import { loadPrompt } from "./prompts.ts";
import type { Case, Discrepancy, DiscrepancyType } from "./types.ts";

const OTC_AND_COMMON = ["vitamin d", "vitamin b12", "multivitamin", "aspirin", "ibuprofen", "acetaminophen", "tylenol", "insulin", "omeprazole", "fish oil", "calcium"];
const STRENGTH = /(\d+(?:\.\d+)?)\s*(mg|mcg|g|units?|iu)\b/i;

export interface Mention { drug: string; strengths: string[]; sources: string[]; texts: string[] }

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const normStrength = (s: string) => { const m = STRENGTH.exec(s); return m ? `${Number(m[1])} ${m[2].toLowerCase()}` : norm(s); };

export function extractMentions(c: Pick<Case, "claims" | "photos">, knownDrugs: string[]): Mention[] {
  const lexicon = [...new Set([...knownDrugs.map(norm), ...OTC_AND_COMMON])].sort((a, b) => b.length - a.length);
  const out = new Map<string, Mention>();
  const add = (drug: string, strength: string | undefined, source: string, text: string) => {
    const m = out.get(drug) ?? { drug, strengths: [], sources: [], texts: [] };
    if (strength && !m.strengths.includes(strength)) m.strengths.push(strength);
    if (!m.sources.includes(source)) m.sources.push(source);
    m.texts.push(text);
    out.set(drug, m);
  };
  for (const cl of c.claims.filter((x) => x.topic === "medicines")) {
    const text = norm(cl.text_en);
    for (const drug of lexicon) {
      const idx = text.indexOf(drug);
      if (idx < 0) continue;
      const after = text.slice(idx + drug.length, idx + drug.length + 14);
      const s = STRENGTH.exec(after);
      add(drug, s ? normStrength(s[0]) : undefined, cl.id, cl.text_en);
    }
  }
  for (const p of c.photos) {
    const drugField = p.fields.find((f) => /drug|medicine|name of drug/i.test(f.label))?.value ?? "";
    const strengthField = p.fields.find((f) => /strength|dose/i.test(f.label))?.value ?? STRENGTH.exec(drugField)?.[0];
    const drug = lexicon.find((d) => norm(drugField).includes(d));
    if (drug) add(drug, strengthField ? normStrength(strengthField) : undefined, p.id, `photo: ${drugField} ${strengthField ?? ""}`.trim());
  }
  return [...out.values()];
}

const daysBetween = (from: string, to: Date) => Math.floor((to.getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86_400_000);

export function ruleFindings(mentions: Mention[], fills: Fill[], visits: Visit[], policy: PolicyRule[], today = new Date()): Omit<Discrepancy, "id">[] {
  const pol = (id: string) => policy.find((p) => p.rule_id === id)?.rule_id ?? id;
  const findings: Omit<Discrepancy, "id">[] = [];
  const byDrug = new Map<string, Fill[]>();
  for (const f of fills) byDrug.set(norm(f.drug), [...(byDrug.get(norm(f.drug)) ?? []), f]);
  const latestOf = (drug: string) => [...(byDrug.get(drug) ?? [])].sort((a, b) => b.fill_date.localeCompare(a.fill_date))[0];
  const visitFor = (drug: string) => [...visits].reverse().find((v) => norm(v.med_changes).includes(drug));

  for (const m of mentions) {
    const latest = latestOf(m.drug);
    if (!latest) {
      findings.push({ type: "reported_no_record", drug: m.drug, patientSays: m.texts[0], recordSays: "No pharmacy fill on record", evidence: [pol("POL-NOREC"), ...m.sources], severity: "low", routeTo: "pharmacist", policy: pol("POL-NOREC"), detail: `Patient reports ${m.drug}; no fill found. Possibly over the counter or filled elsewhere.`, foundBy: "rules" });
      continue;
    }
    const latestStrength = normStrength(latest.strength);
    const differing = m.strengths.filter((s) => s !== latestStrength);
    if (differing.length) {
      const older = (byDrug.get(m.drug) ?? []).find((f) => normStrength(f.strength) === differing[0] && f.fill_id !== latest.fill_id);
      const visit = visitFor(m.drug);
      findings.push({
        type: "dose_mismatch",
        drug: m.drug,
        patientSays: `${differing.join(", ")} (${m.sources.map((s) => (s.startsWith("PH-") ? "bottle photo" : "patient")).join(" + ")})`,
        recordSays: `Latest fill ${latest.fill_id} (${latest.fill_date}): ${latest.strength}, ${latest.directions}${visit ? `; visit ${visit.visit_id}: ${visit.med_changes}` : ""}`,
        evidence: [latest.fill_id, ...(older ? [older.fill_id] : []), ...(visit ? [visit.visit_id] : []), ...m.sources],
        severity: "high",
        routeTo: "nurse",
        policy: pol("POL-DOSE"),
        detail: `${cap(m.drug)}: patient's ${differing[0]} differs from the latest fill of ${latest.strength}${visit ? ` (changed at ${visit.visit_id})` : ""}. EchoRx does not decide which is correct.`,
        foundBy: "rules",
      });
    }
  }

  const mentioned = new Set(mentions.map((m) => m.drug));
  for (const [drug] of byDrug) {
    const latest = latestOf(drug)!;
    const sinceFill = daysBetween(latest.fill_date, today);
    if (sinceFill > 240) continue; // stale history, not a current medicine
    const overdue = sinceFill - Number(latest.days_supply);
    if (overdue > 14) {
      findings.push({ type: "overdue_refill", drug, patientSays: mentioned.has(drug) ? "Says they take it" : "Not mentioned", recordSays: `Fill ${latest.fill_id} (${latest.fill_date}) was a ${latest.days_supply}-day supply; ran out ${overdue} days ago`, evidence: [latest.fill_id, pol("POL-REFILL")], severity: "medium", routeTo: "pharmacist", policy: pol("POL-REFILL"), detail: `${cap(drug)} refill overdue by ${overdue} days.`, foundBy: "rules" });
    } else if (!mentioned.has(drug)) {
      findings.push({ type: "fill_not_mentioned", drug, patientSays: "Not mentioned", recordSays: `Current fill ${latest.fill_id} (${latest.fill_date}): ${latest.strength}`, evidence: [latest.fill_id, pol("POL-NOTAKE")], severity: "low", routeTo: "nurse", policy: pol("POL-NOTAKE"), detail: `${cap(drug)} is on file but the patient did not mention it.`, foundBy: "rules" });
    }
  }
  return findings;
}

/** A model-only finding is rejected when the data the agent was given says otherwise. */
function contradicts(type: string, drug: string, mentions: Mention[], fills: Fill[]): string | undefined {
  const mentioned = mentions.some((m) => m.drug === drug || drug.includes(m.drug) || m.drug.includes(drug));
  const hasFill = fills.some((f) => norm(f.drug) === drug || drug.includes(norm(f.drug)));
  if (type === "fill_not_mentioned" && mentioned) return "the patient did mention it";
  if (type === "reported_no_record" && hasFill) return "a pharmacy fill exists for it";
  if (type === "dose_mismatch" && !mentioned) return "the patient never gave a strength for it";
  return undefined;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const Finding = z.object({
  type: z.enum(["dose_mismatch", "overdue_refill", "reported_no_record", "fill_not_mentioned"]),
  drug: z.string().max(80),
  patientSays: z.string().max(300),
  recordSays: z.string().max(400),
  evidence: z.array(z.string()).min(1).max(8),
  severity: z.enum(["high", "medium", "low"]),
  routeTo: z.enum(["nurse", "pharmacist"]),
  policy: z.string().max(20),
  detail: z.string().max(400),
});
const Out = z.object({ findings: z.array(Finding).max(15), notes: z.string().max(600).default("") });

export async function reconcile(c: Case): Promise<Discrepancy[]> {
  const agent = "Reconciler";
  const [fills, visits, policy] = await Promise.all([repo.getFills(c.id, agent, c.patientId), repo.getVisits(c.id, agent, c.patientId), repo.getPolicy(c.id, agent)]);
  c.records = { fills: fills.map((f) => f.fill_id), visits: visits.map((v) => v.visit_id) };
  const mentions = extractMentions(c, fills.map((f) => f.drug));
  const rules = ruleFindings(mentions, fills, visits, policy);
  trace({ caseId: c.id, agent, action: "rule_check", decision: `${mentions.length} medicine mention(s); ${rules.length} rule finding(s): ${rules.map((r) => `${r.type}:${r.drug}`).join(", ") || "none"}`, ok: true });

  const res = await callAgent({
    caseId: c.id,
    agent,
    lane: "deep",
    system: loadPrompt("reconciler"),
    user: JSON.stringify({
      claims: c.claims.filter((x) => x.topic === "medicines" || x.topic === "conditions").map((x) => ({ id: x.id, text: x.text_en })),
      photos: c.photos.map((p) => ({ id: p.id, fields: p.fields })),
      fills, visits,
      policy: policy.filter((p) => p.category === "medication"),
      rule_findings: rules,
    }),
    schema: Out,
    sample: () => ({ findings: rules.map(({ foundBy: _f, ...r }) => r) as z.infer<typeof Out>["findings"], notes: "Reviewed rule findings; no additional discrepancies." }),
    summarize: (o) => `${o.findings.length} finding(s) after review`,
  });

  // Grounding check: every cited ID must exist in the data the agent was given.
  const known = new Set<string>([...fills.map((f) => f.fill_id), ...visits.map((v) => v.visit_id), ...policy.map((p) => p.rule_id), ...c.photos.map((p) => p.id), ...c.claims.map((x) => x.id)]);
  const accepted: Omit<Discrepancy, "id">[] = [];
  for (const f of res.data.findings) {
    const bad = f.evidence.filter((e) => !known.has(e));
    if (bad.length) {
      trace({ caseId: c.id, agent, action: "rejected_finding", decision: `rejected unsupported ${f.type}:${f.drug} (unknown evidence ${bad.join(", ")})`, ok: false });
      continue;
    }
    const ruleTwin = rules.find((r) => r.type === f.type && norm(r.drug) === norm(f.drug));
    if (!ruleTwin) {
      const contradiction = contradicts(f.type, norm(f.drug), mentions, fills);
      if (contradiction) {
        trace({ caseId: c.id, agent, action: "rejected_finding", decision: `rejected ${f.type}:${f.drug} — ${contradiction}`, ok: false });
        continue;
      }
    }
    if (accepted.some((a) => a.type === f.type && a.drug === norm(f.drug))) continue;
    accepted.push({ ...f, drug: norm(f.drug), foundBy: ruleTwin ? "rules+model" : "model" });
  }
  // Safety net: rule findings are never silently dropped by the model.
  for (const r of rules) {
    if (!accepted.some((a) => a.type === r.type && a.drug === r.drug)) {
      accepted.push(r);
      trace({ caseId: c.id, agent, action: "kept_rule_finding", decision: `model omitted ${r.type}:${r.drug}; kept by policy`, ok: true });
    }
  }
  return accepted.map((d, i) => ({ ...d, id: `D-${i + 1}` }));
}

export type { DiscrepancyType };
