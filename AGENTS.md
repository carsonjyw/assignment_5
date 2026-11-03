<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# HEADWAY: project context for agents

Headway is a live NYC Subway arrival tracker (MPCS 51238, Assignment 5, Live Data System). Riders sign in, follow stations, and watch arrival boards update without refreshing.
The full approved design, diagram, rationale, and the egress/write/Realtime benchmark (§3.6) are in [`docs/step3/DATA_FLOW.md`](docs/step3/DATA_FLOW.md). The source investigation is in [`docs/step1/STEP1_LIVE_SOURCE.md`](docs/step1/STEP1_LIVE_SOURCE.md). Read both before changing the data flow.

## Stack
- Next.js 16 (App Router, `cacheComponents: true`) + Tailwind 4, deployed on Vercel from GitHub.
- Clerk (`@clerk/nextjs`, app `headway`, `app_3LbgNvGCWJaXIeFDUF5ZsyFPLFH`). `ClerkProvider` sits inside `<body>`. Wrap `<Show>` and anything that calls `auth()` in `<Suspense>`.
- Supabase project `headway` (`fddulhtbsrrzepgehdhi`): Postgres, Realtime (Postgres Changes), Edge Functions (Deno), Cron (`pg_cron` + `pg_net`), and Vault.
- Edge Function code lives in `supabase/functions/`. `supabase` is excluded in `tsconfig.json` so the Next.js build ignores Deno code.

## Approved architecture
- **Source:** all 8 MTA GTFS-Realtime subway feeds (`nyct%2Fgtfs`, `-ace`, `-bdfm`, `-g`, `-jz`, `-l`, `-nqrw`, `-si`), protobuf, no API key. Full system coverage is a product requirement: never drop lines, shuttles, or SIR.
- **Worker:** Edge Function `poll-subway`, called by Supabase Cron **every 15 s** through `pg_net` with an `x-worker-secret` header. The URL and secret are in Vault and function secrets, never in the repo.
  Each run:
  1. `claim_worker_run()` takes an atomic lease: an advisory lock, a partial unique index on `status = 'running'`, a 30 s lease, and `insert … on conflict do nothing`.
  2. Fetch the 8 feeds in parallel (6 s timeout each, 12 s run budget) and decode.
  3. Report each feed's `ok`/`feed_ts`/`reason`. The worker only checks timeouts, HTTP errors, decode errors, and `header.timestamp` > 90 s old.
  4. Build **candidate** boards: the next 3 trains per route for each platform, from healthy feeds, with `eta` in [now − 30 s, now + 90 min].
  5. Send everything to `commit_worker_run(run_id, feeds, boards)`. If anything throws, call `fail_worker_run()`.
- **The worker never reads boards or status back.** Reading ~837 KB of boards every 15 s would be ~148 GB/month of egress against a 5 GB free quota.
- **`commit_worker_run` (PostgreSQL, one transaction)** does all comparison and writing:
  - Validates the input: exactly 8 feeds; ≤ 2,000 boards; each train's stop exists, its route belongs to the claimed feed, its `eta`, `kind`, `live`, and `trip_id` are well-formed. Invalid trains are dropped and counted.
  - Checks the lease and fencing (`run_id`).
  - Rejects feeds that are `not_newer` (timestamp older than the last accepted), `unmapped_spike` (> 20% unknown stops), or `empty` (reported ok but 0 valid trains).
  - Carries over stored trains for rejected feeds. They're marked `carried` only from the feed's **2nd consecutive** failure.
  - Rebuilds the boards and diffs them against the stored rows with `board_changed()`.
  - Upserts **only changed rows**, with `where platform_boards.run_id < excluded.run_id`.
  - Updates `worker_status` (heartbeat plus per-feed health and `fail_streak`) and finishes `worker_runs`.
  - Its reply is ~150 B.
- **Change rule (`board_changed`, the single source of truth):** write a board immediately when train identity or order, departure, the arriving window (< 60 s), `live`, route or headsign, `kind`, or `carried` changes, or when a prediction disappears. Otherwise, write only if an ETA moved ≥ 30 s from the **stored** value. Never upsert unchanged rows, because each update is a billed Realtime message. Measured: ~300 of 975 boards change per 15 s run.
- **Tables (8):**
  - `routes`, `stations` (station complexes), `platforms` (`stop_id` + N/S), `route_stops`: static, public read.
  - `platform_boards`: public read, in Realtime.
  - `worker_status`: 1-row heartbeat with per-feed health, public read, in Realtime.
  - `worker_runs`: private log and lease.
  - `follows`: user-owned, RLS on `(select auth.jwt()->>'sub') = user_id`, max 12 per user.
  - Worker functions are `security definer`, executable by `service_role` only.
