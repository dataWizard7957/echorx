// Intake Agent: one question at a time in the patient's language; extracts
// English claims for the rest of the team.
import { z } from "zod";
import crypto from "node:crypto";
import { callAgent } from "../providers/nightshift.ts";
import { QUESTIONS, TEXT, FOLLOWUP_REPLIES } from "../i18n.ts";
import { loadPrompt } from "./prompts.ts";
import { trace } from "../trace.ts";
import { TOPICS, type Case, type Claim, type QuickReply, type Topic } from "./types.ts";

const TopicEnum = z.enum(["reason", "symptoms", "medicines", "allergies", "conditions", "daily"]);
const IntakeOut = z.object({
  reply: z.string().min(1).max(600),
  reply_en: z.string().max(600).optional(),
  quickReplies: z.array(z.object({ label: z.string().max(80), en: z.string().max(160) })).max(4).default([]),
  claims: z.array(z.object({ topic: TopicEnum, text_en: z.string().max(400), confidence: z.enum(["high", "medium", "check"]).default("high") })).max(12).default([]),
  topics_covered_now: z.array(TopicEnum).default([]),
  done: z.boolean().default(false),
});
export type IntakeOut = z.infer<typeof IntakeOut>;

export interface IntakeStep { reply: string; replyEn?: string; quickReplies: QuickReply[]; claims: Claim[]; covered: Topic[]; nextTopic?: Topic; followupKey?: string; done: boolean; model: string }

const nextUncovered = (covered: Topic[]): Topic | undefined => TOPICS.find((t) => !covered.includes(t));

/** Deterministic intake used by sample mode and as the offline backup. */
export function scriptedIntake(c: Case, answer?: { text: string; text_en?: string }): IntakeOut {
  const covered = new Set(c.topicsCovered);
  const claims: IntakeOut["claims"] = [];
  const answeredTopic = c.pendingTopic;
  if (answer && answeredTopic) {
    const en = answer.text_en || answer.text;
    if (!/^I'll take a photo$/i.test(en)) {
      const unsure = /not sure|unsure|don'?t know/i.test(en);
      claims.push({ topic: answeredTopic, text_en: en, confidence: unsure ? "check" : "high" });
      covered.add(answeredTopic);
    }
  }
  const lang = c.language;
  if (c.pendingFollowups.length) {
    const f = c.pendingFollowups[0];
    return { reply: `${TEXT.followupIntro[lang]} ${f.text}`, reply_en: `${TEXT.followupIntro.en} ${f.text_en}`, quickReplies: FOLLOWUP_REPLIES[f.key]?.[lang] ?? [], claims, topics_covered_now: [...covered], done: false };
  }
  if (answer?.text_en === "I'll take a photo") {
    return { reply: QUESTIONS.medicines[lang].text, reply_en: QUESTIONS.medicines.en.text, quickReplies: [], claims, topics_covered_now: [...covered], done: false };
  }
  const next = nextUncovered([...covered]);
  if (!next) return { reply: TEXT.doneIntake[lang], reply_en: TEXT.doneIntake.en, quickReplies: [], claims, topics_covered_now: [...covered], done: true };
  const q = QUESTIONS[next][lang];
  return { reply: q.text, reply_en: QUESTIONS[next].en.text, quickReplies: q.replies, claims, topics_covered_now: [...covered], done: false };
}

/** The quick reply the patient tapped, if their message is one of the options just offered. */
export function matchQuickReply(c: Case, answer?: { text: string; text_en?: string }): QuickReply | undefined {
  if (!answer) return undefined;
  const lastBot = [...c.transcript].reverse().find((t) => t.role === "assistant");
  const offered = lastBot?.quickReplies ?? [];
  const pool = [...offered, ...Object.values(QUESTIONS).flatMap((q) => q[c.language].replies), ...TEXT.photoThanksReplies[c.language]];
  return pool.find((q) => q.label === answer.text.trim());
}

