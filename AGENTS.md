<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# HEADWAY: project context for agents

Headway is a live NYC Subway arrival tracker (MPCS 51238, Assignment 5, Live Data System). Riders sign in, follow stations, and watch arrival boards update without refreshing.
The full approved design, diagram, and rationale are in [`docs/step3/DATA_FLOW.md`](docs/step3/DATA_FLOW.md). The source investigation is in [`docs/step1/STEP1_LIVE_SOURCE.md`](docs/step1/STEP1_LIVE_SOURCE.md). Read both before changing the data flow.

## Stack
- Next.js 16 (App Router, `cacheComponents: true`) + Tailwind 4, deployed on Vercel from GitHub.
- Clerk (`@clerk/nextjs`, app `headway`, `app_3LbgNvGCWJaXIeFDUF5ZsyFPLFH`). `ClerkProvider` sits inside `<body>`. Wrap `<Show>` and anything that calls `auth()` in `<Suspense>`.
- Supabase project `headway` (`fddulhtbsrrzepgehdhi`): Postgres, Realtime (Postgres Changes), Edge Functions (Deno), Cron (`pg_cron` + `pg_net`), and Vault.
- Edge Function code lives in `supabase/functions/`. `supabase` is excluded in `tsconfig.json` so the Next.js build ignores Deno code.

## Approved architecture
- **Source:** all 8 MTA GTFS-Realtime subway feeds (`nyct%2Fgtfs`, `-ace`, `-bdfm`, `-g`, `-jz`, `-l`, `-nqrw`, `-si`), protobuf, no API key. Full system coverage is a product requirement: never drop lines, shuttles, or SIR.
- **Worker:** Edge Function `poll-subway`, called by Supabase Cron **every 15 s** through `pg_net` with an `x-worker-secret` header. The URL and secret are in Vault and function secrets, never in the repo.
  Each run:
  1. `claim_worker_run()` takes an atomic lease: an advisory lock, a partial unique index on `status = 'running'`, and a 30 s lease.
  2. Fetch the 8 feeds in parallel (6 s timeout each, 12 s run budget), then decode.
  3. Validate each feed. It's unhealthy on timeout, decode error, `header.timestamp` > 90 s old, a timestamp older than the last accepted one, no trips, or > 20% unmapped stops.
  4. Build boards: the **next 3 trains per route** for each platform. Trains from an unhealthy feed are carried over and marked `carried`.
  5. Diff against the stored boards.
  6. Call `commit_worker_run()`, which upserts only the changed boards **fenced by `run_id`**, updates `worker_status`, and finishes `worker_runs`, all in one transaction.
  7. If anything throws, call `fail_worker_run()`.
- **Change rule:** write a board immediately when train identity or order, departure, the arriving window (< 60 s), `live`, route or headsign, `kind`, or `carried` changes, or when a prediction disappears. Otherwise, write only if an ETA moved ≥ 30 s from the **stored** value. Never upsert unchanged rows, because each update is a billed Realtime message.
- **Tables (8):**
  - `routes`, `stations` (station complexes), `platforms` (`stop_id` + N/S), `route_stops`: static, public read.
  - `platform_boards`: public read, in Realtime.
  - `worker_status`: 1-row heartbeat with per-feed health, public read, in Realtime.
  - `worker_runs`: private log and lease.
  - `follows`: user-owned, RLS on `(select auth.jwt()->>'sub') = user_id`, max 12 per user.
  - Worker functions are `security definer`, executable by `service_role` only.
- **Realtime:** Postgres Changes on `platform_boards` filtered by `station_id=in.(…)` or `eq`, plus `worker_status`. Subscribe only to stations that are visible or followed, never table-wide. Countdowns tick locally from absolute `eta`, corrected by a server clock offset.
- **Auth:** the browser Supabase client uses Clerk's session token (`accessToken`), configured via Supabase Third-party Auth → Clerk.
- **States:** Loading, Fresh, Stale (no successful run in > 60 s), Down (worker error, or all of a station's feeds unhealthy), Partial (some of a station's feeds unhealthy or > 90 s old), and a Reconnecting banner (channel not subscribed, or no heartbeat event in 30 s; the page then polls `worker_status` over REST). Never derive freshness from board `updated_at`.

## Working rules
- Follow the assignment's steps in order. Don't start the next step until the user approves.
- Never read, print, or modify `.env*` files. Never put secrets in code.
- Don't modify the separate FERA project.
- Don't commit or push unless the user asks.
- Stay on free tiers. Keep Edge Function calls ≤ 1 per 15 s, and keep Realtime messages limited to changed rows.
- UI copy uses rider terms ("Uptown & The Bronx", "Arriving", "4 min"), never "N/S" or internal IDs.
