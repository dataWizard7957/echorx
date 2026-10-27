// EchoRx HTTP server (Node built-in http, no framework). Serves the API and
// the built web app from web/dist.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT, config, liveConfigProblems } from "./config.ts";
import { listModels, inBackupMode, setBackupMode } from "./providers/nightshift.ts";
import { repo, usingSampleData } from "./data/repository.ts";
import { listRules, ledgerFor, resetMemoryInstance } from "./hmem/careMemory.ts";
import * as orch from "./agents/orchestrator.ts";
import { LANGS, type Lang } from "./agents/types.ts";

const NURSE = "Nurse Janelle Okafor";
const MAX_BODY = 9 * 1024 * 1024;

type Handler = (req: http.IncomingMessage, body: any, params: Record<string, string>) => Promise<unknown>;
const routes: { method: string; re: RegExp; keys: string[]; fn: Handler }[] = [];
function route(method: string, pattern: string, fn: Handler) {
  const keys: string[] = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_m, k) => { keys.push(k); return "([^/]+)"; })}$`);
  routes.push({ method, re, keys, fn });
}

let statusCache: { at: number; value: unknown } | undefined;

route("GET", "/api/status", async () => {
  if (statusCache && Date.now() - statusCache.at < 15_000) return statusCache.value;
  const ns = await listModels();
  if (ns.status === "online" && inBackupMode()) setBackupMode(false);
  let zetaris: { status: string; detail?: string; rows?: Record<string, number> } = { status: "sample" };
  if (!usingSampleData()) {
    try {
      const rows: Record<string, number> = {};
      for (const v of ["patients", "pharmacy_fills"]) rows[v] = await repo.countRows(v);
      zetaris = { status: rows.patients > 0 ? "online" : "empty", rows };
    } catch (err) {
      zetaris = { status: "offline", detail: (err as Error).message.slice(0, 200) };
    }
  }
  const pinned = { fast: config.models.fast, deep: config.models.deep, vision: config.models.vision };
  const value = {
    sampleMode: config.sampleMode,
    backupMode: inBackupMode(),
    problems: config.sampleMode ? [] : liveConfigProblems(),
    zetaris,
    nightshift: { status: ns.status, detail: ns.detail, baseUrl: config.meterless.baseUrl, modelCount: ns.models.length, nemotronAvailable: ns.models.length ? ns.models.filter((m) => /nemotron/i.test(m)) : ns.status === "online" ? [config.models.fast] : [] },
    models: pinned,
    hmem: { status: "ready", rules: listRules().length, dir: path.relative(ROOT, config.hmemDir) },
  };
  statusCache = { at: Date.now(), value };
  return value;
});

route("GET", "/api/patients", async () => repo.listPatients("ui", "UI"));
route("POST", "/api/cases", async (_r, b) => {
  const lang = (LANGS.includes(b?.language) ? b.language : "en") as Lang;
  if (!/^P-\d{4}$/.test(String(b?.patientId))) throw new HttpError(400, "patientId required");
  return orch.createCase(b.patientId, lang);
});
route("GET", "/api/cases", async () => orch.listCases().map(slim));
route("GET", "/api/cases/:id", async (_r, _b, p) => mustCase(p.id));
route("POST", "/api/cases/:id/message", async (_r, b, p) => {
  if (typeof b?.text !== "string" || !b.text.trim()) throw new HttpError(400, "text required");
  return orch.handleMessage(p.id, { text: b.text, text_en: typeof b.text_en === "string" ? b.text_en : undefined });
});
route("POST", "/api/cases/:id/photo", async (_r, b, p) => {
  const dataUrl = typeof b?.dataUrl === "string" && /^data:image\/(png|jpe?g|webp);base64,/.test(b.dataUrl) ? b.dataUrl : undefined;
  if (!dataUrl && !b?.sampleId) throw new HttpError(400, "image required");
  return orch.handlePhoto(p.id, { dataUrl, sampleId: typeof b?.sampleId === "string" ? b.sampleId : undefined });
});
route("POST", "/api/cases/:id/finish", async (_r, _b, p) => orch.finish(p.id));
route("GET", "/api/nurse/inbox", async () => {
  const i = orch.inbox();
  return Object.fromEntries(Object.entries(i).map(([k, v]) => [k, v.map(slim)]));
});
route("POST", "/api/nurse/:id/decide", async (_r, b, p) => {
  if (!b?.escalationId || typeof b?.decision !== "string" || b.decision.trim().length < 3) throw new HttpError(400, "escalationId and decision required");
  return orch.nurseDecide(p.id, b.escalationId, b.decision.trim(), b.saveAsRule !== false, NURSE);
});
route("POST", "/api/nurse/:id/approve", async (_r, _b, p) => orch.nurseApprove(p.id, NURSE));
route("POST", "/api/nurse/:id/ask", async (_r, b, p) => {
  if (typeof b?.question !== "string" || b.question.trim().length < 3) throw new HttpError(400, "question required");
  return orch.nurseAsk(p.id, b.question.trim(), NURSE);
});
route("POST", "/api/nurse/:id/memory-wrong", async (_r, b, p) => orch.memoryWrong(p.id, b?.escalationId, NURSE));
route("GET", "/api/memory", async () => listRules().map((r) => ({ ...r, ledger: ledgerFor(r.id) })));
route("POST", "/api/demo/reset", async (_r, b) => {
  orch.resetAll();
  if (b?.memory !== false) {
    fs.rmSync(config.hmemDir, { recursive: true, force: true });
    resetMemoryInstance();
  }
  statusCache = undefined;
  return { ok: true };
});

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function mustCase(id: string) {
  const c = orch.getCase(id);
  if (!c) throw new HttpError(404, "case not found");
  return c;
}

function slim(c: ReturnType<typeof orch.listCases>[number]) {
  const { trace: _t, transcript, ...rest } = c;
  return { ...rest, lastMessage: transcript.at(-1)?.text ?? "" };
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const DIST = path.join(ROOT, "web", "dist");

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let file = path.normalize(path.join(DIST, url));
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  if (!fs.existsSync(file)) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("EchoRx API is running. Build the web app with `npm run build` (or use `npm run dev`).");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  if (req.method === "GET") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large (max 8 MB)");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, "invalid JSON"); }
}

const server = http.createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (!url.startsWith("/api/")) return serveStatic(req, res);
  const match = routes.find((r) => r.method === req.method && r.re.test(url));
  if (!match) { res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" })); return; }
  try {
    const body = await readBody(req);
    const m = match.re.exec(url)!;
    const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const out = await match.fn(req, body, params);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : /Unknown case/.test((err as Error).message) ? 404 : 500;
    if (status === 500) console.error(`[echorx] ${req.method} ${url}:`, (err as Error).message);
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
  }
});

server.listen(config.port, () => {
  const mode = config.sampleMode ? "SAMPLE MODE (no credentials needed)" : "LIVE MODE (Zetaris + Nightshift)";
  console.log(`\n  EchoRx · Say it once. Every caregiver hears it.\n  ${mode}\n  → http://localhost:${config.port}\n`);
  if (!config.sampleMode) for (const p of liveConfigProblems()) console.warn(`  ! ${p}`);
});
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") console.error(`Port ${config.port} is in use. Stop the other EchoRx window, or set PORT=8788 in .env.`);
  else console.error(err);
  process.exit(1);
});
