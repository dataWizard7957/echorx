// Memory Keeper: the H-MEM feature. Recalls a nurse rule before escalating, and
// turns a nurse's decision into a general rule after they resolve one.
import { z } from "zod";
import { callAgent } from "../providers/nightshift.ts";
import { recallRule, saveNurseRule, type CareRule } from "../hmem/careMemory.ts";
import { trace } from "../trace.ts";
import { loadPrompt } from "./prompts.ts";
import type { Case, Discrepancy, MemoryApplication } from "./types.ts";

export function recall(c: Case, d: Discrepancy): MemoryApplication | undefined {
  const started = Date.now();
  const hit = recallRule(d.type, `${d.drug}. Patient: ${d.patientSays}. Record: ${d.recordSays}`);
  trace({
    caseId: c.id,
    agent: "Memory Keeper",
    action: "hmem_query",
    tool: "H-MEM",
    ms: Date.now() - started,
    decision: hit ? `MATCH ${hit.rule.id} from ${hit.rule.nurse} (${hit.rule.sourceCase}) relevance ${hit.relevance.toFixed(2)} ≥ 0.35` : `no rule for ${d.type} (threshold 0.35)`,
    ok: true,
  });
  if (!hit) return undefined;
  return { ruleId: hit.rule.id, rule: hit.rule.rule, nurse: hit.rule.nurse, sourceCase: hit.rule.sourceCase, relevance: Number(hit.relevance.toFixed(3)), confidence: hit.rule.confidence };
}

const Out = z.object({ generalRule: z.string().min(10).max(500) });

const SAMPLE_RULES: Record<string, string> = {
  dose_mismatch: "Treat the bottle as outdated. List the latest pharmacy fill as the current dose, cite the visit that changed it, and ask the patient to bring every bottle to the van so the doctor can confirm.",
  overdue_refill: "Tell the pharmacist before the visit and ask the patient whether they still have tablets at home.",
  reported_no_record: "List it as patient-reported and ask the pharmacist to check other pharmacies and over-the-counter use.",
  fill_not_mentioned: "Ask the patient once whether they still take it; if unclear, list it for the doctor to review.",
};

export async function learn(c: Case, d: Discrepancy, decision: string, nurse: string): Promise<CareRule> {
  const res = await callAgent({
    caseId: c.id,
    agent: "Memory Keeper",
    lane: "fast",
    system: loadPrompt("memoryKeeper"),
    user: JSON.stringify({ situation: d.type, finding: d.detail, nurse_decision: decision }),
    schema: Out,
    sample: () => ({ generalRule: SAMPLE_RULES[d.type] ?? decision }),
    summarize: (o) => `rule: ${o.generalRule.slice(0, 100)}`,
  });
  // Strip anything patient-specific the model may have left in.
  const general = res.data.generalRule.replace(/\b[PFVCD]-\d{3,4}\b/g, "").replace(new RegExp(c.patientName.split(" ")[0], "gi"), "the patient");
  const rule = saveNurseRule({ situation: d.type, generalRule: general, nurse, caseId: c.id, drugs: [d.drug] });
  trace({ caseId: c.id, agent: "Memory Keeper", action: "hmem_write", tool: "H-MEM", decision: `stored ${rule.id} (confidence ${rule.confidence}) source nurse:${nurse}/case:${c.id}`, ok: true });
  return rule;
}
