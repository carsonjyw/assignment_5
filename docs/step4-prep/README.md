# Step 4 prep: SQL-side board comparison benchmark

This is the evidence behind [DATA_FLOW.md §3.6](../step3/DATA_FLOW.md). Nothing here touched the live Supabase project: every run happened inside a transaction that was rolled back, in an in-memory PGlite (PostgreSQL 18, WebAssembly) database.

| File | What it is |
|---|---|
| `prototype.sql` | Prototype `board_changed`, `claim_worker_run`, `commit_worker_run` on `pg_temp` tables. This is the starting point for the Step 4 migration |
| `bench.py` | Builds candidate boards from snapshots A–E and writes `bench_<carry_after>.sql` (prototype + replay driver) |
| `run.mjs` | Runs the generated SQL in PGlite (`@electric-sql/pglite@0.5.11`) and prints the result |
| `evidence/bench_results_carry_after_2.txt` | Results with the approved setting: carry only after a 2nd consecutive feed failure |
| `evidence/bench_results_carry_after_1.txt` | Comparison: carry on the 1st failure |
| `evidence/snap_D.json.gz`, `snap_E.json.gz` | Decoded live snapshots taken exactly 15 s apart (2026-11-03 18:30:55 and 18:31:10 UTC). A–C are in `../step1/evidence/` |

To reproduce: `bench.py` expects the Step 1 working layout, meaning a folder containing `snap_A…E.json` (gunzipped), `static/sub/stops.txt`, `static/Stations.csv` (MTA static GTFS), and `bench/prototype.sql`. Then:

```bash
python bench/bench.py 2
node run.mjs bench/bench_2.sql
```
