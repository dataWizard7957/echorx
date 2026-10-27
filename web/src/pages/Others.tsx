import { useState } from "react";
import { api } from "../api";
import { BookingCard, Link, STATUS_LABEL, SummaryView, TraceList, usePoll, ModelBadge } from "../ui";

export function CaseTrace({ id }: { id: string }) {
  const [c] = usePoll(() => api.getCase(id), 2000, [id]);
  const [raw, setRaw] = useState(false);
  if (!c) return <p className="muted">Loading {id}…</p>;
  const models = [...new Set(c.trace.filter((e: any) => e.model).map((e: any) => e.model))] as string[];
  const sql = c.trace.filter((e: any) => e.tool === "run_sql").length;
  const mem = c.trace.filter((e: any) => e.tool === "H-MEM").length;
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div><h2 style={{ margin: 0 }}>Agent trace · {c.id}</h2><span className="muted small">{c.patientName} · {STATUS_LABEL[c.status]} · {c.trace.length} steps · {sql} Zetaris queries · {mem} H-MEM operations</span></div>
        <div className="row"><button className="btn sm" onClick={() => setRaw((v) => !v)}>{raw ? "Timeline" : "Raw JSON"}</button><Link to="/nurse" className="btn sm">Nurse inbox</Link></div>
      </div>
      <div className="row" style={{ gap: 6 }}><span className="small muted">Models that answered:</span>{models.map((m) => <ModelBadge key={m} model={m} />)}</div>
      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <div>{raw ? <pre className="card mono" style={{ whiteSpace: "pre-wrap", maxHeight: "70vh", overflow: "auto" }}>{JSON.stringify(c.trace, null, 2)}</pre> : <TraceList events={c.trace} />}</div>
        <div className="grid" style={{ gap: 12 }}>
          {c.booking && <BookingCard b={c.booking} />}
          <div className="card"><h3>Verified summary</h3><SummaryView c={c} /></div>
        </div>
      </div>
    </div>
  );
}

export function Doctor() {
  const [cases] = usePoll(() => api.listCases(), 3000);
  const verified = (cases ?? []).filter((c: any) => c.status === "approved");
  const [sel, setSel] = useState<string>();
  const [c] = usePoll(() => (sel ?? verified[0]?.id ? api.getCase(sel ?? verified[0].id) : Promise.resolve(undefined)), 3000, [sel, verified[0]?.id]);
  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="row"><h2 style={{ margin: 0 }}>Doctor view</h2><span className="muted small">Dr. Teresa Rivera · only nurse-verified summaries appear here</span></div>
      <div className="split">
        <div className="grid" style={{ gap: 8 }}>
          {!verified.length && <div className="card muted small">No verified summaries yet. A nurse verifies them in the <Link to="/nurse">inbox</Link>.</div>}
          {verified.map((x: any) => (
            <button key={x.id} className={`case-item ${(sel ?? verified[0]?.id) === x.id ? "sel" : ""}`} onClick={() => setSel(x.id)}>
              <b>{x.patientName}</b><span className="tiny">{x.id} · verified by {x.approvedBy}</span>
              {x.booking && <span className="small">🚐 {x.booking.weekday} {x.booking.date} {x.booking.time} · {x.booking.site}</span>}
            </button>
          ))}
        </div>
        {c ? (
          <div className="grid" style={{ gap: 12 }}>
            <div className="card"><div className="row" style={{ justifyContent: "space-between" }}><h3 style={{ margin: 0 }}>{c.patientName}</h3><span className="badge ok">✓ Verified by {c.approvedBy}</span></div><p className="small muted" style={{ marginBottom: 0 }}>The patient told their story once. This is what the nurse, the doctor and the pharmacist all see.</p></div>
            {c.booking && <BookingCard b={c.booking} />}
            <div className="card"><SummaryView c={c} /></div>
          </div>
        ) : <div />}
      </div>
    </div>
  );
}

export function Memory() {
  const [rules] = usePoll(() => api.memory(), 3000);
  return (
    <div className="grid" style={{ gap: 12 }}>
      <div><h2 style={{ marginBottom: 4 }}>H-MEM: what the team has learned</h2><p className="muted small" style={{ marginTop: 0 }}>Each rule came from a nurse's decision. It persists on disk across restarts, carries its source and confidence, and every read, write and feedback is in the trust ledger.</p></div>
      {!rules?.length && <div className="card muted small">No rules yet. When a nurse resolves an escalation with "Save as a rule", it appears here.</div>}
      {rules?.map((r: any) => (
        <div key={r.id} className="card">
          <div className="row" style={{ justifyContent: "space-between" }}><h3 style={{ margin: 0 }}>{r.id} · {r.situation.replace(/_/g, " ")}</h3><span className="badge hmem">confidence {Number(r.confidence).toFixed(2)}</span></div>
          <p>{r.rule}</p>
          <div className="tiny">Source: {r.nurse} · case {r.sourceCase} · tags {r.tags.join(", ")}</div>
          <details style={{ marginTop: 8 }}><summary className="small">Trust ledger ({r.ledger.length} entries)</summary><pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{r.ledger.map((l: any) => `${new Date(l.timestamp).toISOString()}  ${l.action.padEnd(9)} ${l.actor}${l.newState?.confidence !== undefined ? `  confidence → ${l.newState.confidence}` : ""}`).join("\n")}</pre></details>
        </div>
      ))}
    </div>
  );
}
