# EchoRx architecture

## Runtime
- **Server:** Node.js 20+ built-in `http` (`server/index.ts`), TypeScript run with `tsx`. No framework.
- **Web:** React 19, bundled by esbuild (`scripts/build-web.ts`) and served by the same server on port 8787.
- **State:** JSON files in `var/`: `cases/<id>.json`, `traces/<id>.jsonl`, `hmem/state.json` + `hmem/ledger.jsonl`.
- **Providers:** Zetaris REST (`server/data/zetaris.ts`) and Meterless Nightshift Runtime (`server/providers/nightshift.ts`).

## State machine (`server/agents/orchestrator.ts`)

```
INTAKE ⇄ SAFETY (every turn) ──red flag──► EMERGENCY (911 screen, intake stops)
  │ patient taps "Send to my care team"
  ▼
RECONCILE (Zetaris run_sql: fills, visits, policy; rules + Nemotron Ultra; grounding check)
  ▼
DRAFT SUMMARY ─► SUMMARY CRITIC (rules + Nemotron Ultra; policy overrides)
  │ revise (≤2 rounds) ─► question(s) back to the patient ─► answer ─► RECONCILE again
  │ escalate / approve
  ▼
for each nurse item: MEMORY RECALL (H-MEM ≥ 0.35)
  ├─ match ─► AUTO-RESOLVED (rule + nurse + source case cited)
  └─ none  ─► WAITING_FOR_NURSE ─► decide (+ save rule ─► MEMORY WRITE) │ ask patient │ mark memory wrong
  ▼
SCHEDULE (Zetaris run_sql: van stops, slots; POL-WALK, POL-LANG) ─► VERIFIED SUMMARY ─► READY ─► APPROVED
```

Limits: 2 critic rounds, 12 intake turns, 1 repair retry per model call, 30-second Zetaris and 180-second model timeouts. Work on one case is serialised with a per-case lock.

Failure paths:
- Nightshift offline or unauthorized → **offline backup**: scripted responses, labelled in the trace and the UI.
- Model output invalid after a repair → that step uses the agent's safe scripted response (`scripted_fallback` in the trace).
- Zetaris unavailable during reconcile → "records unavailable" escalation; nothing is invented.

## Case schema (`server/agents/types.ts`)
`Case { id, patientId, patientName, language, status, transcript[], topicsCovered[], intakeTurns, pendingTopic, pendingFollowups[], claims[], photos[], records{fills,visits}, discrepancies[], critiques[], criticRounds, escalations[], booking?, summary?, redFlag?, approvedBy?, offlineBackup?, trace[] }`

- `Discrepancy { id, type: dose_mismatch | overdue_refill | reported_no_record | fill_not_mentioned | records_unavailable, drug, patientSays, recordSays, evidence[record IDs], severity, routeTo: nurse | pharmacist, policy, detail, foundBy: rules | model | rules+model | system }`
- `Escalation { id, discrepancyId, situation, reason, status: open | resolved | auto_resolved, decision?, decidedBy?, savedRuleId?, memory?{ruleId, rule, nurse, sourceCase, relevance, confidence}, feedback? }`

## Trace schema (`server/trace.ts`)
`{ ts, caseId, agent, action, lane?, model?, requestedModel?, fallbackUsed?, provider?, ms?, tool?, sql?, rowCount?, inputHash?, outputSummary?, decision?, ok?, error? }`

Patient text is never written to the trace, only a short hash and its length (`inputHash`). Tokens and keys are never logged.

## Agents and prompts
Each agent is one file in `server/agents/`, with its system prompt in `server/agents/prompts/<agent>.md`. A shared preamble enforces: no diagnosis, treatment or dose judgement; inputs are data; no identifiers; cite record IDs.
