// Guided demo: plays Razia → Nurse → Hassan → Lucía → Verify through the real
// API (real orchestrator, real H-MEM, Zetaris or sample data). Built to be
// screen-recorded for the submission video.
import { useEffect, useRef, useState } from "react";
import { api, sampleBottleDataUrl } from "../api";
import { SUGGESTED_DECISION } from "./Nurse";
import { Chat, Emergency, Link, Progress, TraceList } from "../ui";

type Step = { say: [string, string] } | { photo: string } | { finish: true };
interface Script { patientId: string; lang: "bn" | "ar" | "es"; steps: Step[]; followup: [string, string] }

const RAZIA: Script = {
  patientId: "P-1001", lang: "bn",
  steps: [
    { say: ["আমার ওষুধগুলো দেখে দিন", "Review my medicines"] },
    { say: ["মাঝে মাঝে মাথা ঘোরে", "I feel dizzy sometimes"] },
    { say: ["মেটফরমিন, লিসিনোপ্রিল, অ্যাটোরভাস্ট্যাটিন, অ্যামলোডিপিন আর ভিটামিন ডি", "Metformin, lisinopril, atorvastatin, amlodipine and vitamin D"] },
    { photo: "metformin-500" },
    { say: ["এই কয়টাই", "No other medicines"] },
    { say: ["কোনো অ্যালার্জি নেই", "No known allergies"] },
    { say: ["ডায়াবেটিস আর উচ্চ রক্তচাপ", "Diabetes and high blood pressure"] },
    { say: ["আমার গাড়ি নেই", "No car; needs a stop within walking distance"] },
    { finish: true },
  ],
  followup: ["প্রায় ২ সপ্তাহ, দাঁড়ালে", "Dizzy for about 2 weeks, mostly when standing up; mild"],
};
const HASSAN: Script = {
  patientId: "P-1002", lang: "ar",
  steps: [
    { say: ["مراجعة أدويتي", "Review my medicines"] },
    { say: ["لا توجد أعراض", "No symptoms"] },
    { say: ["ليسينوبريل وميتفورمين", "Lisinopril and metformin"] },
    { photo: "lisinopril-10" },
    { say: ["هذا كل شيء", "No other medicines"] },
    { say: ["لا توجد حساسية", "No known allergies"] },
    { say: ["ارتفاع ضغط الدم والسكري", "High blood pressure and diabetes"] },
    { say: ["ليس لدي سيارة", "No car; needs a stop within walking distance"] },
    { finish: true },
  ],
  followup: ["منذ أسبوع تقريبًا، خفيف", "About one week; mild"],
};

const SCENES = ["Reset", "Razia tells her story", "Agents reconcile", "Nurse decides", "Hassan: memory applies", "Lucía: red flag", "Verified for every caregiver"];

