# Sponsor technology in EchoRx

This document answers the submission's sponsor-technology questions directly. Every claim points to code and to evidence you can run.

## 1. How Zetaris is integrated (the data layer)

**What Zetaris serves:** six synthetic tables that make up a small health system's records: `patients`, `pharmacy_fills`, `visit_history`, `van_stops`, `clinic_slots` and `triage_policy`.

**How they get into Zetaris:** each `data/*.json` file is registered as a **Lightning REST table**, then flattened by a **SchemaStore view** in the `echorx` container (`zetaris/register.sql.template`). This follows the pattern of Zetaris's own PokéAPI recipe. `npm run zetaris:register` sends each statement on its own and checks row counts.

**How agents use it:** agents never read files. They call typed repository functions (`server/data/repository.ts`), which issue SQL through the `run_sql` tool (`server/data/zetaris.ts`):
- `POST {ZETARIS_REST_URL}/sql-editor/sqls/run` with `Authorization: Bearer`, `X-Org-ID` and a fresh UUID `X-Request-ID` on every request
- one statement per request, 30-second timeout, one retry on 5xx and none on 4xx
- a **read-only guard**: agents may only `SELECT` from `echorx.*`
- every query is traced with its SQL, row count and latency

| Agent | Queries |
|---|---|
| Orchestrator | `echorx.patients` |
| Reconciler | `echorx.pharmacy_fills`, `echorx.visit_history`, `echorx.triage_policy` |
| Scheduler | `echorx.van_stops`, `echorx.clinic_slots` |

The full catalogue is in `zetaris/queries.md`.

**Why it matters:** the patient's record lives in separate systems (pharmacy, visits, van schedule). Zetaris gives the agents one SQL access point, so the Reconciler can say "bottle 500 mg vs latest fill F-5101 at 1000 mg, changed at visit V-2208", citing records it actually read.

**If Zetaris is down:** the Reconciler never invents records. The case escalates to the nurse with "records unavailable".

## 2. Which Meterless Engine: H-MEM

**What it does in EchoRx:** it turns one nurse's judgement into a reusable, cited, auditable rule.
- When the Summary Critic escalates a discrepancy, the **Memory Keeper** first queries H-MEM. If a rule for that situation scores ≥ 0.35 (the H-MEM retrieval threshold), it is applied and the case shows *"Applied from memory: Nurse Janelle Okafor, case EC-1001"*.
- When a nurse decides, the Memory Keeper generalises the decision (on the Nemotron fast lane, removing patient details) and stores it as a `long_term` H-MEM record. The record carries `source: nurse:<name>/case:<id>`, `confidence: 0.9`, provenance and tags.
- Nurse feedback uses H-MEM's exact deltas: approve → `helpful` (+0.05); **Mark wrong** → `wrong` (−0.20), which tags the rule `review` and stops it being reused.
- It is **file-backed** (`var/hmem/state.json` + `ledger.jsonl`), so memory survives a server restart. That is the cross-session proof.

**Code:** `server/hmem/index.ts` (the engine, adapted from the Apache-2.0 Meterless reference) and `server/hmem/careMemory.ts` (EchoRx's clinical use), used from `server/agents/memoryKeeper.ts`.

**The test showing it works:**
- `npm run test:hmem` runs the **official H-MEM conformance suite** against our engine: **13/13 checks passed**. The scorecard is saved in `docs/hmem-conformance.txt`.
- `tests/hmem.feature.test.ts` stores a nurse rule, restarts H-MEM on the same directory, and checks that a similar case (lisinopril instead of metformin) retrieves it with the right nurse and case. It also checks that rules don't leak across situations, and that `wrong` feedback blocks reuse.
- `tests/orchestrator.test.ts` runs Razia's escalation, then Hassan's case after a restart, and asserts it was auto-resolved citing Razia's case.
- In the UI, `/memory` shows each rule with its trust ledger.

## 3. How EchoRx connects to Meterless Nightshift (primary AI provider)

`server/providers/nightshift.ts` implements the **POWER → "Add Meterless as a provider"** contract:
- base URL normalised to `<host>/v1`, never `/v1/v1` (tested)
- `Authorization: Bearer <runtime token>` on every call, with `rt-local` rejected; `meterless-app: echorx` on every call; `meterless-scope: user` on chat
- `GET /v1/models` decides status: 200 means online, 401/403 means unauthorized, anything else means offline
- `POST /v1/chat/completions`, OpenAI-compatible, 180-second timeout
- JSON output validated with zod, with one repair retry. If it is still invalid, the agent's safe scripted answer is used and traced.
- pinned model returns 404 → one fallback to `meterless/auto`, recorded as `fallbackUsed`
- if Nightshift disappears mid-demo, the case continues in a labelled **offline backup** mode

**There is no other AI provider in the code:** no OpenAI, Google or NVIDIA SDKs and no direct calls. `.env` holds only the Nightshift URL and token.

## 4. Where NVIDIA technology contributes

| Lane | Model (pinned in Nightshift) | Agents |
|---|---|---|
| fast | `nvidia/nemotron-3.5-lightning-30b-a3b` | Intake (4 languages), Safety Sentinel double-check, Memory Keeper (rule generalisation), Scheduler (patient confirmation in her language) |
| deep | `nvidia/nemotron-3-ultra-550b-a55b` | Reconciler (reviews rule findings, may add findings, all evidence-checked), Summary Critic (approve / revise / escalate) |
| vision | `meterless/vision` (configured for Nemotron 3.5 Super VL; not admitted by this meterlessd edition, see README limitations) | Med Reader (pill-bottle labels) |

**Evidence:** every model call in the trace records the model that **actually answered**: the response `model` field plus any `meterless-*` headers. These are shown as green NVIDIA badges in `/case/:id` and the demo. `npm run check` prints "answered by nvidia/nemotron-… · Nemotron ✓" for both lanes.

**For the DGX Spark (best use of Nemotron):** Nemotron does the multilingual intake and the reasoning that decides whether a human must be involved. Ultra critiques the summary and reviews the reconciliation. Lightning turns a nurse's free-text decision into a general rule that H-MEM reuses across patients.

## 5. What is unique about our use of the sponsor technology

- **H-MEM as clinical oversight that scales:** one nurse decision becomes a rule with provenance, confidence and an audit trail. The next similar case is handled automatically but still shown to the nurse, with the citation and a "Mark wrong" button that lowers confidence through H-MEM's own feedback model. The human stays in charge; the system stops asking the same question twice.
- **Zetaris as the source of truth, enforced:** findings that cite record IDs not returned by Zetaris are rejected, and the trace shows the rejection. Rule findings from Zetaris data can't be silently dropped by the model.
- **Nemotron with guard rails:** deterministic safety rules run before any model, policy can override the model (a nurse item can't be "approved" away), and every override is visible in the trace.
