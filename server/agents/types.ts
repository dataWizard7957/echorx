// Shared case state. Every agent reads and writes this one object through the
// orchestrator; it is persisted to var/cases/<id>.json.
import type { TraceEvent } from "../trace.ts";

export type Lang = "en" | "bn" | "ar" | "es";
export const LANGS: Lang[] = ["en", "bn", "ar", "es"];
export type Topic = "reason" | "symptoms" | "medicines" | "allergies" | "conditions" | "daily";
export const TOPICS: Topic[] = ["reason", "symptoms", "medicines", "allergies", "conditions", "daily"];

export interface QuickReply { label: string; en: string }
export interface Turn { role: "assistant" | "patient"; text: string; text_en?: string; ts: string; quickReplies?: QuickReply[]; kind?: "question" | "followup" | "info" | "emergency" | "booking" }
export interface Claim { id: string; topic: Topic; text_en: string; confidence: "high" | "medium" | "check"; source: "patient" | "photo" }
export interface PhotoField { label: string; value: string; confidence: "high" | "medium" | "check" }
export interface PhotoRead { id: string; sampleId?: string; fields: PhotoField[]; model: string; ts: string }

export type DiscrepancyType = "dose_mismatch" | "overdue_refill" | "reported_no_record" | "fill_not_mentioned" | "records_unavailable";
export interface Discrepancy {
  id: string;
  type: DiscrepancyType;
  drug: string;
  patientSays: string;
  recordSays: string;
  evidence: string[];
  severity: "high" | "medium" | "low";
  routeTo: "nurse" | "pharmacist";
  policy: string;
  detail: string;
  foundBy: "rules" | "model" | "rules+model" | "system";
}

export interface Critique { round: number; verdict: "approve" | "revise" | "escalate"; issues: string[]; questionsForPatient: { text: string; text_en: string }[]; model: string; overridden?: string }

export interface MemoryApplication { ruleId: string; rule: string; nurse: string; sourceCase: string; relevance: number; confidence: number }
export interface Escalation {
  id: string;
  discrepancyId: string;
  situation: string;
  reason: string;
  status: "open" | "resolved" | "auto_resolved";
  decision?: string;
  decidedBy?: string;
  savedRuleId?: string;
  memory?: MemoryApplication;
  feedback?: "helpful" | "wrong";
}

export interface Booking { stopId: string; slotId: string; site: string; area: string; van: string; date: string; weekday: string; time: string; distanceMi: number; languages: string[]; why: string; confirmation: string; confirmationEn?: string }

export interface VerifiedSummary {
  patientLine: string;
  reason: string[];
  symptoms: string[];
  medicines: { drug: string; current: string; note: string; evidence: string[] }[];
  allergies: string[];
  conditions: string[];
  daily: string[];
  flagsForPharmacist: string[];
  nurseDecisions: string[];
  generatedAt: string;
}

export type CaseStatus = "intake" | "emergency" | "processing" | "needs_patient" | "waiting_nurse" | "ready" | "approved";

export interface Case {
  id: string;
  patientId: string;
  patientName: string;
  language: Lang;
  status: CaseStatus;
  createdAt: string;
  updatedAt: string;
  transcript: Turn[];
  topicsCovered: Topic[];
  intakeTurns: number;
  pendingTopic?: Topic;
  pendingFollowups: { key: string; text: string; text_en: string }[];
  claims: Claim[];
  photos: PhotoRead[];
  records?: { fills: string[]; visits: string[] };
  discrepancies: Discrepancy[];
  critiques: Critique[];
  criticRounds: number;
  escalations: Escalation[];
  booking?: Booking;
  summary?: VerifiedSummary;
  redFlag?: { reason: string; rule: string; source: "rules" | "model" };
  approvedBy?: string;
  offlineBackup?: boolean;
  trace: TraceEvent[];
}
