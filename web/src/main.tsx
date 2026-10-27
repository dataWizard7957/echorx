import { createRoot } from "react-dom/client";
import { Link, TopBar, usePath } from "./ui";
import { Patient } from "./pages/Patient";
import { Nurse } from "./pages/Nurse";
import { Demo } from "./pages/Demo";
import { CaseTrace, Doctor, Memory } from "./pages/Others";

function Landing() {
  return (
    <>
      <section className="hero">
        <div>
          <span className="badge brand">Open Agent Hackathon 2026 · Track 3: Reasoning Architecture</span>
          <h1 style={{ marginTop: 14 }}>Say it once.<br />Every caregiver hears it.</h1>
          <p className="lead">Razia is 72, speaks Bengali, has no car and takes five medicines. She tells her story once, on her phone. A team of agents checks it against her pharmacy records, asks a nurse when it's unsure, remembers the answer, and books a van stop she can walk to.</p>
          <div className="row" style={{ marginTop: 18 }}>
            <Link to="/demo" className="btn primary">▶ Play the demo</Link>
            <Link to="/start" className="btn">I'm a patient</Link>
            <Link to="/nurse" className="btn">Nurse inbox</Link>
            <Link to="/doctor" className="btn ghost">Doctor view</Link>
          </div>
        </div>
        <div className="echo-visual" aria-hidden>
          <div className="ring" /><div className="ring" /><div className="ring" />
          <div className="center">Razia's<br />story, once</div>
          <span className="who" style={{ top: "6%", left: "38%" }}>🩺 Nurse</span>
          <span className="who" style={{ top: "44%", right: "-2%" }}>👩‍⚕️ Doctor</span>
          <span className="who" style={{ bottom: "6%", left: "34%" }}>💊 Pharmacist</span>
          <span className="who" style={{ top: "44%", left: "-4%" }}>🚐 Van crew</span>
        </div>
      </section>
      <div className="steps">
        {[
          ["Intake + Safety Sentinel", "One question at a time in English, Bengali, Arabic or Spanish. Red flags trigger \"Call 911\" before any model runs."],
          ["Reconciler on Zetaris", "Pill-bottle photos and answers are lined up with pharmacy fills and visits, with every finding citing record IDs."],
          ["Summary Critic", "Finds gaps and unsupported claims; sends questions back to the patient (max 2 rounds) or escalates."],
          ["Memory Keeper on H-MEM", "A nurse decides once; the rule is remembered, cited and reused on the next similar case."],
          ["Scheduler on Zetaris", "Picks a walkable van stop with a crew that speaks the patient's language."],
        ].map(([h, p]) => <div key={h} className="card step"><h3>{h}</h3><p className="small muted" style={{ margin: 0 }}>{p}</p></div>)}
      </div>
      <p className="tiny" style={{ marginTop: 24 }}>EchoRx never diagnoses, suggests treatment or judges a dose. All data is synthetic. Powered by Meterless Nightshift with NVIDIA Nemotron, Zetaris as the data layer, and the Meterless H-MEM engine.</p>
    </>
  );
}

function App() {
  const path = usePath();
  const caseMatch = path.match(/^\/case\/([^/]+)/);
  const page =
    path.startsWith("/start") ? <Patient /> :
    path.startsWith("/nurse") ? <Nurse /> :
    path.startsWith("/doctor") ? <Doctor /> :
    path.startsWith("/memory") ? <Memory /> :
    path.startsWith("/demo") ? <Demo /> :
    caseMatch ? <CaseTrace id={decodeURIComponent(caseMatch[1])} /> :
    <Landing />;
  return (
    <div className="app">
      <TopBar path={path} />
      <main className="main">{page}</main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
