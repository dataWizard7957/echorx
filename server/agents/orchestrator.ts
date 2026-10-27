// Orchestrator: a state machine over one shared Case object.
//
//  INTAKE ⇄ SAFETY (every turn) ──red flag──► EMERGENCY
//    │ done
//    ▼
//  RECONCILE (Zetaris) ─► DRAFT ─► CRITIC ──revise (≤2 rounds)──► back to patient
//                                     │ escalate / approve
//                                     ▼
//               MEMORY RECALL (H-MEM) ── match ─► AUTO-RESOLVE (cited)
//                     │ no match
//                     ▼
//               WAITING FOR NURSE ─► nurse decides ─► MEMORY WRITE
//                                     ▼
//               SCHEDULE (Zetaris) ─► VERIFIED SUMMARY ─► READY / APPROVED
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.ts";
import { attachSink, trace } from "../trace.ts";
import { repo } from "../data/repository.ts";
import { ZetarisError } from "../data/zetaris.ts";
import { NightshiftOffline, NightshiftUnauthorized, setBackupMode } from "../providers/nightshift.ts";
import { TEXT } from "../i18n.ts";
import { ruleFeedback } from "../hmem/careMemory.ts";
import { intakeTurn, matchQuickReply } from "./intake.ts";
import { sentinelModel, sentinelRules } from "./safetySentinel.ts";
import { readBottle } from "./medReader.ts";
import { reconcile } from "./reconciler.ts";
import { critique, draftSummary, topicForFollowup } from "./summaryCritic.ts";
import { learn, recall } from "./memoryKeeper.ts";
import { schedule } from "./scheduler.ts";
import { FOLLOWUPS, FOLLOWUP_REPLIES } from "../i18n.ts";
import type { Case, Escalation, Lang } from "./types.ts";

const cases = new Map<string, Case>();
const locks = new Map<string, Promise<unknown>>();
const caseDir = path.join(config.varDir, "cases");

// Load cases from disk (cases survive a server restart).
for (const f of fs.existsSync(caseDir) ? fs.readdirSync(caseDir) : []) {
  if (!f.endsWith(".json")) continue;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(caseDir, f), "utf-8")) as Case;
    cases.set(c.id, c);
    attachSink(c.id, (e) => c.trace.push(e));
  } catch { /* ignore corrupt file */ }
}

function save(c: Case): Case {
  c.updatedAt = new Date().toISOString();
  fs.mkdirSync(caseDir, { recursive: true }); // survives `npm run reset` while the server is running
  fs.writeFileSync(path.join(caseDir, `${c.id}.json`), JSON.stringify(c, null, 2));
  return c;
}

/** Serialise work per case so two requests never interleave on the same state. */
function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(id, next.catch(() => undefined));
  return next;
}

/** Retry a step once in offline-backup mode if Nightshift disappears mid-run. */
async function resilient<T>(c: Case, step: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NightshiftOffline || err instanceof NightshiftUnauthorized) {
      c.offlineBackup = true;
      trace({ caseId: c.id, agent: "Orchestrator", action: "offline_backup", decision: `Nightshift unreachable during ${step}; this step uses offline backup responses, the next step tries Nightshift again`, ok: false, error: err.message });
      setBackupMode(true);
      try {
        return await fn();
      } finally {
        setBackupMode(false);
      }
    }
    throw err;
  }
}

