// Summary Critic: checks the draft summary for gaps, unsupported claims and
// anything that looks like a diagnosis or dose judgement. Deterministic checks
// run first; the deep model reviews on top; policy can override the model.
import { z } from "zod";
import { callAgent } from "../providers/nightshift.ts";
import { FOLLOWUPS } from "../i18n.ts";
import { trace } from "../trace.ts";
import { loadPrompt } from "./prompts.ts";
import { TOPICS, type Case, type Critique, type Discrepancy, type Topic, type VerifiedSummary } from "./types.ts";

export function draftSummary(c: Case): VerifiedSummary {
  const by = (t: Topic) => c.claims.filter((x) => x.topic === t).map((x) => `${x.text_en}${x.confidence === "check" ? " (patient unsure)" : ""}`);
  const medsFromRecords = new Map<string, { drug: string; current: string; note: string; evidence: string[] }>();
  for (const d of c.discrepancies) {
    const esc = c.escalations.find((e) => e.discrepancyId === d.id);
    const note =
      esc?.status === "resolved" ? `Nurse decision: ${esc.decision}`
      : esc?.status === "auto_resolved" ? `Applied rule from ${esc.memory?.nurse} (${esc.memory?.sourceCase}): ${esc.memory?.rule}`
      : d.routeTo === "nurse" ? "Waiting for nurse review"
      : `Flag for pharmacist (${d.policy})`;
    medsFromRecords.set(`${d.drug}:${d.type}`, { drug: d.drug, current: d.recordSays, note: `${d.detail} ${note}`.trim(), evidence: d.evidence });
  }
  return {
    patientLine: `${c.patientName} · prefers ${langName(c.language)} · ${c.photos.length} bottle photo(s)`,
    reason: by("reason"),
    symptoms: by("symptoms"),
    medicines: [...by("medicines").map((m) => ({ drug: "Patient report", current: m, note: "", evidence: [] })), ...c.photos.map((p) => ({ drug: "Bottle photo", current: p.fields.map((f) => `${f.label}: ${f.value}`).join("; "), note: `Read by ${p.model}`, evidence: [p.id] })), ...medsFromRecords.values()],
    allergies: by("allergies"),
    conditions: by("conditions"),
    daily: by("daily"),
    flagsForPharmacist: c.discrepancies.filter((d) => d.routeTo === "pharmacist").map((d) => `${d.detail} [${d.evidence.join(", ")}]`),
    nurseDecisions: c.escalations.filter((e) => e.status !== "open").map((e) => (e.status === "resolved" ? `${e.decidedBy}: ${e.decision}` : `From memory (${e.memory?.sourceCase}, ${e.memory?.nurse}): ${e.memory?.rule}`)),
    generatedAt: new Date().toISOString(),
  };
}

const langName = (l: string) => ({ en: "English", bn: "Bengali", ar: "Arabic", es: "Spanish" })[l] ?? l;

const DIAGNOSIS = /\b(diagnos\w*|you have (?:a |an )?\w+ (?:disease|disorder)|likely (?:has|have)|should (?:take|stop|increase|decrease)|increase the dose|decrease the dose|prescribe|treatment plan|the correct dose is)\b/i;

export interface DeterministicReview { missing: Topic[]; followups: string[]; issues: string[]; nurseItems: Discrepancy[] }

export function deterministicReview(c: Case, draft: VerifiedSummary): DeterministicReview {
  const missing = TOPICS.filter((t) => !c.claims.some((x) => x.topic === t));
  const issues: string[] = [];
  const followups: string[] = [];
  const symptomText = c.claims.filter((x) => x.topic === "symptoms").map((x) => x.text_en).join(" ");
  const hasSymptoms = symptomText && !/^\s*no symptoms\b/i.test(symptomText);
  const hasDuration = /\b(day|week|month|year|since|today|yesterday|hour|minute)s?\b|\d/i.test(symptomText);
  if (hasSymptoms && !hasDuration) { issues.push("Symptoms have no duration or severity"); followups.push("symptom_duration"); }
  if (missing.includes("allergies")) { issues.push("Allergies not recorded"); followups.push("allergies_missing"); }
  if (missing.includes("medicines") && !c.photos.length) { issues.push("Medicines not recorded"); followups.push("medicines_missing"); }
  for (const t of missing.filter((t) => !["allergies", "medicines"].includes(t))) issues.push(`Topic not covered: ${t}`);
  const text = JSON.stringify(draft);
  if (DIAGNOSIS.test(text)) issues.push("Summary contains diagnosis or dose-judgement language");
  for (const d of c.discrepancies) if (!d.evidence.length) issues.push(`Finding ${d.id} has no evidence`);
  const nurseItems = c.discrepancies.filter((d) => d.routeTo === "nurse");
  return { missing, followups: followups.slice(0, 2), issues, nurseItems };
}