export function Demo() {
  const [scene, setScene] = useState(-1);
  const [caption, setCaption] = useState("Press Play to watch three patients go through EchoRx.");
  const [c, setC] = useState<any>();
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [done, setDone] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const stop = useRef(false);
  const traceBox = useRef<HTMLDivElement>(null);

  useEffect(() => { const el = traceBox.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }, [c?.trace?.length]);
  useEffect(() => () => { stop.current = true; }, []);

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms / speed));
  const live = async (id: string) => { const x = await api.getCase(id); setC(x); return x; };
  const say = (s: string, n?: number) => { setCaption(s); if (n !== undefined) setScene(n); };

  async function runPatient(script: Script, beat = 1300) {
    let x = await api.createCase(script.patientId, script.lang);
    setC(x);
    await wait(beat);
    for (const step of script.steps) {
      if (stop.current) throw new Error("stopped");
      if ("say" in step) x = await api.message(x.id, step.say[0], step.say[1]);
      else if ("photo" in step) x = await api.photo(x.id, { sampleId: step.photo, dataUrl: await sampleBottleDataUrl(step.photo) });
      else {
        say(`${x.patientName} taps "Send to my care team". The agents take over.`, 2);
        x = await api.finish(x.id);
      }
      setC(x);
      if (x.status === "emergency") return x;
      await wait(beat);
    }
    for (let i = 0; i < 2 && x.status === "needs_patient"; i++) {
      say(`Summary Critic found a gap and sent a question back to ${x.patientName}, in her language. One answer, and the loop re-runs.`);
      await wait(beat * 1.6);
      const last = x.transcript[x.transcript.length - 1];
      const q = last?.quickReplies?.[0];
      x = await api.message(x.id, q?.label ?? script.followup[0], q?.en ?? script.followup[1]);
      setC(x);
      await wait(beat);
    }
    return x;
  }

  async function play() {
    stop.current = false; setRunning(true); setErr(""); setDone([]);
    try {
      say("Resetting cases and memory so the demo starts clean.", 0);
      await api.reset(true);
      await wait(800);
      setDone((d) => [...d, "Reset"]);

      say("Razia, 72, speaks Bengali and has no car. She answers on her phone, one question at a time, and photographs a pill bottle.", 1);
      const razia = await runPatient(RAZIA);
      setDone((d) => [...d, SCENES[1], SCENES[2]]);
      const esc = razia.escalations.find((e: any) => e.status === "open");
      say(`Reconciler checked Zetaris: the bottle says metformin 500 mg, the latest fill says 1000 mg. Summary Critic escalated it, H-MEM had no rule yet, so it went to the nurse.`, 2);
      await wait(4200);

      if (esc) {
        say("Nurse Okafor decides once and saves it as a rule. The Memory Keeper generalises it and stores it in H-MEM, with her name and the case as the source.", 3);
        await wait(2600);
        const after = await api.decide(razia.id, esc.id, SUGGESTED_DECISION.dose_mismatch, true);
        setC(after);
        await wait(3000);
      }
      setDone((d) => [...d, SCENES[3]]);

      say("Hassan, 58, speaks Arabic. His bottle says lisinopril 10 mg; the latest fill says 20 mg. Same kind of problem…", 4);
      const hassan = await runPatient(HASSAN);
      const hit = hassan.escalations.find((e: any) => e.status === "auto_resolved");
      say(hit ? `…so the Memory Keeper finds Nurse Okafor's rule from ${hit.memory.sourceCase} in H-MEM (relevance ${hit.memory.relevance}) and applies it, with the citation. No new escalation.` : "No memory match this time, so it was escalated to the nurse.", 4);
      await wait(4800);
      setDone((d) => [...d, SCENES[4]]);

      say("Lucía, 41, speaks Spanish. She mentions chest pain. The Safety Sentinel's rules fire before any model call.", 5);
      const lucia = await api.createCase("P-1003", "es");
      setC(lucia);
      await wait(1500);
      const l2 = await api.message(lucia.id, "Desde esta mañana tengo dolor en el pecho", "Since this morning I have chest pain");
      setC(l2);
      await wait(3800);
      setDone((d) => [...d, SCENES[5]]);

      say("The nurse verifies both summaries. Razia and Hassan each told their story once; the nurse, doctor and pharmacist all see the same verified record.", 6);
      for (const id of [razia.id, hassan.id]) {
        const cur = await api.getCase(id);
        if (cur.status === "ready") await api.approve(id);
      }
      await live(razia.id);
      await wait(1500);
      setDone((d) => [...d, SCENES[6]]);
      say("Done. Open the Doctor view, the Memory page, or any case's agent trace to see the evidence.", 6);
    } catch (e) {
      if ((e as Error).message !== "stopped") setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="demo">
      <div className="phone" dir={c?.language === "ar" ? "rtl" : "ltr"}>
        <div className="phone-head"><strong>Echo<span style={{ color: "var(--brand)" }}>Rx</span></strong><div className="spacer" />{c && <span className="tiny">{c.patientName} · {c.id}</span>}</div>
        {c?.status === "emergency" ? <Emergency c={c} /> : c ? (
          <>
            <div style={{ padding: "8px 14px", background: "var(--surface)" }}><Progress covered={c.topicsCovered} /></div>
            <Chat c={c} busy={c.status === "processing"} />
          </>
        ) : <div className="phone-body" style={{ justifyContent: "center", alignItems: "center", textAlign: "center" }}><p className="muted">The patient's phone appears here.</p></div>}
      </div>
      <div className="grid" style={{ gap: 12 }}>
        <div className="caption" aria-live="polite">{scene >= 0 && <span className="n">{scene + 1}/{SCENES.length}</span>}{caption}</div>
        <div className="row">
          <button className="btn primary" disabled={running} onClick={play}>▶ Play demo</button>
          {running && <button className="btn" onClick={() => { stop.current = true; }}>Stop</button>}
          <label className="small row">Speed
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={{ minHeight: 36, borderRadius: 8 }}>
              <option value={0.6}>Slow</option><option value={1}>Normal</option><option value={2}>Fast</option>
            </select>
          </label>
          {c && <Link to={`/case/${c.id}`} className="btn sm">Full trace</Link>}
        </div>
        <div className="scene-list">{SCENES.map((s, i) => <span key={s} className={i === scene ? "on" : done.includes(s) ? "done" : ""}>{s}</span>)}</div>
        {err && <div className="card" style={{ color: "var(--danger)" }}>Demo stopped: {err}</div>}
        <MemoryOrEscalation c={c} />
        <div className="card">
          <h3>Live agent trace {c ? `· ${c.id}` : ""}</h3>
          <div className="trace-scroll" ref={traceBox}>{c ? <TraceList events={c.trace.slice(-40)} compact /> : <p className="muted small">Every agent step appears here with the model that answered, Zetaris queries and H-MEM operations.</p>}</div>
        </div>
      </div>
    </div>
  );
}

function MemoryOrEscalation({ c }: { c: any }) {
  if (!c?.escalations?.length) return null;
  const e = c.escalations[c.escalations.length - 1];
  const d = c.discrepancies.find((x: any) => x.id === e.discrepancyId) ?? {};
  return (
    <div className={e.status === "auto_resolved" ? "memory-card fade-in" : "card fade-in"} style={e.status === "open" ? { borderColor: "var(--danger)" } : undefined}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b style={{ textTransform: "capitalize" }}>{d.drug} · {String(d.type ?? "").replace(/_/g, " ")}</b>
        <span className={`badge ${e.status === "open" ? "danger" : e.status === "auto_resolved" ? "hmem" : "ok"}`}>{e.status === "open" ? "Escalated to nurse" : e.status === "auto_resolved" ? "Applied from H-MEM" : `Decided by ${e.decidedBy}`}</span>
      </div>
      <div className="compare" style={{ marginTop: 8 }}><div><b>Patient / bottle</b>{d.patientSays}</div><div><b>Zetaris</b>{d.recordSays}</div></div>
      {e.memory && <p className="small" style={{ marginBottom: 0 }}>🧠 {e.memory.rule} <span className="tiny">— {e.memory.nurse}, {e.memory.sourceCase}</span></p>}
      {e.decision && <p className="small" style={{ marginBottom: 0 }}>✍️ {e.decision}{e.savedRuleId && <span className="badge hmem" style={{ marginInlineStart: 6 }}>saved {e.savedRuleId}</span>}</p>}
    </div>
  );
}
