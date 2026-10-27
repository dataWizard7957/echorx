import { useEffect, useRef, useState } from "react";
import { api, fileToDataUrl, sampleBottleDataUrl, type Lang } from "../api";
import { LANG_LABEL, dir, t } from "../i18n";
import { Chat, Emergency, Progress, Link } from "../ui";

const BOTTLES = ["metformin-500", "lisinopril-10", "atorvastatin-20"];

export function Patient() {
  const [patients, setPatients] = useState<any[]>([]);
  const [patientId, setPatientId] = useState("P-1001");
  const [lang, setLang] = useState<Lang>("bn");
  const [stage, setStage] = useState<"pick" | "consent" | "chat">("pick");
  const [c, setC] = useState<any>();
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [showPhotos, setShowPhotos] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { api.patients().then(setPatients).catch((e) => setErr(e.message)); }, []);
  useEffect(() => {
    const p = patients.find((x) => x.patient_id === patientId);
    if (p) setLang(p.language);
  }, [patientId, patients]);
  // Keep in sync with nurse actions (new follow-up questions, booking).
  useEffect(() => {
    if (!c || ["intake"].includes(c.status)) return;
    const id = setInterval(() => api.getCase(c.id).then(setC).catch(() => undefined), 2000);
    return () => clearInterval(id);
  }, [c?.id, c?.status]);

  const run = async (fn: () => Promise<any>) => {
    setBusy(true); setErr("");
    try { setC(await fn()); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const start = () => run(async () => { const x = await api.createCase(patientId, lang); setStage("chat"); return x; });
  const reply = (label: string, en: string) => {
    if (en === "I'll take a photo") { setShowPhotos(true); return; }
    run(() => api.message(c.id, label, en));
  };
  const send = () => { if (!text.trim()) return; const v = text; setText(""); run(() => api.message(c.id, v, lang === "en" ? v : undefined)); };
  const sendSample = (id: string) => { setShowPhotos(false); run(async () => api.photo(c.id, { sampleId: id, dataUrl: await sampleBottleDataUrl(id) })); };
  const upload = async (f?: File) => { if (!f) return; setShowPhotos(false); run(async () => api.photo(c.id, { dataUrl: await fileToDataUrl(f) })); };

  const last = c?.transcript?.[c.transcript.length - 1];
  const canFinish = c?.status === "intake" && c.topicsCovered.length === 6 && last?.kind === "info";

  return (
    <div className="grid cols-2" style={{ alignItems: "start" }}>
      <div className="phone" dir={dir(lang)} lang={lang}>
        <div className="phone-head">
          <strong>Echo<span style={{ color: "var(--brand)" }}>Rx</span></strong>
          <div className="spacer" />
          {c && <span className="tiny">{c.id}</span>}
        </div>
        {stage === "pick" && (
          <div className="phone-body" style={{ gap: 16 }}>
            <label className="small muted" dir="ltr">{t("whoAreYou", "en")}
              <select value={patientId} onChange={(e) => setPatientId(e.target.value)} style={{ width: "100%", minHeight: 48, borderRadius: 12, marginTop: 6, padding: "0 10px", font: "inherit", background: "var(--surface)", color: "var(--ink)", border: "1px solid var(--line)" }}>
                {patients.map((p) => <option key={p.patient_id} value={p.patient_id}>{p.display_name} · {p.age} · {p.neighborhood} · {LANG_LABEL[p.language as Lang]}</option>)}
              </select>
            </label>
            <h2 style={{ marginBottom: 0 }}>{t("chooseLang", lang)}</h2>
            <div className="lang-grid">
              {(Object.keys(LANG_LABEL) as Lang[]).map((l) => <button key={l} lang={l} className={l === lang ? "sel" : ""} onClick={() => setLang(l)}>{LANG_LABEL[l]}</button>)}
            </div>
            <button className="btn primary block" onClick={() => setStage("consent")}>→</button>
          </div>
        )}
        {stage === "consent" && (
          <div className="phone-body" style={{ gap: 16 }}>
            <h2>{t("consentTitle", lang)}</h2>
            <p style={{ fontSize: 18 }}>{t("consent", lang)}</p>
            <button className="btn primary block" disabled={busy} onClick={start}>{t("agree", lang)}</button>
          </div>
        )}
        {stage === "chat" && c?.status === "emergency" && <Emergency c={c} />}
        {stage === "chat" && c && c.status !== "emergency" && (
          <>
            <div style={{ padding: "8px 14px", background: "var(--surface)" }}><Progress covered={c.topicsCovered} /></div>
            <Chat c={c} onReply={reply} busy={busy || c.status === "processing"} />
            {["intake", "needs_patient"].includes(c.status) && (
              <div className="phone-foot">
                {showPhotos && (
                  <div className="grid" style={{ gap: 6 }}>
                    <span className="tiny">{t("sampleBottles", lang)}</span>
                    <div className="bottle-row">
                      {BOTTLES.map((b) => <button key={b} onClick={() => sendSample(b)} aria-label={b}><img src={`/samples/${b}.png`} alt={b} /></button>)}
                    </div>
                    <button className="btn sm" onClick={() => fileRef.current?.click()}>📷 {t("upload", lang)}</button>
                    <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => upload(e.target.files?.[0])} />
                  </div>
                )}
                {canFinish ? (
                  <button className="btn echo block" disabled={busy} onClick={() => run(() => api.finish(c.id))}>{t("finish", lang)}</button>
                ) : (
                  <div className="compose">
                    <button className="btn sm" title={t("photo", lang)} aria-label={t("photo", lang)} onClick={() => setShowPhotos((v) => !v)}>📷</button>
                    <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("type", lang)} onKeyDown={(e) => e.key === "Enter" && send()} disabled={busy} />
                    <button className="btn primary sm" disabled={busy || !text.trim()} onClick={send}>{t("send", lang)}</button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <div className="grid" style={{ gap: 12 }}>
        <div className="card">
          <h3>What's happening behind the screen</h3>
          <p className="small muted">Every answer passes the <b>Safety Sentinel</b> first. When you finish, the <b>Reconciler</b> checks your medicines against pharmacy and visit records in <b>Zetaris</b>, the <b>Summary Critic</b> looks for gaps, the <b>Memory Keeper</b> checks <b>H-MEM</b> for a nurse rule, and the <b>Scheduler</b> books a van stop you can walk to.</p>
          {c && <Link to={`/case/${c.id}`} className="btn sm">Open the agent trace for {c.id} →</Link>}
        </div>
        {err && <div className="card" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>{err}</div>}
        {c?.status === "waiting_nurse" && <div className="card"><span className="badge brand">Waiting for nurse</span> <span className="small">Open the <Link to="/nurse">nurse inbox</Link> to resolve the escalation.</span></div>}
      </div>
    </div>
  );
}