export function getCase(id: string): Case | undefined { return cases.get(id); }
export function listCases(): Case[] { return [...cases.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

let seq = Math.max(1000, ...[...cases.keys()].map((k) => Number(k.replace(/\D/g, "")) || 0));

export async function createCase(patientId: string, language: Lang): Promise<Case> {
  const id = `EC-${++seq}`;
  const c: Case = {
    id, patientId, patientName: patientId, language, status: "intake", createdAt: new Date().toISOString(), updatedAt: "",
    transcript: [], topicsCovered: [], intakeTurns: 0, pendingFollowups: [], claims: [], photos: [], discrepancies: [], critiques: [], criticRounds: 0, escalations: [], trace: [],
  };
  cases.set(id, c);
  attachSink(id, (e) => c.trace.push(e));
  trace({ caseId: id, agent: "Orchestrator", action: "case_created", decision: `patient ${patientId}, language ${language}`, ok: true });
  return withLock(id, async () => {
    const patient = await repo.getPatient(id, "Orchestrator", patientId);
    if (!patient) throw new Error(`Unknown patient ${patientId}`);
    c.patientName = patient.display_name;
    const step = await resilient(c, "intake", () => intakeTurn(c));
    c.pendingTopic = step.nextTopic;
    c.transcript.push({ role: "assistant", text: step.reply, text_en: step.replyEn, ts: new Date().toISOString(), quickReplies: step.quickReplies, kind: "question" });
    return save(c);
  });
}

export async function handleMessage(id: string, msg: { text: string; text_en?: string }): Promise<Case> {
  const c = mustGet(id);
  return withLock(id, async () => {
    if (!["intake", "needs_patient"].includes(c.status)) return c;
    c.transcript.push({ role: "patient", text: msg.text.slice(0, 1000), text_en: msg.text_en?.slice(0, 1000), ts: new Date().toISOString() });
    c.intakeTurns++;

    const emergency = (flag: { reason?: string; rule?: string; source?: "rules" | "model" }) => {
      c.status = "emergency";
      c.redFlag = { reason: flag.reason ?? "Possible emergency", rule: flag.rule ?? "", source: flag.source ?? "rules" };
      c.transcript.push({ role: "assistant", text: `${TEXT.emergency[c.language]} ${TEXT.emergencyDetail[c.language]}`, text_en: `${TEXT.emergency.en} ${TEXT.emergencyDetail.en}`, ts: new Date().toISOString(), kind: "emergency" });
      trace({ caseId: c.id, agent: "Orchestrator", action: "branch", decision: `EMERGENCY branch: ${c.redFlag.reason} (${c.redFlag.rule}); intake stopped`, ok: true });
      return save(c);
    };

    // Safety first: deterministic rules before any model call.
    const byRules = sentinelRules(c.id, msg.text, msg.text_en);
    if (byRules.redFlag) return emergency(byRules);

    // Model double-check and Intake run in parallel (halves the wait per answer).
    // If the double-check fires, the Intake output is discarded.
    const answeringFollowup = c.status === "needs_patient" && c.pendingFollowups.length > 0;
    // A tapped quick reply is fixed text we wrote ("No symptoms", "Diabetes"…), so the
    // deterministic rules are enough; free text also gets the Nemotron double-check.
    const tapped = matchQuickReply(c, msg);
    if (tapped) trace({ caseId: c.id, agent: "Safety Sentinel", action: "model_check_skipped", decision: "quick reply from the reviewed list: rules are sufficient", ok: true });
    const [byModel, step] = await Promise.all([
      tapped ? Promise.resolve({ redFlag: false } as { redFlag: boolean; reason?: string; rule?: string; source?: "model" }) : sentinelModel(c.id, msg.text, msg.text_en),
      resilient(c, "intake", () => intakeTurn(c, msg)),
    ]);
    if (byModel.redFlag) {
      trace({ caseId: c.id, agent: "Orchestrator", action: "branch", decision: "model double-check fired: intake reply discarded", ok: true });
      return emergency(byModel);
    }
    c.claims.push(...step.claims);
    c.topicsCovered = step.covered;
    if (answeringFollowup) c.pendingFollowups.shift();

    if (c.status === "needs_patient" && !c.pendingFollowups.length) {
      trace({ caseId: c.id, agent: "Orchestrator", action: "branch", decision: "follow-up answered; re-running reconcile and critic", ok: true });
      save(c);
      await process(c);
      return save(c);
    }
    if (c.pendingFollowups.length) {
      const f = c.pendingFollowups[0];
      c.pendingTopic = topicForFollowup(f.text_en);
      c.transcript.push({ role: "assistant", text: `${TEXT.followupIntro[c.language]} ${f.text}`, text_en: `${TEXT.followupIntro.en} ${f.text_en}`, ts: new Date().toISOString(), kind: "followup", quickReplies: FOLLOWUP_REPLIES[f.key]?.[c.language] ?? [] });
      return save(c);
    }
    c.pendingTopic = step.nextTopic;
    c.transcript.push({ role: "assistant", text: step.reply, text_en: step.replyEn, ts: new Date().toISOString(), quickReplies: step.quickReplies, kind: step.done ? "info" : "question" });
    return save(c);
  });
}

export async function handlePhoto(id: string, image: { dataUrl?: string; sampleId?: string }): Promise<Case> {
  const c = mustGet(id);
  return withLock(id, async () => {
    const read = await resilient(c, "med reader", () => readBottle(c, image));
    c.photos.push(read);
    if (!c.topicsCovered.includes("medicines")) c.topicsCovered.push("medicines");
    const drug = read.fields.find((f) => /drug/i.test(f.label))?.value;
    const strength = read.fields.find((f) => /strength/i.test(f.label))?.value;
    c.transcript.push({ role: "patient", text: `📷 ${drug ?? "Pill bottle"} ${strength ?? ""}`.trim(), text_en: `Photo of pill bottle: ${drug ?? "unreadable"} ${strength ?? ""}`.trim(), ts: new Date().toISOString() });
    c.transcript.push({ role: "assistant", text: TEXT.photoThanks[c.language], text_en: TEXT.photoThanks.en, ts: new Date().toISOString(), quickReplies: TEXT.photoThanksReplies[c.language], kind: "question" });
    c.pendingTopic = "medicines";
    return save(c);
  });
}

export async function finish(id: string): Promise<Case> {
  const c = mustGet(id);
  return withLock(id, async () => {
    if (c.status !== "intake") return c;
    trace({ caseId: c.id, agent: "Orchestrator", action: "branch", decision: `intake finished after ${c.intakeTurns} turn(s); starting reconcile`, ok: true });
    await process(c);
    return save(c);
  });
}

async function process(c: Case): Promise<void> {
  c.status = "processing";
  save(c);
  const patient = await repo.getPatient(c.id, "Orchestrator", c.patientId).catch(() => undefined);

  // 1. Reconcile against Zetaris (or mark records unavailable and escalate).
  try {
    c.discrepancies = await resilient(c, "reconciler", () => reconcile(c));
  } catch (err) {
    if (!(err instanceof ZetarisError)) throw err;
    c.discrepancies = [{ id: "D-1", type: "records_unavailable", drug: "all medicines", patientSays: "See patient report", recordSays: "Zetaris unavailable", evidence: ["SYSTEM"], severity: "high", routeTo: "nurse", policy: "POL-DOSE", detail: "Pharmacy and visit records could not be read, so nothing was reconciled. A nurse must review.", foundBy: "system" }];
    trace({ caseId: c.id, agent: "Orchestrator", action: "branch", decision: "Zetaris unavailable: records not reconciled; escalating to nurse (never invent records)", ok: false, error: (err as Error).message });
  }
  save(c);

  // 2. Draft + critic loop.
  const draft = draftSummary(c);
  const review = await resilient(c, "critic", () => critique(c, draft));
  c.criticRounds = review.round;
  c.critiques.push(review);
  if (review.verdict === "revise") {
    c.status = "needs_patient";
    c.pendingFollowups = review.questionsForPatient.map((q) => ({ key: Object.keys(FOLLOWUPS).find((k) => FOLLOWUPS[k].en_text === q.text_en) ?? "critic", text: q.text, text_en: q.text_en }));
    const f = c.pendingFollowups[0];
    c.pendingTopic = topicForFollowup(f.text_en);
    c.transcript.push({ role: "assistant", text: `${TEXT.followupIntro[c.language]} ${f.text}`, text_en: `${TEXT.followupIntro.en} ${f.text_en}`, ts: new Date().toISOString(), kind: "followup", quickReplies: FOLLOWUP_REPLIES[f.key]?.[c.language] ?? [] });
    trace({ caseId: c.id, agent: "Orchestrator", action: "branch", decision: `critic round ${review.round} REVISE → ${c.pendingFollowups.length} question(s) sent back to patient`, ok: true });
    return;
  }

  // 3. Nurse items: H-MEM recall first, otherwise escalate.
  for (const d of c.discrepancies.filter((x) => x.routeTo === "nurse")) {
    if (c.escalations.some((e) => e.discrepancyId === d.id && e.status !== "open")) continue;
    c.escalations = c.escalations.filter((e) => e.discrepancyId !== d.id);
    const mem = d.type === "records_unavailable" ? undefined : recall(c, d);
    const esc: Escalation = { id: `ESC-${crypto.randomUUID().slice(0, 6)}`, discrepancyId: d.id, situation: d.type, reason: d.detail, status: mem ? "auto_resolved" : "open", memory: mem };
    c.escalations.push(esc);
    trace({ caseId: c.id, agent: "Orchestrator", action: "branch", decision: mem ? `${d.id} ${d.type}: AUTO-RESOLVED from memory ${mem.ruleId} (${mem.nurse}, ${mem.sourceCase})` : `${d.id} ${d.type}: ESCALATED to nurse inbox`, ok: true });
  }

  // 4. Schedule from Zetaris van stops and slots.
  if (!c.booking && patient) {
    try {
      c.booking = await resilient(c, "scheduler", () => schedule(c, patient));
    } catch (err) {
      trace({ caseId: c.id, agent: "Scheduler", action: "error", ok: false, error: (err as Error).message });
    }
  }

  // 5. Verified summary + status.
  c.summary = draftSummary(c);
  const open = c.escalations.filter((e) => e.status === "open").length;
  c.status = open ? "waiting_nurse" : "ready";
  c.transcript.push({ role: "assistant", text: TEXT.nurseChecking[c.language], text_en: TEXT.nurseChecking.en, ts: new Date().toISOString(), kind: "info" });
  if (c.booking) c.transcript.push({ role: "assistant", text: c.booking.confirmation, text_en: c.booking.confirmationEn, ts: new Date().toISOString(), kind: "booking" });
  trace({ caseId: c.id, agent: "Orchestrator", action: "state", decision: `status ${c.status.toUpperCase()} · ${open} open escalation(s) · ${c.escalations.filter((e) => e.status === "auto_resolved").length} from memory`, ok: true });
}

export async function nurseDecide(id: string, escalationId: string, decision: string, saveAsRule: boolean, nurse: string): Promise<Case> {
  const c = mustGet(id);
  return withLock(id, async () => {
    const esc = c.escalations.find((e) => e.id === escalationId);
    if (!esc) throw new Error("Unknown escalation");
    const d = c.discrepancies.find((x) => x.id === esc.discrepancyId)!;
    esc.status = "resolved";
    esc.decision = decision.slice(0, 600);
    esc.decidedBy = nurse;
    trace({ caseId: c.id, agent: "Nurse", action: "decision", decision: `${nurse} resolved ${d.id} ${d.type}: ${esc.decision}`, ok: true });
    if (saveAsRule && d.type !== "records_unavailable") {
      const rule = await resilient(c, "memory keeper", () => learn(c, d, decision, nurse));
      esc.savedRuleId = rule.id;
    }
    c.summary = draftSummary(c);
    if (!c.escalations.some((e) => e.status === "open")) c.status = "ready";
    return save(c);
  });
}

export async function nurseApprove(id: string, nurse: string): Promise<Case> {
  const c = mustGet(id);
  return withLock(id, async () => {
    if (c.escalations.some((e) => e.status === "open")) throw new Error("Resolve open escalations first");
    for (const e of c.escalations.filter((x) => x.status === "auto_resolved" && x.memory && !x.feedback)) {
      const r = ruleFeedback(e.memory!.ruleId, "helpful");
      e.feedback = "helpful";
      trace({ caseId: c.id, agent: "Memory Keeper", action: "hmem_feedback", tool: "H-MEM", decision: `helpful → ${e.memory!.ruleId} confidence ${r?.confidence.toFixed(2)}`, ok: true });
    }
    c.status = "approved";
    c.approvedBy = nurse;
    c.summary = draftSummary(c);
    trace({ caseId: c.id, agent: "Nurse", action: "approve", decision: `${nurse} verified the summary; visible to doctor and pharmacist`, ok: true });
    return save(c);
  });
}

export async function memoryWrong(id: string, escalationId: string, nurse: string): Promise<Case> {
  const c = mustGet(id);
  return withLock(id, async () => {
    const e = c.escalations.find((x) => x.id === escalationId);
    if (!e?.memory) throw new Error("Not a memory resolution");
    const r = ruleFeedback(e.memory.ruleId, "wrong");
    e.feedback = "wrong";
    e.status = "open";
    c.status = "waiting_nurse";
    trace({ caseId: c.id, agent: "Memory Keeper", action: "hmem_feedback", tool: "H-MEM", decision: `${nurse} marked ${e.memory.ruleId} WRONG → confidence ${r?.confidence.toFixed(2)}, tagged for review; item reopened`, ok: true });
    c.summary = draftSummary(c);
    return save(c);
  });
}

export async function nurseAsk(id: string, question: string, nurse: string): Promise<Case> {
  const c = mustGet(id);
  return withLock(id, async () => {
    c.pendingFollowups.push({ key: "nurse", text: question, text_en: question });
    c.status = "needs_patient";
    c.pendingTopic = topicForFollowup(question);
    c.transcript.push({ role: "assistant", text: `${TEXT.followupIntro[c.language]} ${question}`, text_en: `${TEXT.followupIntro.en} ${question}`, ts: new Date().toISOString(), kind: "followup" });
    trace({ caseId: c.id, agent: "Nurse", action: "ask_patient", decision: `${nurse} asked: ${question}`, ok: true });
    return save(c);
  });
}

export function inbox() {
  const all = listCases();
  return {
    needsYou: all.filter((c) => c.status === "waiting_nurse"),
    autoResolved: all.filter((c) => c.escalations.some((e) => e.status === "auto_resolved") && c.status !== "waiting_nurse"),
    ready: all.filter((c) => c.status === "ready"),
    approved: all.filter((c) => c.status === "approved"),
    emergencies: all.filter((c) => c.status === "emergency"),
    inProgress: all.filter((c) => ["intake", "processing", "needs_patient"].includes(c.status)),
  };
}

export function resetAll(): void {
  for (const id of cases.keys()) fs.rmSync(path.join(caseDir, `${id}.json`), { force: true });
  cases.clear();
}

function mustGet(id: string): Case {
  const c = cases.get(id);
  if (!c) throw new Error(`Unknown case ${id}`);
  return c;
}
