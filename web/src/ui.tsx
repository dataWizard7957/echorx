import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Lang } from "./api";
import { dir, t } from "./i18n";

// ---------- tiny router ----------
export function navigate(to: string) {
  window.history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
export function usePath(): string {
  const [p, setP] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setP(window.location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return p;
}
export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return <a href={to} className={className} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(to); }}>{children}</a>;
}

export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []): [T | undefined, () => void] {
  const [data, setData] = useState<T>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = () => fn().then((d) => alive && setData(d)).catch(() => undefined);
    run();
    const id = setInterval(run, ms);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return [data, () => setTick((x) => x + 1)];
}

// ---------- brand ----------
export function Logo() {
  return (
    <Link to="/" className="brand">
      <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden>
        <circle cx="32" cy="32" r="30" fill="var(--brand)" />
        <circle cx="32" cy="32" r="9" fill="var(--surface)" />
        <path d="M44 18a20 20 0 0 1 0 28M50 12a28 28 0 0 1 0 40" fill="none" stroke="var(--echo)" strokeWidth="4" strokeLinecap="round" />
      </svg>
      <span>
        <span className="brand-name">Echo<b>Rx</b></span>
        <span className="brand-tag" style={{ display: "block" }}>Say it once. Every caregiver hears it.</span>
      </span>
    </Link>
  );
}

const NAV = [["/demo", "Demo"], ["/start", "Patient"], ["/nurse", "Nurse inbox"], ["/doctor", "Doctor"], ["/memory", "Memory"]];

export function TopBar({ path }: { path: string }) {
  return (
    <header className="topbar">
      <Logo />
      <nav className="nav" aria-label="Main">
        {NAV.map(([to, label]) => <Link key={to} to={to} className={path.startsWith(to) ? "active" : ""}>{label}</Link>)}
      </nav>
      <div className="spacer" />
      <StatusBar />
      <span className="sample-label">Sample data · prototype</span>
    </header>
  );
}

export function StatusBar() {
  const [s] = usePoll(() => api.status(), 10_000);
  if (!s) return null;
  const z = s.zetaris?.status ?? "offline";
  const n = s.backupMode ? "offline" : s.nightshift?.status ?? "offline";
  const nemo = s.sampleMode ? "sample" : s.nightshift?.nemotronAvailable?.length ? "online" : n === "online" ? "offline" : n;
  return (
    <div className="statusbar" aria-label="System status">
      <Pill state={z} label="Zetaris" title={s.zetaris?.detail} />
      <Pill state={n} label={s.backupMode ? "Nightshift (backup)" : "Nightshift"} title={s.nightshift?.detail ?? s.nightshift?.baseUrl} />
      <Pill state={nemo} label="Nemotron" title={s.models?.fast} />
      <Pill state="online" label={`H-MEM · ${s.hmem?.rules ?? 0} rule${s.hmem?.rules === 1 ? "" : "s"}`} />
    </div>
  );
}

function Pill({ state, label, title }: { state: string; label: string; title?: string }) {
  return <span className={`pill ${state}`} title={title ?? state}><span className="dot" />{label}{state !== "online" && state !== "sample" && <span className="tiny">{state}</span>}</span>;
}

