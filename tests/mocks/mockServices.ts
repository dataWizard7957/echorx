// Mock Zetaris REST + Meterless Nightshift for testing EchoRx's LIVE code paths
// without the real services. It enforces the contracts the real ones require
// (headers, one statement, auth) so a passing test means the clients are wired
// correctly. Not used by the app itself.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VIEWS = JSON.parse(fs.readFileSync(path.join(ROOT, "zetaris", "views.json"), "utf-8")) as Record<string, string[]>;
const data = (v: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", `${v}.json`), "utf-8")).data as Record<string, unknown>[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const calls = { sql: [] as string[], chat: [] as { model: string; agent: string; headers: Record<string, string> }[] };

function runSelect(sql: string): unknown[][] {
  if (/^select 1$/i.test(sql.trim())) return [[1]];
  const m = /^SELECT (.+?) FROM echorx\.(\w+)(?: WHERE (.+?))?(?: ORDER BY (\w+)(?: (ASC|DESC))?)?$/i.exec(sql.trim());
  if (!m) throw new Error(`mock cannot parse: ${sql}`);
  const [, colsRaw, view, where, order] = m;
  let rows = data(view);
  if (where) {
    for (const cond of where.split(/ AND /i)) {
      const eq = /^(\w+) = '([^']*)'$/.exec(cond.trim());
      const inn = /^(\w+) IN \((.+)\)$/.exec(cond.trim());
      if (eq) rows = rows.filter((r) => String(r[eq[1]]) === eq[2]);
      else if (inn) { const vals = inn[2].split(",").map((x) => x.trim().replace(/^'|'$/g, "")); rows = rows.filter((r) => vals.includes(String(r[inn[1]]))); }
    }
  }
  if (order) rows = [...rows].sort((a, b) => (String(a[order]) < String(b[order]) ? -1 : 1));
  if (/^COUNT\(\*\)/i.test(colsRaw)) return [[rows.length]];
  const cols = colsRaw.split(",").map((c) => c.trim());
  for (const c of cols) if (!VIEWS[view].includes(c)) throw new Error(`unknown column ${c}`);
  // Zetaris returns values as strings/numbers; send numbers as strings to test coercion.
  return rows.map((r) => cols.map((c) => (typeof r[c] === "number" ? String(r[c]) : r[c])));
}

function agentOf(system: string): string {
  return /# Role: ([A-Za-z ]+?) \(/.exec(system)?.[1] ?? "unknown";
}

function chatReply(agent: string, user: string): unknown {
  let u: any = {};
  try { u = JSON.parse(user); } catch { /* vision text */ }
  switch (agent) {
    case "Intake Agent": {
      const order = ["reason", "symptoms", "medicines", "allergies", "conditions", "daily"];
      const covered = new Set<string>(u.topics_covered ?? []);
      const claims = [];
      const qt = u.question_topic ?? u.last_question_topic;
      if (u.patient_message && qt) {
        claims.push({ topic: qt, text_en: u.patient_message_english_hint ?? u.patient_message.text_en ?? u.patient_message, confidence: "high" });
        covered.add(qt);
      }
      const next = order.find((t) => !covered.has(t));
      return { reply: next ? `[mock ${u.language}] Question about ${next}?` : "Thanks, done.", quickReplies: [{ label: "OK", en: "OK" }], claims, topics_covered_now: [...covered], done: !next };
    }
    case "Safety Sentinel": return { redFlag: /pecho|chest/i.test(JSON.stringify(u)) ? true : false, reason: "mock" };
    case "Med Reader": return { fields: [{ label: "Drug", value: "Metformin HCl", confidence: "high" }, { label: "Strength", value: "500 mg", confidence: "high" }, { label: "Rx number", value: "RX 123456789", confidence: "high" }] };
    case "Reconciler": return { findings: [...(u.rule_findings ?? []).map(({ foundBy: _f, ...r }: any) => r), { type: "dose_mismatch", drug: "imaginary", patientSays: "x", recordSays: "y", evidence: ["F-9999"], severity: "high", routeTo: "nurse", policy: "POL-DOSE", detail: "hallucinated" }, ...(JSON.stringify(u.fills ?? []).includes("F-5101") ? [{ type: "fill_not_mentioned", drug: "metformin", patientSays: "Not mentioned", recordSays: "F-5101", evidence: ["F-5101"], severity: "low", routeTo: "nurse", policy: "POL-NOTAKE", detail: "contradicts the patient's own list" }] : [])], notes: "mock" };
    case "Summary Critic": return { verdict: "approve", issues: [], questionsForPatient: [] };
    case "Memory Keeper": return { generalRule: "For Razia R. (P-1001): treat the bottle as outdated and list the latest fill F-5101 as current." };
    case "Scheduler": return { why: "mock why (POL-WALK)", confirmation: "mock confirmation" };
    default: return { ok: true };
  }
}

