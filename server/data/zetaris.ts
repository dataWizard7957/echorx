// Zetaris REST client: the run_sql tool. One statement per request, a fresh
// UUID per request, read-only for agents.
import crypto from "node:crypto";
import { config } from "../config.ts";
import { trace } from "../trace.ts";

export class ZetarisError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface SqlResult {
  rows: unknown[][];
  columns?: string[];
  ms: number;
}

/** Low-level call. Used by scripts (DDL) and by runSelect (agents). */
export async function runSql(sql: string, opts: { limit?: number; timeoutMs?: number } = {}): Promise<SqlResult> {
  const statement = sql.trim().replace(/;\s*$/, "");
  if (!statement) throw new ZetarisError("empty SQL");
  if (/;\s*\S/.test(stripStrings(statement))) throw new ZetarisError("send one statement per request");
  if (!config.zetaris.apiKey) throw new ZetarisError("ZETARIS_API_KEY is not set");
  const started = Date.now();
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${config.zetaris.restUrl}/sql-editor/sqls/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.zetaris.apiKey}`,
          "X-Org-ID": config.zetaris.orgId,
          "X-Request-ID": crypto.randomUUID(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ queryId: crypto.randomUUID(), sql: statement, source: "SqlEditor", limit: opts.limit ?? 500 }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      const text = await res.text();
      if (!res.ok) {
        const hint =
          res.status === 401 ? " (API key missing, wrong or expired: create a new one in the Zetaris web interface)"
          : res.status === 400 && /org/i.test(text) ? " (check X-Org-ID; on a local install it is 1)"
          : "";
        const err = new ZetarisError(`Zetaris HTTP ${res.status}${hint}: ${text.slice(0, 300)}`, res.status);
        if (res.status < 500) throw err; // no retry on 4xx
        lastError = err;
        continue;
      }
      const body = text ? JSON.parse(text) : null;
      return { ...parseRows(body), ms: Date.now() - started };
    } catch (err) {
      if (err instanceof ZetarisError && (err.status ?? 500) < 500) throw err;
      lastError = err;
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ZetarisError(`Cannot reach Zetaris at ${config.zetaris.restUrl}: ${msg}`);
}

function parseRows(body: any): { rows: unknown[][]; columns?: string[] } {
  const data = body?.data ?? body?.rows ?? body?.result?.data ?? [];
  const columns: string[] | undefined =
    body?.columns?.map((c: any) => (typeof c === "string" ? c : c?.name)) ??
    body?.schema?.map?.((c: any) => c?.name) ??
    undefined;
  if (!Array.isArray(data)) return { rows: [], columns };
  const rows = data.map((r: unknown) => (Array.isArray(r) ? r : r && typeof r === "object" ? Object.values(r as object) : [r]));
  return { rows, columns };
}

function stripStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

/** Read-only guard for agents: SELECT against the EchoRx schema only. */
export function assertReadOnly(sql: string): void {
  const s = stripStrings(sql).trim().toLowerCase();
  if (!/^(select|with)\b/.test(s)) throw new ZetarisError("agents may only run SELECT statements");
  if (/\b(insert|update|delete|drop|create|alter|grant|truncate|merge)\b/.test(s)) throw new ZetarisError("write keywords are not allowed in agent SQL");
  const schema = config.zetaris.schema.toLowerCase();
  const refs = [...s.matchAll(/\b(?:from|join)\s+([a-z0-9_.]+)/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (!ref.startsWith(`${schema}.`)) throw new ZetarisError(`agents may only read ${schema}.* (got ${ref})`);
  }
}

/** The tool agents call. Traced, read-only, maps rows to objects by the given column order. */
export async function runSelect<T>(caseId: string, agent: string, sql: string, columns: string[]): Promise<T[]> {
  assertReadOnly(sql);
  try {
    const result = await runSql(sql);
    const objs = result.rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])) as T);
    trace({ caseId, agent, action: "query", tool: "run_sql", sql, rowCount: objs.length, ms: result.ms, provider: "zetaris", ok: true });
    return objs;
  } catch (err) {
    trace({ caseId, agent, action: "query", tool: "run_sql", sql, provider: "zetaris", ok: false, error: (err as Error).message });
    throw err;
  }
}
