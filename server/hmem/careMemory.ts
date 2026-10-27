// EchoRx's working feature on top of H-MEM: nurse decisions become reusable,
// cited, auditable rules that persist across sessions (file-backed).
import { HMEM, type MemoryRecord } from "./index.ts";
import { config } from "../config.ts";

/** Canonical wording per situation, so a later similar case retrieves the rule. */
export const SITUATIONS: Record<string, string> = {
  dose_mismatch: "dose mismatch: the strength on the pill bottle or the patient's report differs from the latest pharmacy fill, and a visit record shows a dose change",
  overdue_refill: "overdue refill: a pharmacy fill ran out more than 14 days ago and the patient says they still take the medicine",
  reported_no_record: "reported medicine with no pharmacy fill record, possibly over the counter or filled elsewhere",
  fill_not_mentioned: "medicine filled at the pharmacy but not mentioned by the patient",
};

export interface CareRule {
  id: string;
  situation: string;
  rule: string;
  nurse: string;
  sourceCase: string;
  confidence: number;
  createdAt: number;
  tags: string[];
}

export interface RecallHit { rule: CareRule; relevance: number }

let instance: HMEM | undefined;
let instanceDir: string | undefined;

export function memory(dir = config.hmemDir): HMEM {
  if (!instance || instanceDir !== dir) {
    instance = new HMEM({ persistDir: dir, actor: "echorx" });
    instanceDir = dir;
  }
  return instance;
}

/** For tests: drop the in-process instance so the next call reloads from disk ("restart"). */
export function resetMemoryInstance(): void {
  instance = undefined;
  instanceDir = undefined;
}

function toRule(r: MemoryRecord): CareRule {
  const tag = (prefix: string) => r.tags.find((t) => t.startsWith(prefix))?.slice(prefix.length) ?? "";
  return {
    id: r.id,
    situation: tag("situation:"),
    rule: r.content.replace(/^RULE[^:]*:\s*/, "").replace(/^When [^.]*\.\s*/, ""),
    nurse: tag("nurse:"),
    sourceCase: tag("case:"),
    confidence: r.confidence,
    createdAt: r.timestamp,
    tags: r.tags,
  };
}

export function saveNurseRule(input: { situation: string; generalRule: string; nurse: string; caseId: string; drugs?: string[] }, dir?: string): CareRule {
  const hmem = memory(dir);
  const when = SITUATIONS[input.situation] ?? input.situation;
  const record = hmem.add({
    content: `RULE ${input.situation}: When ${when}. ${input.generalRule}`,
    type: "factual",
    layer: "long_term",
    confidence: 0.9,
    source: `nurse:${input.nurse}/case:${input.caseId}`,
    provenance: { origin: "user_correction", learnedAt: Date.now(), label: `Nurse decision on ${input.caseId}`, refs: [input.caseId] },
    tags: ["nurse_rule", `situation:${input.situation}`, `nurse:${input.nurse}`, `case:${input.caseId}`, ...(input.drugs ?? []).map((d) => `drug:${d}`)],
  });
  return toRule(record);
}

export function recallRule(situation: string, detail: string, dir?: string): RecallHit | undefined {
  const hmem = memory(dir);
  const when = SITUATIONS[situation] ?? situation;
  const result = hmem.query(`RULE ${situation}: When ${when}. ${detail}`, { topN: 3 });
  const hit = result.memories.find((m) => m.memory.tags.includes(`situation:${situation}`) && !m.memory.supersededBy && !m.memory.tags.includes("review"));
  return hit ? { rule: toRule(hit.memory), relevance: hit.relevance } : undefined;
}

export function ruleFeedback(id: string, kind: "helpful" | "not_helpful" | "wrong", dir?: string): CareRule | undefined {
  const hmem = memory(dir);
  hmem.feedback(id, kind);
  const rec = hmem.store.all().find((r) => r.id === id);
  return rec ? toRule(rec) : undefined;
}

export function listRules(dir?: string): CareRule[] {
  return memory(dir).store.all().filter((r) => r.tags.includes("nurse_rule")).map(toRule).sort((a, b) => b.createdAt - a.createdAt);
}

export function ledgerFor(id: string, dir?: string): unknown[] {
  return [...memory(dir).ledger.history(id)];
}
