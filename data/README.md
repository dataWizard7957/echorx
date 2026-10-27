# EchoRx data (synthetic)

All rows were created for this prototype. No real people or records are included. **Licence: CC0.**

| File | Rows | Columns | Notes |
|---|---|---|---|
| `patients.json` | 8 | patient_id, display_name, age, zip, language, has_car, mobility, neighborhood, home_lat, home_lng | Demo patients: P-1001 Razia (bn), P-1002 Hassan (ar), P-1003 Lucía (es). Home coordinates are neighbourhood-level approximations. |
| `pharmacy_fills.json` | 14 | fill_id, patient_id, drug, strength, directions, fill_date, days_supply, pharmacy | Razia: metformin 500 mg (older) → 1000 mg (F-5101, latest); amlodipine F-5104, 30-day supply from August (overdue). Hassan: lisinopril 10 mg → 20 mg (F-6101). |
| `visit_history.json` | 6 | visit_id, patient_id, visit_date, site, reason, med_changes | V-2208: metformin increased 500 → 1000 mg. V-2311: lisinopril increased 10 → 20 mg. |
| `van_stops.json` | 8 | stop_id, van_id, site_name, area, zip, lat, lng, weekday, start_time, end_time, languages | A weekly recurring schedule, so the next date is computed and the demo never goes stale. |
| `clinic_slots.json` | 58 | slot_id, stop_id, start_time, capacity, booked | 30-minute slots per stop. |
| `triage_policy.json` | 12 | rule_id, category, trigger, action, escalate_to, notes | RF-01…06 red flags; POL-DOSE, POL-REFILL, POL-NOREC, POL-NOTAKE, POL-WALK, POL-LANG. |

## How it reaches Zetaris
Each file is a JSON object `{ "data": [ ... ] }`. `zetaris/register.sql.template` registers each file as a Lightning REST table (`echorx_rest.<name>_raw`) from `DATA_BASE_URL`, and a SchemaStore view `echorx.<name>` that flattens it with `LATERAL VIEW explode(data)`. Run `npm run zetaris:sql` then `npm run zetaris:register`.

`DATA_BASE_URL` must be reachable by the **Zetaris server**. A public GitHub raw URL is simplest. Zetaris cannot read files on your laptop.

## Regenerating
The files are hand-curated. Edit them directly, keep IDs stable (tests reference them), and re-run `npm run zetaris:register`. That script skips anything that already exists, and its row-count check confirms the new data.
