// Safety Sentinel. Runs on EVERY patient message.
// 1) Deterministic rules first (en, bn, ar, es, with negation handling) — no model needed.
// 2) Then a model double-check on the fast lane (live mode) for phrasing the rules miss.
import { z } from "zod";
import { callAgent } from "../providers/nightshift.ts";
import { trace } from "../trace.ts";
import { loadPrompt } from "./prompts.ts";

interface Rule { id: string; reason: string; patterns: RegExp[] }

export const RED_FLAG_RULES: Rule[] = [
  { id: "RF-01", reason: "Chest pain", patterns: [/\bchest (?:pain|pressure|tightness|hurts?)\b|\bpain in (?:my|the) chest\b/i, /বুকে (?:ব্যথা|চাপ)|বুক ব্যথা/, /ألم (?:في )?الصدر|وجع (?:في )?الصدر|ضيق (?:في )?الصدر/, /dolor (?:en el |de )?pecho|presi[oó]n en el pecho/i] },
  { id: "RF-02", reason: "Trouble breathing", patterns: [/\b(?:trouble|difficulty|hard) breathing\b|\b(?:can'?t|cannot) breathe\b|\bshort(?:ness)? of breath\b/i, /শ্বাস (?:নিতে )?কষ্ট|শ্বাসকষ্ট/, /ضيق (?:في )?التنفس|صعوبة (?:في )?التنفس|لا أستطيع التنفس/, /no puedo respirar|dificultad para respirar|falta de aire/i] },
  { id: "RF-03", reason: "Possible stroke signs", patterns: [/\b(?:face (?:is )?droop(?:ing)?|drooping face|arm weakness|slurred speech|can'?t (?:move|lift) my arm)\b/i, /মুখ বেঁকে|কথা জড়িয়ে|হাত অবশ/, /تدلي الوجه|ضعف (?:في )?الذراع|ثقل (?:في )?الكلام|كلام متداخل/, /cara ca[ií]da|habla arrastrada|debilidad en el brazo/i] },
  { id: "RF-04", reason: "Severe bleeding", patterns: [/\b(?:severe|heavy|uncontrolled|won'?t stop) bleeding\b|\bbleeding (?:a lot|heavily|won'?t stop)\b/i, /অনেক রক্ত|রক্তপাত থামছে না/, /نزيف (?:شديد|لا يتوقف)/, /sangrado (?:fuerte|abundante|que no para)/i] },
  { id: "RF-05", reason: "Fainting", patterns: [/\b(?:faint(?:ed|ing)?|passed out|passing out|blacked out)\b/i, /অজ্ঞান|জ্ঞান হারিয়ে/, /إغماء|أغمي عل[يى]|فقدت الوعي/, /desmay(?:é|e|o|ado)|perd[ií] el conocimiento/i] },
  { id: "RF-06", reason: "Thoughts of self-harm", patterns: [/\b(?:self[- ]harm|suicid\w*|kill myself|hurt myself|end my life|don'?t want to live)\b/i, /আত্মহত্যা|নিজেকে (?:আঘাত|শেষ)/, /إيذاء نفسي|الانتحار|أقتل نفسي|أنهي حياتي/, /suicid\w*|hacerme daño|quitarme la vida|matarme/i] },
];

// Negation only counts when it sits right next to the symptom, in that language's
// word order: before it in English, Arabic and Spanish ("no chest pain",
// "لا يوجد ألم في الصدر", "no tengo dolor en el pecho"), after it in Bengali
// ("বুকে ব্যথা নেই"). So "my chest pain does not go away" is still a red flag.
const NEGATION: { re: RegExp; where: "before" | "after"; window: number }[] = [
  { re: /(?:^|\s)(?:no|not|never|denies|without|don'?t have|do not have|haven'?t had|didn'?t have|no more)\s+(?:\w+\s+){0,2}$/i, where: "before", window: 40 },
  { re: /^\s*(?:নেই|নাই|হয় না|হচ্ছে না|ছিল না)/, where: "after", window: 15 },
  { re: /(?:^|\s)(?:لا|ليس|ليست|بدون|لم)\s+(?:\S+\s+){0,2}$/, where: "before", window: 30 },
  { re: /(?:^|\s)(?:no|nunca|sin|ningún|ninguna)\s+(?:\S+\s+){0,2}$/i, where: "before", window: 35 },
];

export interface RuleResult { redFlag: boolean; reason?: string; rule?: string }

function negated(clause: string, langIndex: number, index: number, length: number): boolean {
  const n = NEGATION[langIndex];
  const context = n.where === "before" ? clause.slice(Math.max(0, index - n.window), index) : clause.slice(index + length, index + length + n.window);
  return n.re.test(context);
}

export function checkRedFlagRules(text: string): RuleResult {
  const clauses = text.split(/[.!?;\n।؟،,]|\bbut\b|\bpero\b|لكن|কিন্তু/i).map((c) => c.trim()).filter(Boolean);
  for (const rule of RED_FLAG_RULES) {
    for (const clause of clauses) {
      for (let lang = 0; lang < rule.patterns.length; lang++) {
        const m = rule.patterns[lang].exec(clause);
        if (m && !negated(clause, lang, m.index, m[0].length)) return { redFlag: true, reason: rule.reason, rule: rule.id };
      }
    }
  }
  return { redFlag: false };
}

const ModelCheck = z.object({ redFlag: z.boolean(), reason: z.string().default("") });

/** Step 1: deterministic rules. Runs before any model call, every message. */
export function sentinelRules(caseId: string, text: string, text_en?: string): RuleResult & { source?: "rules" } {
  const started = Date.now();
  const byRules = checkRedFlagRules(`${text}\n${text_en ?? ""}`);
  trace({ caseId, agent: "Safety Sentinel", action: "rule_check", ms: Date.now() - started, decision: byRules.redFlag ? `RED FLAG ${byRules.rule}: ${byRules.reason}` : "no red flag by rules", ok: true });
  return byRules.redFlag ? { ...byRules, source: "rules" } : { redFlag: false };
}

/** Step 2: model double-check on the fast lane. The orchestrator runs it in
 *  parallel with the Intake agent and discards intake output if it fires. */
export async function sentinelModel(caseId: string, text: string, text_en?: string): Promise<RuleResult & { source?: "model" }> {
  try {
    const res = await callAgent({
      caseId,
      agent: "Safety Sentinel",
      lane: "fast",
      system: loadPrompt("safetySentinel"),
      user: JSON.stringify({ patient_message: text, english: text_en ?? null }),
      schema: ModelCheck,
      sample: () => ({ redFlag: false, reason: "" }),
      summarize: (o) => (o.redFlag ? `model double-check: RED FLAG (${o.reason})` : "model double-check: clear"),
    });
    if (res.data.redFlag) return { redFlag: true, reason: res.data.reason || "Possible emergency", rule: "MODEL", source: "model" };
  } catch {
    // Model unavailable: the deterministic rules already ran, so continue safely.
  }
  return { redFlag: false };
}

/** Rules first, then the model (sequential). Kept for callers that need one call. */
export async function sentinel(caseId: string, text: string, text_en?: string): Promise<RuleResult & { source?: "rules" | "model" }> {
  const byRules = sentinelRules(caseId, text, text_en);
  return byRules.redFlag ? byRules : sentinelModel(caseId, text, text_en);
}
