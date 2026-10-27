import { useEffect, useState } from "react";
import { api } from "../api";
import { BookingCard, Link, STATUS_LABEL, SummaryView, usePoll } from "../ui";

const TABS: [string, string][] = [["needsYou", "Needs you"], ["autoResolved", "Auto-resolved from memory"], ["ready", "Ready to verify"], ["approved", "Verified"], ["emergencies", "Emergencies"], ["inProgress", "In progress"]];

export const SUGGESTED_DECISION: Record<string, string> = {
  dose_mismatch: "The bottle is an old fill. List the latest pharmacy fill as current and note the visit that changed it. Ask the patient to bring every bottle to the van so the doctor can confirm.",
  fill_not_mentioned: "Ask the patient once if they still take it; list it for the doctor.",
  records_unavailable: "Records unavailable: I will call the pharmacy before the visit.",
};

export function Nurse() {
  const [inbox, refresh] = usePoll(() => api.inbox(), 2500);
  const [tab, setTab] = useState("needsYou");
  const [selId, setSelId] = useState<string>();
  const [c, setC] = useState<any>();
  const list: any[] = inbox?.[tab] ?? [];

  useEffect(() => { if (!selId && list[0]) setSelId(list[0].id); }, [list.length, tab]);
  useEffect(() => {
    if (!selId) return;
    let alive = true;
    const load = () => api.getCase(selId).then((x) => alive && setC(x)).catch(() => undefined);
    load();
    const id = setInterval(load, 2500);
    return () => { alive = false; clearInterval(id); };
  }, [selId]);

  const after = (x: any) => { setC(x); refresh(); };

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="row"><h2 style={{ margin: 0 }}>Nurse inbox</h2><span className="muted small">Nurse Janelle Okafor · Van 3 & Van 4</span></div>
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => <button key={k} role="tab" className={tab === k ? "sel" : ""} onClick={() => { setTab(k); setSelId(undefined); setC(undefined); }}>{label} ({inbox?.[k]?.length ?? 0})</button>)}
      </div>
      <div className="split">
        <div className="grid" style={{ gap: 8 }}>
          {!list.length && <div className="card muted small">Nothing here yet. Start a case from the <Link to="/start">patient screen</Link> or <Link to="/demo">play the demo</Link>.</div>}
          {list.map((x) => (
            <button key={x.id} className={`case-item ${x.id === selId ? "sel" : ""}`} onClick={() => setSelId(x.id)}>
              <div className="row" style={{ justifyContent: "space-between" }}><b>{x.patientName}</b><span className="tiny">{x.id}</span></div>
              <div className="row" style={{ gap: 4 }}>
                <span className="badge">{STATUS_LABEL[x.status]}</span>
                {x.escalations?.filter((e: any) => e.status === "open").length > 0 && <span className="badge danger">{x.escalations.filter((e: any) => e.status === "open").length} escalation</span>}
                {x.escalations?.some((e: any) => e.status === "auto_resolved") && <span className="badge hmem">from memory</span>}
              </div>
            </button>
          ))}
        </div>
        {c ? <CaseDetail c={c} onChange={after} /> : <div className="card muted">Select a case.</div>}
      </div>
    </div>
  );
}