export function ModelBadge({ model }: { model?: string }) {
  if (!model) return null;
  const nemo = /nemotron/i.test(model);
  const short = model.replace(/^(sample|backup):/, "").replace(/^nvidia\//, "");
  const prefix = model.startsWith("sample:") ? "sample · " : model.startsWith("backup:") ? "backup · " : "";
  return <span className={`badge ${nemo ? "nemo" : ""}`} title={model}>{nemo ? "NVIDIA " : ""}{prefix}{short}</span>;
}

// ---------- trace ----------
export function TraceList({ events, compact = false }: { events: any[]; compact?: boolean }) {
  return (
    <div className="trace">
      {events.map((e, i) => {
        const kind = e.agent === "Orchestrator" && e.action === "branch" ? (/EMERGENCY/.test(e.decision) ? "emergency" : "decision") : e.tool === "H-MEM" ? "memory" : e.tool === "run_sql" ? "sql" : e.agent === "Safety Sentinel" && /RED FLAG/.test(e.decision ?? "") ? "emergency" : "";
        return (
          <div key={i} className={`tev fade-in ${kind} ${e.ok === false ? "fail" : ""}`}>
            <div>
              <div className="agent">{e.agent}</div>
              <div className="tiny">{e.action}{e.ms !== undefined ? ` · ${e.ms} ms` : ""}</div>
            </div>
            <div>
              <div className="row" style={{ gap: 6 }}>
                {e.model && <ModelBadge model={e.model} />}
                {e.lane && <span className="badge">{e.lane} lane</span>}
                {e.fallbackUsed && <span className="badge danger">fallback</span>}
                {e.tool === "run_sql" && <span className="badge zetaris">Zetaris · {e.rowCount ?? 0} rows</span>}
                {e.tool === "H-MEM" && <span className="badge hmem">H-MEM</span>}
              </div>
              {(e.decision || e.outputSummary) && <div style={{ marginTop: 4 }}>{e.decision ?? e.outputSummary}</div>}
              {e.sql && !compact && <pre>{e.sql}</pre>}
              {e.error && <pre style={{ color: "var(--danger)" }}>{e.error}</pre>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- patient chat ----------
export function Chat({ c, onReply, busy }: { c: any; onReply?: (label: string, en: string) => void; busy?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = box.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }, [c?.transcript?.length, busy]);
  if (!c) return null;
  const lang: Lang = c.language;
  const last = c.transcript[c.transcript.length - 1];
  return (
    <div className="phone-body" dir={dir(lang)} lang={lang} ref={box}>
      {c.transcript.map((m: any, i: number) => (
        <div key={i} className={`bubble fade-in ${m.role === "patient" ? "me" : "bot"} ${m.kind === "followup" ? "followup" : ""} ${m.kind === "booking" ? "booking" : ""}`}>
          {m.text}
          {lang !== "en" && m.text_en && m.text_en !== m.text && <span className="en" dir="ltr" lang="en">{m.text_en}</span>}
        </div>
      ))}
      {busy && <div className="typing">{t("working", lang)}</div>}
      {onReply && last?.role === "assistant" && last.quickReplies?.length > 0 && ["intake", "needs_patient"].includes(c.status) && !busy && (
        <div className="chips">
          {last.quickReplies.map((q: any) => <button key={q.label} className="chip" onClick={() => onReply(q.label, q.en)}>{q.label}{lang !== "en" && q.en !== q.label && <span className="en" dir="ltr" lang="en">{q.en}</span>}</button>)}
        </div>
      )}
    </div>
  );
}

export function Progress({ covered }: { covered: string[] }) {
  const topics = ["reason", "symptoms", "medicines", "allergies", "conditions", "daily"];
  return <div className="progress" aria-label={`${covered.length} of 6 topics`}>{topics.map((x) => <span key={x} className={covered.includes(x) ? "done" : ""} />)}</div>;
}

export function Emergency({ c }: { c: any }) {
  const lang: Lang = c.language;
  const msg = c.transcript[c.transcript.length - 1]?.text ?? "";
  return (
    <div className="emergency" dir={dir(lang)} lang={lang} role="alert">
      <h2>{t("call", lang)}</h2>
      <p style={{ fontSize: 18, maxWidth: 320 }}>{msg}</p>
      <a className="call" href="tel:911">📞 {t("call", lang)}</a>
      <span className="tiny" style={{ color: "#fff" }}>{c.redFlag?.reason} · {c.redFlag?.rule} · detected by {c.redFlag?.source}</span>
    </div>
  );
}

// ---------- clinical summary ----------
export function SummaryView({ c }: { c: any }) {
  const s = c.summary;
  if (!s) return <p className="muted">No summary yet.</p>;
  const List = ({ items }: { items: string[] }) => (items?.length ? <ul className="clean">{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <span className="muted">—</span>);
  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="muted small">{s.patientLine}</div>
      <dl className="kv">
        <dt>Reason</dt><dd><List items={s.reason} /></dd>
        <dt>Symptoms</dt><dd><List items={s.symptoms} /></dd>
        <dt>Allergies</dt><dd><List items={s.allergies} /></dd>
        <dt>Conditions</dt><dd><List items={s.conditions} /></dd>
        <dt>Daily needs</dt><dd><List items={s.daily} /></dd>
      </dl>
      <div>
        <h3 style={{ fontSize: 15, margin: "4px 0" }}>Medicines (reconciled against Zetaris records)</h3>
        <div className="grid" style={{ gap: 6 }}>
          {s.medicines.map((m: any, i: number) => (
            <div key={i} className="small" style={{ padding: 8, borderRadius: 8, background: "var(--surface-2)" }}>
              <b style={{ textTransform: "capitalize" }}>{m.drug}</b>: {m.current}
              {m.note && <div className="muted">{m.note}</div>}
              {m.evidence?.length > 0 && <div className="row" style={{ gap: 4, marginTop: 4 }}>{m.evidence.map((e: string) => <span key={e} className="badge zetaris">{e}</span>)}</div>}
            </div>
          ))}
        </div>
      </div>
      {s.flagsForPharmacist?.length > 0 && <div><h3 style={{ fontSize: 15, margin: "4px 0" }}>For the pharmacist</h3><List items={s.flagsForPharmacist} /></div>}
      {s.nurseDecisions?.length > 0 && <div><h3 style={{ fontSize: 15, margin: "4px 0" }}>Nurse decisions</h3><List items={s.nurseDecisions} /></div>}
    </div>
  );
}

export function BookingCard({ b }: { b: any }) {
  if (!b) return null;
  return (
    <div className="card" style={{ borderColor: "var(--ok)" }}>
      <h3>🚐 {b.site}</h3>
      <div className="small">{b.weekday} {b.date} · {b.time} · {b.van} · {b.distanceMi} mi · crew speaks {b.languages.join(", ")}</div>
      <div className="tiny" style={{ marginTop: 6 }}>{b.why}</div>
    </div>
  );
}

export const STATUS_LABEL: Record<string, string> = {
  intake: "In intake", emergency: "Emergency (911)", processing: "Agents working", needs_patient: "Asking patient", waiting_nurse: "Needs nurse", ready: "Ready to verify", approved: "Verified",
};