const ExtractOut = z.object({
  claims: z.array(z.object({ topic: TopicEnum, text_en: z.string().max(400), confidence: z.enum(["high", "medium", "check"]).default("high") })).max(12).default([]),
  topics_covered_now: z.array(TopicEnum).default([]),
});

/**
 * One intake turn. The next question always comes from the reviewed question
 * bank (correct wording in each language, fixed topic order, no repeats).
 * Nemotron does the understanding: a free-text answer in any language is turned
 * into English claims on the fast lane. A tapped quick reply already carries its
 * English meaning, so it needs no model call.
 */
export async function intakeTurn(c: Case, answer?: { text: string; text_en?: string }): Promise<IntakeStep> {
  let extracted: z.infer<typeof ExtractOut> = { claims: [], topics_covered_now: [] };
  let model = "question-bank";
  const quick = matchQuickReply(c, answer);
  const photoIntent = answer && (quick?.en ?? answer.text_en) === "I'll take a photo";

  if (answer && !photoIntent) {
    if (quick) {
      const topic = c.pendingTopic;
      if (topic) extracted = { claims: [{ topic, text_en: quick.en, confidence: /not sure/i.test(quick.en) ? "check" : "high" }], topics_covered_now: [topic] };
      trace({ caseId: c.id, agent: "Intake", action: "quick_reply", decision: `patient tapped "${quick.en}" → ${topic ?? "no topic"} (meaning known, no model call needed)`, ok: true });
    } else {
      const res = await callAgent({
        caseId: c.id,
        agent: "Intake",
        lane: "fast",
        system: loadPrompt("intake"),
        user: JSON.stringify({
          language: c.language,
          question_topic: c.pendingTopic ?? null,
          question_asked_en: [...c.transcript].reverse().find((t) => t.role === "assistant")?.text_en ?? null,
          topics_already_covered: c.topicsCovered,
          patient_message: answer.text,
          patient_message_english_hint: answer.text_en ?? null,
        }),
        schema: ExtractOut,
        sample: () => ({ claims: c.pendingTopic ? [{ topic: c.pendingTopic, text_en: answer.text_en || answer.text, confidence: /not sure|unsure|don'?t know/i.test(answer.text_en ?? "") ? "check" as const : "high" as const }] : [], topics_covered_now: c.pendingTopic ? [c.pendingTopic] : [] }),
        summarize: (o) => `understood: ${o.claims.map((x) => `${x.topic}: "${x.text_en.slice(0, 60)}"`).join(" · ") || "nothing new"}`,
      });
      extracted = res.data;
      model = res.model;
    }
  }

  // Guard rails: the topic just answered counts as covered, and 12 turns ends intake.
  const covered = new Set<Topic>([...c.topicsCovered, ...extracted.topics_covered_now]);
  if (answer && c.pendingTopic && !photoIntent) covered.add(c.pendingTopic);
  for (const cl of extracted.claims) covered.add(cl.topic);
  const claims: Claim[] = extracted.claims.map((cl) => ({ id: `C-${crypto.randomUUID().slice(0, 6)}`, topic: cl.topic, text_en: cl.text_en, confidence: cl.confidence, source: "patient" }));

  // Next question from the question bank.
  const next = scriptedIntake({ ...c, topicsCovered: [...covered], pendingTopic: undefined }, photoIntent ? { text: "", text_en: "I'll take a photo" } : undefined);
  const capped = c.intakeTurns + 1 >= 12;
  const done = !c.pendingFollowups.length && (capped || !nextUncovered([...covered]));
  const nextTopic = done ? undefined : c.pendingFollowups.length ? undefined : photoIntent ? "medicines" : nextUncovered([...covered]);
  return {
    reply: done ? TEXT.doneIntake[c.language] : next.reply,
    replyEn: done ? TEXT.doneIntake.en : next.reply_en,
    quickReplies: done ? [] : next.quickReplies,
    claims,
    covered: [...covered],
    nextTopic,
    followupKey: c.pendingFollowups[0]?.key,
    done,
    model,
  };
}