function CaseDetail({ c, onChange }: { c: any; onChange: (x: any) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = async (fn: () => Promise<any>) => { setBusy(true); setErr(""); try { onChange(await fn()); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const open = c.escalations.filter((e: any) => e.status === "open");
  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div><h3 style={{ margin: 0 }}>{c.patientName} · {c.id}</h3><span className="small muted">{STATUS_LABEL[c.status]}{c.offlineBackup ? " · offline backup used" : ""}</span></div>
          <div className="row">
            <Link to={`/case/${c.id}`} className="btn sm">Agent trace</Link>
            {["ready"].includes(c.status) && <button className="btn primary sm" disabled={busy} onClick={() => act(() => api.approve(c.id))}>✓ Verify summary</button>}
          </div>
        </div>
        {c.status === "emergency" && <p className="small" style={{ color: "var(--danger)" }}>Red flag: {c.redFlag?.reason} ({c.redFlag?.rule}). Patient was told to call 911.</p>}
        {err && <p className="small" style={{ color: "var(--danger)" }}>{err}</p>}
      </div>
      {c.escalations.map((e: any) => <EscalationCard key={e.id} c={c} e={e} busy={busy} act={act} />)}
      {open.length === 0 && c.critiques?.length > 0 && <div className="card small"><b>Summary Critic:</b> {c.critiques.map((k: any) => `round ${k.round} ${k.verdict}`).join(" → ")}{c.critiques.at(-1)?.overridden ? ` · ${c.critiques.at(-1).overridden}` : ""}</div>}
      {c.booking && <BookingCard b={c.booking} />}
      <div className="card"><h3>Summary for every caregiver</h3><SummaryView c={c} /></div>
    </div>
  );
}

function EscalationCard({ c, e, busy, act }: { c: any; e: any; busy: boolean; act: (fn: () => Promise<any>) => void }) {
  const d = c.discrepancies.find((x: any) => x.id === e.discrepancyId) ?? {};
  const [decision, setDecision] = useState(SUGGESTED_DECISION[e.situation] ?? "");
  const [save, setSave] = useState(true);
  const [question, setQuestion] = useState("");
  return (
    <div className="card" style={{ borderColor: e.status === "open" ? "var(--danger)" : e.status === "auto_resolved" ? "var(--echo)" : "var(--ok)" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0, textTransform: "capitalize" }}>{d.drug} · {String(d.type).replace(/_/g, " ")}</h3>
        <span className={`badge ${e.status === "open" ? "danger" : e.status === "auto_resolved" ? "hmem" : "ok"}`}>{e.status === "open" ? "Needs you" : e.status === "auto_resolved" ? "Auto-resolved from memory" : `Resolved by ${e.decidedBy}`}</span>
      </div>
      <p className="small">{d.detail}</p>
      <div className="compare">
        <div><b>Patient says</b>{d.patientSays}</div>
        <div><b>Zetaris records</b>{d.recordSays}</div>
      </div>
      <div className="row" style={{ gap: 4, marginTop: 8 }}>
        {d.evidence?.map((x: string) => <span key={x} className="badge zetaris">{x}</span>)}
        <span className="badge">{d.policy}</span>
        <span className="badge">found by {d.foundBy}</span>
      </div>
      {e.status === "auto_resolved" && e.memory && (
        <div className="memory-card" style={{ marginTop: 10 }}>
          <div className="row" style={{ justifyContent: "space-between" }}><b>🧠 Applied from H-MEM memory</b><span className="badge hmem">{e.memory.ruleId} · relevance {e.memory.relevance} · confidence {Number(e.memory.confidence).toFixed(2)}</span></div>
          <p className="small" style={{ margin: "6px 0" }}>{e.memory.rule}</p>
          <div className="tiny">Source: {e.memory.nurse}, case {e.memory.sourceCase}</div>
          {!e.feedback && <button className="btn sm danger" style={{ marginTop: 8 }} disabled={busy} onClick={() => act(() => api.memoryWrong(c.id, e.id))}>Mark rule wrong for this case</button>}
          {e.feedback && <div className="tiny" style={{ marginTop: 6 }}>Feedback recorded: {e.feedback}</div>}
        </div>
      )}
      {e.status === "resolved" && <p className="small"><b>Decision:</b> {e.decision}{e.savedRuleId ? <span className="badge hmem" style={{ marginInlineStart: 6 }}>saved as rule {e.savedRuleId}</span> : null}</p>}
      {e.status === "open" && (
        <div className="grid" style={{ gap: 8, marginTop: 10 }}>
          <label className="small"><b>Your decision</b><textarea value={decision} onChange={(x) => setDecision(x.target.value)} /></label>
          <label className="row small"><input type="checkbox" checked={save} onChange={(x) => setSave(x.target.checked)} /> Save as a rule for similar cases (H-MEM)</label>
          <div className="row">
            <button className="btn primary" disabled={busy || decision.trim().length < 3} onClick={() => act(() => api.decide(c.id, e.id, decision, save))}>Decide</button>
          </div>
          <div className="row">
            <input value={question} onChange={(x) => setQuestion(x.target.value)} placeholder="Or ask the patient a question…" style={{ flex: 1, minHeight: 40, borderRadius: 10, border: "1px solid var(--line)", padding: "0 10px", font: "inherit", background: "var(--surface)", color: "var(--ink)" }} />
            <button className="btn sm" disabled={busy || question.trim().length < 3} onClick={() => act(() => api.ask(c.id, question))}>Ask patient</button>
          </div>
        </div>
      )}
    </div>
  );
}
