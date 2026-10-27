# Every SQL statement EchoRx agents run

All are read-only `SELECT`s on the `echorx` schema, sent one at a time to `POST /sql-editor/sqls/run`. Values are validated against `^[A-Za-z0-9 _.\-,]{1,64}$` before being quoted.

| Agent | SQL | Expected (sample data) |
|---|---|---|
| Orchestrator | `SELECT patient_id, display_name, age, zip, language, has_car, mobility, neighborhood, home_lat, home_lng FROM echorx.patients WHERE patient_id = 'P-1001'` | 1 row (Razia R.) |
| Reconciler | `SELECT fill_id, patient_id, drug, strength, directions, fill_date, days_supply, pharmacy FROM echorx.pharmacy_fills WHERE patient_id = 'P-1001' ORDER BY fill_date` | 5 rows (F-5001, F-5104, F-5101, F-5102, F-5103) |
| Reconciler | `SELECT visit_id, patient_id, visit_date, site, reason, med_changes FROM echorx.visit_history WHERE patient_id = 'P-1001' ORDER BY visit_date` | 2 rows (V-2108, V-2208) |
| Reconciler | `SELECT rule_id, category, trigger, action, escalate_to, notes FROM echorx.triage_policy` | 12 rows |
| Scheduler | `SELECT stop_id, van_id, site_name, area, zip, lat, lng, weekday, start_time, end_time, languages FROM echorx.van_stops` | 8 rows |
| Scheduler | `SELECT slot_id, stop_id, start_time, capacity, booked FROM echorx.clinic_slots WHERE stop_id IN ('VS-01', …, 'VS-08') ORDER BY start_time` | 58 rows |
| Setup check | `SELECT COUNT(*) AS n FROM echorx.<view>` | counts in `data/README.md` |

Zetaris returns rows as arrays, so the repository selects explicit columns in a fixed order and maps them by position (`zetaris/views.json`).