- **Realtime:** Postgres Changes on `platform_boards` filtered by `station_id=in.(…)` or `eq`, plus `worker_status`. Subscribe only to stations that are visible or followed, never table-wide. Pause subscriptions while the tab is hidden or idle more than 30 min. A typical rider gets ~3 messages per run; free limits are 2M/month and 100/s. Countdowns tick locally from absolute `eta`, corrected by a server clock offset.
- **Auth:** the browser Supabase client uses Clerk's session token (`accessToken`). Verified 2026-11-03: Clerk tokens are RS256 with `role: authenticated` and `sub` = Clerk user ID, Supabase accepts them, and it rejects tampered ones (401). Tokens live 60 s, so always use the `accessToken` callback and never cache a token.
- **States:** Loading, Fresh, Stale (no successful run in > 60 s), Down (worker error, or all of a station's feeds unhealthy), Partial (some of a station's feeds unhealthy or > 90 s old), and a Reconnecting banner (channel not subscribed, or no heartbeat event in 30 s; the page then polls `worker_status` over REST). Never derive freshness from board `updated_at`.

## Implementation (Step 4)
- **Migrations** (`supabase/migrations/`, file versions match the remote history):
  - `…185806_extensions`, `…185826_schema`, `…185908_worker_functions`.
  - Four static seeds, `…190404` to `…190702`, generated by `scripts/generate_static_seed.py` from MTA static GTFS + `Stations.csv`. They're idempotent. Regenerate them instead of hand-editing.
  - `…191222_cron_schedule`.
  - `…191915_follows_rls_perf` (advisor fix: `(select auth.jwt()) ->> 'sub'`, plus an index on `follows.station_id`).
- **Worker code:** `supabase/functions/poll-subway/`. `gtfs.ts` is a dependency-free protobuf decoder (including the NYCT `is_assigned` extension), `boards.ts` builds candidates, `worker.ts` does one run, and `index.ts` handles HTTP and auth. Deployed with `verify_jwt: false`; the function checks `x-worker-secret` itself, trimmed, with a constant-time compare.
- **Tests:** `cd supabase/functions && deno task test`. 11 tests on `docs/step1/evidence/raw/*.pb`, with all migrations running in PGlite. Run them before every deploy.
- **Manual run without exposing the secret:** `select net.http_post(... 'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'worker_secret') ...)`, then read `net._http_response`.
- **Cron jobs:** `poll-subway` (`15 seconds`) and `headway-prune` (daily, 04:17 UTC). Pause with `select cron.alter_job((select jobid from cron.job where jobname = 'poll-subway'), active := false);`.

## Verified live (2026-11-03, 19:11–19:20 UTC)
- **Cron:** 30 fires, 0 failed. Gap between fires 15.01–15.36 s.
- **Runs:** 33 worker runs, all `ok`, all 8 feeds healthy every run.
  - Database duration averaged 439 ms (max 652 ms); end-to-end averaged ~0.5–0.8 s.
  - Each run fetches ~675 KB from MTA in 60–110 ms.
- **Changed-rows-only:** after the initial fill (982 boards), runs rewrite **307–485 of 982 boards (average 379, about 40%)**. The rest keep their older `run_id`. A run only 3.5 s after the previous one wrote 52.
- **Overlap safety:** two simultaneous calls (twice, including during Cron) → one `skipped`, one run. No duplicate or stale writes.
- **Auth:** missing, wrong, 64-zero, or Bearer-only requests and GET all return 401. Logs contain no secret values (scanned for long hex strings and key prefixes).
- **No errors:** 0 Edge Function error lines; HTTP responses were 200s plus the deliberate 401s.
- **Advisors:** only INFO notes remain (`worker_runs` has no policies by design; indexes not yet used until Step 5).
- **Known quirks:**
  - The dashboard-entered `WORKER_SECRET` has 2 extra whitespace characters. The function trims both sides, so it works.
  - `worker_runs.details` doesn't include `commit_ms`/`total_ms` (they're measured after the commit writes the row). They're in the function's log line, and `duration_ms` covers claim → commit.

## Working rules
- Follow the assignment's steps in order. Don't start the next step until the user approves.
- Never read, print, or modify `.env*` files. Never put secrets in code.
- Tests: `deno test` runs the worker on saved MTA fixtures and runs the migration SQL in in-memory PGlite (`npm:@electric-sql/pglite`). No network or live database is needed.
- Don't modify the separate FERA project.
- Don't commit or push unless the user asks.
- Stay on free tiers. Keep Edge Function calls ≤ 1 per 15 s, keep Realtime messages limited to changed rows, and never add reads of large tables from the worker (egress is 5 GB/month).
- UI copy uses rider terms ("Uptown & The Bronx", "Arriving", "4 min"), never "N/S" or internal IDs.