const Out = z.object({
  verdict: z.enum(["approve", "revise", "escalate"]),
  issues: z.array(z.string().max(300)).max(10).default([]),
  questionsForPatient: z.array(z.object({ text: z.string().max(300), text_en: z.string().max(300) })).max(2).default([]),
});

export async function critique(c: Case, draft: VerifiedSummary): Promise<Critique> {
  const round = c.criticRounds + 1;
  const det = deterministicReview(c, draft);
  trace({ caseId: c.id, agent: "Summary Critic", action: "rule_check", decision: `round ${round}: ${det.issues.length} issue(s)${det.issues.length ? ` (${det.issues.join("; ")})` : ""}; ${det.nurseItems.length} item(s) need a nurse by policy`, ok: true });

  const sampleVerdict = (): z.infer<typeof Out> => {
    if (det.followups.length && round <= 2) return { verdict: "revise", issues: det.issues, questionsForPatient: det.followups.map((k) => ({ text: FOLLOWUPS[k][c.language], text_en: FOLLOWUPS[k].en_text })) };
    if (det.nurseItems.length) return { verdict: "escalate", issues: [...det.issues, ...det.nurseItems.map((d) => `${d.id} ${d.type} (${d.drug}) must be reviewed by a nurse per ${d.policy}`)], questionsForPatient: [] };
    return { verdict: "approve", issues: det.issues, questionsForPatient: [] };
  };

  const res = await callAgent({
    caseId: c.id,
    agent: "Summary Critic",
    lane: "deep",
    system: loadPrompt("summaryCritic"),
    user: JSON.stringify({ language: c.language, round, draft_summary: draft, claims: c.claims, discrepancies: c.discrepancies, deterministic_issues: det.issues }),
    schema: Out,
    sample: sampleVerdict,
    summarize: (o) => `verdict ${o.verdict.toUpperCase()}${o.issues.length ? ` · ${o.issues[0].slice(0, 80)}` : ""}`,
  });

  let { verdict } = res.data;
  let questions = res.data.questionsForPatient;
  let overridden: string | undefined;
  // Policy overrides: deterministic gaps loop back (max 2 rounds); nurse items can't be approved away.
  if (det.followups.length && round <= 2 && verdict !== "revise") {
    overridden = `model said ${verdict}; deterministic gaps require patient follow-up`;
    verdict = "revise";
  }
  if (verdict === "revise" && !questions.length) questions = det.followups.map((k) => ({ text: FOLLOWUPS[k][c.language], text_en: FOLLOWUPS[k].en_text }));
  if (verdict === "revise" && (round > 2 || !questions.length)) {
    overridden = `revise limit reached (round ${round}); proceeding`;
    verdict = det.nurseItems.length ? "escalate" : "approve";
  }
  if (verdict === "approve" && det.nurseItems.length) {
    overridden = `model said approve; policy ${det.nurseItems.map((d) => d.policy).join(", ")} requires a nurse`;
    verdict = "escalate";
  }
  if (overridden) trace({ caseId: c.id, agent: "Summary Critic", action: "policy_override", decision: overridden, ok: true });
  return { round, verdict, issues: [...new Set([...det.issues, ...res.data.issues])], questionsForPatient: verdict === "revise" ? questions : [], model: res.model, overridden };
}

/** Map a follow-up question back to the topic its answer belongs to. */
export function topicForFollowup(textEn: string): Topic {
  if (/allerg/i.test(textEn)) return "allergies";
  if (/medicine|medication|pill/i.test(textEn)) return "medicines";
  if (/car|walk|food|housing|transport/i.test(textEn)) return "daily";
  return "symptoms";
}
