// Typed data access. Live mode: every read is a Zetaris SQL query (run_sql).
// Sample mode: the same queries are answered from data/*.json so the app runs
// with no credentials. Agents only ever call these functions.
import fs from "node:fs";
import path from "node:path";
import { ROOT, config } from "../config.ts";
import { runSelect } from "./zetaris.ts";
import { trace } from "../trace.ts";

export interface Patient { patient_id: string; display_name: string; age: number; zip: string; language: string; has_car: boolean; mobility: string; neighborhood: string; home_lat: number; home_lng: number }
export interface Fill { fill_id: string; patient_id: string; drug: string; strength: string; directions: string; fill_date: string; days_supply: number; pharmacy: string }
export interface Visit { visit_id: string; patient_id: string; visit_date: string; site: string; reason: string; med_changes: string }
export interface VanStop { stop_id: string; van_id: string; site_name: string; area: string; zip: string; lat: number; lng: number; weekday: string; start_time: string; end_time: string; languages: string }
export interface Slot { slot_id: string; stop_id: string; start_time: string; capacity: number; booked: number }
export interface PolicyRule { rule_id: string; category: string; trigger: string; action: string; escalate_to: string; notes: string }

const VIEWS = JSON.parse(fs.readFileSync(path.join(ROOT, "zetaris", "views.json"), "utf-8")) as Record<string, string[]>;
const NUMERIC = new Set(["age", "home_lat", "home_lng", "days_supply", "lat", "lng", "capacity", "booked"]);

let forceSample = false;
/** Used when Zetaris is unreachable mid-demo and the operator chooses the offline backup. */
export function setForceSample(v: boolean): void { forceSample = v; }
export function usingSampleData(): boolean { return config.sampleMode || forceSample; }

function coerce<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (NUMERIC.has(k) && v !== null && v !== undefined && v !== "") out[k] = Number(v);
    else if (k === "has_car") out[k] = v === true || v === "true" || v === 1 || v === "1";
    else out[k] = v === null || v === undefined ? "" : String(v);
  }
  return out as T;
}

const cache = new Map<string, Record<string, unknown>[]>();
function sampleRows(view: string): Record<string, unknown>[] {
  if (!cache.has(view)) cache.set(view, JSON.parse(fs.readFileSync(path.join(ROOT, "data", `${view}.json`), "utf-8")).data);
  return cache.get(view)!;
}

const lit = (v: string): string => {
  if (!/^[A-Za-z0-9 _.\-,]{1,64}$/.test(v)) throw new Error(`unsafe SQL literal: ${v}`);
  return `'${v}'`;
};

async function select<T>(caseId: string, agent: string, view: string, where: Record<string, string | string[]> = {}, orderBy?: string): Promise<T[]> {
  const cols = VIEWS[view];
  const schema = config.zetaris.schema;
  const conds = Object.entries(where).map(([k, v]) => (Array.isArray(v) ? `${k} IN (${v.map(lit).join(", ")})` : `${k} = ${lit(v)}`));
  const sql = `SELECT ${cols.join(", ")} FROM ${schema}.${view}${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""}${orderBy ? ` ORDER BY ${orderBy}` : ""}`;

  if (usingSampleData()) {
    const started = Date.now();
    let rows = sampleRows(view).filter((r) => Object.entries(where).every(([k, v]) => (Array.isArray(v) ? v.includes(String(r[k])) : String(r[k]) === v)));
    if (orderBy) {
      const [col, dir] = orderBy.split(/\s+/);
      rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (dir?.toUpperCase() === "DESC" ? -1 : 1));
    }
    trace({ caseId, agent, action: "query", tool: "run_sql", sql, rowCount: rows.length, ms: Date.now() - started, provider: "sample-data", ok: true });
    return rows.map((r) => coerce<T>(r));
  }
  const rows = await runSelect<Record<string, unknown>>(caseId, agent, sql, cols);
  return rows.map((r) => coerce<T>(r));
}

export const repo = {
  getPatient: async (caseId: string, agent: string, patientId: string) => (await select<Patient>(caseId, agent, "patients", { patient_id: patientId }))[0],
  listPatients: (caseId: string, agent: string) => select<Patient>(caseId, agent, "patients", {}, "patient_id"),
  getFills: (caseId: string, agent: string, patientId: string) => select<Fill>(caseId, agent, "pharmacy_fills", { patient_id: patientId }, "fill_date"),
  getVisits: (caseId: string, agent: string, patientId: string) => select<Visit>(caseId, agent, "visit_history", { patient_id: patientId }, "visit_date"),
  getPolicy: (caseId: string, agent: string) => select<PolicyRule>(caseId, agent, "triage_policy"),
  getStops: (caseId: string, agent: string) => select<VanStop>(caseId, agent, "van_stops"),
  getSlots: (caseId: string, agent: string, stopIds: string[]) => (stopIds.length ? select<Slot>(caseId, agent, "clinic_slots", { stop_id: stopIds }, "start_time") : Promise.resolve([])),
  countRows: async (view: string): Promise<number> => {
    if (usingSampleData()) return sampleRows(view).length;
    const rows = await runSelect<{ n: number }>("setup-check", "check", `SELECT COUNT(*) AS n FROM ${config.zetaris.schema}.${view}`, ["n"]);
    return Number(rows[0]?.n ?? 0);
  },
};
