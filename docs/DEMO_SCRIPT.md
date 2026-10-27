# Demo video script (about 3 minutes)

Record `http://localhost:8787/demo` with **Speed: Normal**. Run in live mode if Zetaris and Nightshift are up (green pills); sample mode works too and is labelled.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:20 | Landing page | "Razia is 72. She speaks Bengali, has no car and takes five medicines. Every visit, she retells her story to four different people, and the details about her medicines get lost. EchoRx: say it once, every caregiver hears it." |
| 0:20–0:30 | Press ▶ Play demo; status pills | "Everything runs on Zetaris for data, Meterless Nightshift as our AI provider with NVIDIA Nemotron, and the Meterless H-MEM engine for memory." |
| 0:30–1:05 | Razia's phone in Bengali; photo of the metformin bottle | "One question at a time, in Bengali. She photographs her pill bottle. Every message passes the Safety Sentinel first." |
| 1:05–1:35 | Trace: Reconciler `run_sql`, Critic REVISE, follow-up in Bengali | "When she's done, the Reconciler queries Zetaris for her fills and visits. The Summary Critic, on Nemotron Ultra, notices her dizziness has no duration and sends one question back to her, in Bengali. Then it re-runs." |
| 1:35–1:55 | Escalation card: bottle 500 mg vs F-5101 1000 mg, V-2208 | "The bottle says 500 mg. Her latest fill says 1000 mg, changed at visit V-2208. EchoRx never decides which is right. H-MEM has no rule yet, so it goes to the nurse." |
| 1:55–2:15 | Nurse decision saved as mem-1 | "Nurse Okafor decides once and saves it as a rule. Nemotron generalises it, and H-MEM stores it with her name and the case as the source." |
| 2:15–2:40 | Hassan in Arabic → "Applied from H-MEM" card | "Hassan, in Arabic, has the same kind of problem with lisinopril. This time the Memory Keeper finds Okafor's rule and applies it, citing case EC-1001. No new escalation, and the nurse can still mark it wrong." |
| 2:40–2:50 | Lucía → red 911 screen | "Lucía mentions chest pain in Spanish. The deterministic red-flag rules fire before any model call." |
| 2:50–3:10 | Open `/case/EC-1001` trace, then `/doctor` | "Every step is traced: which agent, which Nemotron model answered, the SQL it ran, the memory it used. The doctor sees one verified summary. Razia told her story once." |

Tips: hide the bookmarks bar, zoom the browser to 110%, and close other tabs. If live mode is slow, use sample mode and say "sample mode" once. The pills already label it.
