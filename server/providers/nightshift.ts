// Meterless Runtime (Nightshift) client, following the official
// POWER -> "Add Meterless as a provider" contract:
//  - base URL normalised to <host>/v1 (never /v1/v1)
//  - Authorization: Bearer <runtime token> on every call, 'rt-local' rejected
//  - meterless-app header on every call, meterless-scope: user on chat
//  - GET /v1/models decides status (200 online, 401/403 unauthorized, else offline)
//  - POST /v1/chat/completions (OpenAI-compatible), 180 s timeout
// Every call is traced with the model that actually answered.
import { config } from "../config.ts";
import { hashText, trace } from "../trace.ts";

export type Lane = "fast" | "deep" | "vision";
export type ProviderStatus = "online" | "unauthorized" | "offline" | "sample";

export class NightshiftOffline extends Error {}
export class NightshiftUnauthorized extends Error {}
/** Nightshift is up, but no lane can take images (no vision model configured). */
export class VisionUnavailable extends Error {}

type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface ChatMessage { role: "system" | "user" | "assistant"; content: string | ContentPart[] }

let backupMode = false;
/** Time of the last successful chat completion: a busy runtime is still online. */
let lastSuccessAt = 0;
/** Offline backup: Nightshift went away mid-demo; agents use their scripted responses and say so. */
export function setBackupMode(v: boolean): void { backupMode = v; }
export function inBackupMode(): boolean { return backupMode; }

function headers(chat: boolean): Record<string, string> {
  const token = config.meterless.token;
  if (!token || token === "rt-local") throw new NightshiftUnauthorized("Nightshift runtime token missing ('rt-local' is a placeholder). Copy the API key from Nightshift > Console.");
  return {
    Authorization: `Bearer ${token}`,
    "meterless-app": config.meterless.app,
    ...(chat ? { "meterless-scope": "user" } : {}),
    "Content-Type": "application/json",
  };
}

export async function listModels(): Promise<{ status: ProviderStatus; models: string[]; detail?: string }> {
  if (config.sampleMode) return { status: "sample", models: [] };
  const recentlyAnswered = Date.now() - lastSuccessAt < 180_000;
  try {
    const res = await fetch(`${config.meterless.baseUrl}/models`, { headers: headers(false), signal: AbortSignal.timeout(20_000) });
    if (res.status === 401 || res.status === 403) return { status: "unauthorized", models: [], detail: `HTTP ${res.status}` };
    if (!res.ok) return recentlyAnswered ? { status: "online", models: [], detail: `busy (HTTP ${res.status}); last answer under 3 min ago` } : { status: "offline", models: [], detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: { id: string }[] };
    const models = (body.data ?? []).map((m) => m.id);
    return models.length ? { status: "online", models } : { status: "offline", models, detail: "no models listed" };
  } catch (err) {
    if (err instanceof NightshiftUnauthorized) return { status: "unauthorized", models: [], detail: err.message };
    // While Nightshift is busy running Nemotron for the agents, /v1/models can be slow.
    // If it answered a real request recently, it's busy, not offline.
    if (recentlyAnswered) return { status: "online", models: [], detail: "busy serving agents; last answer under 3 min ago" };
    return { status: "offline", models: [], detail: (err as Error).message };
  }
}

function modelFor(lane: Lane): string {
  return lane === "fast" ? config.models.fast : lane === "deep" ? config.models.deep : config.models.vision;
}

interface RawReply { text: string; model: string; requestedModel: string; fallbackUsed: boolean; meta: Record<string, string>; usage?: unknown; ms: number }

async function post(model: string, messages: ChatMessage[], json: boolean): Promise<Response> {
  return fetch(`${config.meterless.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(180_000),
  });
}

async function complete(lane: Lane, messages: ChatMessage[], json: boolean): Promise<RawReply> {
  const requested = modelFor(lane);
  const started = Date.now();
  let model = requested;
  let fallbackUsed = false;
  let res: Response;
  try {
    res = await post(model, messages, json);
    // Some routes don't accept response_format: retry once without it.
    if (res.status === 400 && json) res = await post(model, messages, false);
    // Pinned model not available: fall back once to the routing mode.
    if (res.status === 404 || (res.status === 400 && /model/i.test(await res.clone().text()))) {
      model = config.models.fallback;
      fallbackUsed = true;
      res = await post(model, messages, false);
    }
  } catch (err) {
    if (err instanceof NightshiftUnauthorized) throw err;
    throw new NightshiftOffline(`Cannot reach Nightshift at ${config.meterless.baseUrl}: ${(err as Error).message}`);
  }
  // Busy or briefly unavailable (429/5xx): wait and retry once before giving up.
  if (res.status === 429 || res.status >= 500) {
    await new Promise((r) => setTimeout(r, 2500));
    try { res = await post(model, messages, false); } catch { /* fall through to the status checks */ }
  }
  if (res.status === 401 || res.status === 403) throw new NightshiftUnauthorized(`Nightshift rejected the runtime token (HTTP ${res.status})`);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    if (/image|vision/i.test(detail) && messages.some((m) => Array.isArray(m.content))) throw new VisionUnavailable(`Nightshift has no vision-capable model enabled: ${detail.slice(0, 160)}`);
    throw new NightshiftOffline(`Nightshift HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const meta: Record<string, string> = {};
  res.headers.forEach((v, k) => { if (k.toLowerCase().startsWith("meterless-") || k.toLowerCase().startsWith("x-meterless")) meta[k] = v; });
  const body = (await res.json()) as { model?: string; choices?: { message?: { content?: string | ContentPart[] } }[]; usage?: unknown; meterless?: Record<string, unknown> };
  const content = body.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => ("text" in p ? p.text : "")).join("") : "";
  const answered = String(body.meterless?.model ?? meta["meterless-model"] ?? body.model ?? model);
  lastSuccessAt = Date.now();
  if (backupMode) backupMode = false; // Nightshift is answering again: leave offline backup
  return { text, model: answered, requestedModel: requested, fallbackUsed, meta, usage: body.usage, ms: Date.now() - started };
}