export function startMocks(port = 0, opts: { noVision?: boolean } = {}): Promise<{ url: string; close: () => void }> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const send = (status: number, obj: unknown) => res.writeHead(status, { "Content-Type": "application/json", "meterless-model": status === 200 && obj && (obj as any).model ? (obj as any).model : "" }).end(JSON.stringify(obj));
    const url = req.url ?? "";

    if (url === "/api/v1.0/sql-editor/sqls/run" && req.method === "POST") {
      if (req.headers.authorization !== "Bearer zk-test") return send(401, { error: "bad key" });
      if (req.headers["x-org-id"] !== "1") return send(400, { error: "bad org" });
      if (!UUID.test(String(req.headers["x-request-id"]))) return send(400, { error: "X-Request-ID must be a UUID" });
      if (!UUID.test(String(body?.queryId)) || body?.source !== "SqlEditor") return send(400, { error: "bad body" });
      if (/;\s*\S/.test(body.sql)) return send(400, { error: "one statement only" });
      calls.sql.push(body.sql);
      try { return send(200, { data: runSelect(body.sql) }); } catch (e) { return send(500, { error: (e as Error).message }); }
    }

    if (url.startsWith("/v1/")) {
      if (req.headers.authorization !== "Bearer rt-test-token") return send(401, { error: "unauthorized" });
      if (req.headers["meterless-app"] !== "echorx") return send(400, { error: "meterless-app header missing" });
      if (url === "/v1/models") return send(200, { data: [{ id: "meterless/auto" }, { id: "nvidia/nemotron-3.5-lightning-30b-a3b" }, { id: "nvidia/nemotron-3-ultra-550b-a55b" }, { id: "meterless/vision" }] });
      if (url === "/v1/chat/completions") {
        if (req.headers["meterless-scope"] !== "user") return send(400, { error: "meterless-scope: user required" });
        const model = String(body?.model);
        if (/missing/.test(model)) return send(404, { error: "model not found" });
        if (opts.noVision && Array.isArray(body.messages?.[1]?.content)) return send(502, { error: { message: "request has image attachments but no configured vision-capable model admits them", type: "api_error" } });
        const system = String(body.messages?.[0]?.content ?? "");
        const userMsg = body.messages?.[1]?.content;
        const userText = typeof userMsg === "string" ? userMsg : (userMsg ?? []).find((p: any) => p.type === "text")?.text ?? "";
        const agent = agentOf(system);
        calls.chat.push({ model, agent, headers: { app: String(req.headers["meterless-app"]) } });
        if (!system.includes("ONE JSON object")) return send(200, { model, choices: [{ message: { content: "Connection works." } }] });
        const answered = model === "meterless/auto" ? "nvidia/nemotron-3.5-lightning-30b-a3b" : model;
        return send(200, { model: answered, choices: [{ message: { content: "```json\n" + JSON.stringify(chatReply(agent, userText)) + "\n```" } }], usage: { total_tokens: 42 } });
      }
    }
    send(404, { error: "not found" });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => {
    const a = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${a.port}`, close: () => server.close() });
  }));
}
