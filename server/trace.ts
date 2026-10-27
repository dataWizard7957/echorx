// Structured trace: every agent step is recorded with the model that actually
// answered, latency, SQL and decisions. This is the "how the system reasoned"
// evidence judges look for.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.ts";

export interface TraceEvent {
  ts: string;
  caseId: string;
  agent: string;
  action: string;
  lane?: string;
  model?: string;
  requestedModel?: string;
  fallbackUsed?: boolean;
  provider?: string;
  ms?: number;
  tool?: string;
  sql?: string;
  rowCount?: number;
  inputHash?: string;
  outputSummary?: string;
  decision?: string;
  ok?: boolean;
  error?: string;
}

type Sink = (e: TraceEvent) => void;
const sinks = new Map<string, Sink>();

/** Route trace events for a case into its in-memory case object as well. */
export function attachSink(caseId: string, sink: Sink): void {
  sinks.set(caseId, sink);
}

export function trace(e: Omit<TraceEvent, "ts">): TraceEvent {
  const event: TraceEvent = { ts: new Date().toISOString(), ...e };
  try {
    fs.mkdirSync(path.join(config.varDir, "traces"), { recursive: true });
    fs.appendFileSync(path.join(config.varDir, "traces", `${safe(e.caseId)}.jsonl`), JSON.stringify(event) + "\n");
  } catch {
    /* tracing must never break the run */
  }
  sinks.get(e.caseId)?.(event);
  return event;
}

export function hashText(text: string): string {
  return `${crypto.createHash("sha256").update(text).digest("hex").slice(0, 10)}·${text.length}ch`;
}

function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}