export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error("model did not return JSON");
  }
}

export interface AgentCall<T> {
  caseId: string;
  agent: string;
  lane: Lane;
  system: string;
  user: string;
  image?: { dataUrl: string };
  /** Any zod schema (works with zod v3 and v4): parse() returns the validated output. */
  schema: { parse(input: unknown): T };
  /** Deterministic scripted answer used in SAMPLE_MODE and offline backup. */
  sample: () => T;
  summarize?: (out: T) => string;
}

export interface AgentResult<T> { data: T; model: string; source: "nightshift" | "sample" | "backup" }

/** JSON call with zod validation and exactly one repair retry. */
export async function callAgent<T>(c: AgentCall<T>): Promise<AgentResult<T>> {
  const inputHash = hashText(c.user);
  if (config.sampleMode || backupMode) {
    const started = Date.now();
    const data = c.schema.parse(c.sample());
    const source = config.sampleMode ? "sample" : "backup";
    const model = `${source}:${modelFor(c.lane)}`;
    trace({ caseId: c.caseId, agent: c.agent, action: "model_call", lane: c.lane, model, requestedModel: modelFor(c.lane), provider: source === "sample" ? "sample-replay" : "offline-backup", ms: Date.now() - started, inputHash, outputSummary: c.summarize?.(data), ok: true });
    return { data, model, source };
  }

  const userContent: ChatMessage["content"] = c.image
    ? [{ type: "text", text: c.user }, { type: "image_url", image_url: { url: c.image.dataUrl } }]
    : c.user;
  const messages: ChatMessage[] = [
    { role: "system", content: `${c.system}\n\nRespond with ONE JSON object only. No markdown, no commentary.` },
    { role: "user", content: userContent },
  ];
  let reply: RawReply | undefined;
  try {
    reply = await complete(c.lane, messages, true);
    let parsed: T;
    try {
      parsed = c.schema.parse(parseJsonLoose(reply.text));
    } catch (firstErr) {
      // one repair retry with the validation error
      trace({ caseId: c.caseId, agent: c.agent, action: "repair_retry", lane: c.lane, model: reply.model, ms: reply.ms, ok: false, error: String((firstErr as Error).message).slice(0, 200) });
      messages.push({ role: "assistant", content: reply.text.slice(0, 4000) }, { role: "user", content: `That reply failed validation: ${String((firstErr as Error).message).slice(0, 600)}. Return the corrected JSON object only.` });
      reply = await complete(c.lane, messages, true);
      parsed = c.schema.parse(parseJsonLoose(reply.text));
    }
    trace({ caseId: c.caseId, agent: c.agent, action: "model_call", lane: c.lane, model: reply.model, requestedModel: reply.requestedModel, fallbackUsed: reply.fallbackUsed, provider: "nightshift", ms: reply.ms, inputHash, outputSummary: c.summarize?.(parsed), ok: true });
    return { data: parsed, model: reply.model, source: "nightshift" };
  } catch (err) {
    trace({ caseId: c.caseId, agent: c.agent, action: "model_call", lane: c.lane, model: reply?.model, requestedModel: modelFor(c.lane), provider: "nightshift", inputHash, ok: false, error: (err as Error).message.slice(0, 300) });
    if (err instanceof NightshiftOffline || err instanceof NightshiftUnauthorized || err instanceof VisionUnavailable) throw err;
    // The model answered but its output failed validation twice: use the agent's
    // safe scripted answer for this step instead of breaking the case, and say so.
    const data = c.schema.parse(c.sample());
    trace({ caseId: c.caseId, agent: c.agent, action: "scripted_fallback", lane: c.lane, model: `fallback:${reply?.model ?? modelFor(c.lane)}`, provider: "scripted-fallback", inputHash, outputSummary: c.summarize?.(data), decision: "model output invalid after 1 repair; used the agent's safe scripted response", ok: false });
    return { data, model: `fallback:${reply?.model ?? modelFor(c.lane)}`, source: "backup" };
  }
}

/** Plain text call (used by the setup check and connection test). */
export async function pingModel(lane: Lane): Promise<{ text: string; model: string; fallbackUsed: boolean; ms: number }> {
  const r = await complete(lane, [{ role: "user", content: "Reply with one sentence confirming this connection works." }], false);
  return { text: r.text.trim(), model: r.model, fallbackUsed: r.fallbackUsed, ms: r.ms };
}
