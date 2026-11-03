# HEADWAY

**Live NYC subway arrivals, an interactive network map, and trip planning for every line.**

**Live site: https://headway-one.vercel.app** · [Source on GitHub](https://github.com/carsonjyw/assignment_5) · MPCS 51238, Assignment 5 (Live Data System)

[Overview](#overview) · [Features](#features) · [Architecture](#system-architecture) · [Development process](#development-process-steps-16) · [User testing](#real-user-testing) · [Verification](#testing-and-verification) · [Local development](#local-development) · [Limitations](#limitations-and-future-improvements) · [Attribution](#data-sources-and-attribution)

## Overview

HEADWAY shows when the next trains reach any of the 445 NYC subway station complexes, across all 29 routes, including the shuttles and the Staten Island Railway. Arrivals update about every 15 seconds **without refreshing the page**.

**The experience.** The page opens on a map of the whole system, with real track geometry over NYC's land, rivers and parks. Tap a station, or search for one, and a panel shows every platform grouped by line, in both directions. Each arrival says whether it is a live MTA prediction or just the timetable, with a countdown that keeps ticking. **Plan** finds a route between two stations, including transfers, and draws it on the map. **Saved** lists the stations you chose, with their arrivals, after you sign in. Exploring and planning need no account.

| Tab | What it does | Account? |
|---|---|---|
| **Explore** | Map, station and line search, live station boards, line pages | No |
| **Plan** | Journey between two stations, scheduled estimate plus live next trains | No |
| **Saved** | Your saved stations and their live arrivals | Sign in |

## Features

Every feature below is implemented and in the deployed app.

- **Interactive subway map with geographic context.**
  - Drag, wheel, pinch, keyboard and +/− controls.
  - Track geometry from MTA's static data, drawn as one connected network with parallel lines bundled by trunk colour.
  - NYC land, rivers, parks, borough names, neighbourhood names and water labels, in the same projection.
  - Labels thin out by zoom level without overlapping.
  - Selecting a line or a trip dims everything else.
- **Real-time arrival predictions.** All 8 MTA GTFS-Realtime feeds, refreshed every 15 seconds. Arrivals show `LIVE` or `SCHEDULED`, the destination, the clock time, and a countdown.
- **Line and station search.** Typo-tolerant station search (for example "jamacia" finds Jamaica), and line search by letter or number.
- **Trip planning from real MTA schedule data.**
  - Transfers use MTA's own minimum transfer times.
  - The result lists the lines, direction, "toward" destination, boarding station, number of stops, each transfer, and a scheduled duration.
  - The live next trains are shown at each boarding station, and the route is drawn on the map.
  - A "fewer transfers" alternative appears when it is really different.
- **User-specific saved stations.** Save and unsave from any station, up to 12 per person. Other users never see your list.
- **Authentication.** Clerk sign-in and sign-up. The signed-in session is what Supabase uses to enforce who can read and write what.
- **Supabase Realtime updates without refreshing.** An open station page receives only the changed rows for its own stations, plus a system heartbeat.
- **Freshness and failure states.** Loading, Live, Delayed (stale), Offline (down), partial (one line's feed is behind), and Reconnecting. See [UX states](#browser-states).
- **Responsive design and appearance settings.** A side panel on desktop; a map strip with a bottom tab bar on phones. Auto / Light / Dark appearance, remembered per browser.
- **Accessibility.** Text contrast of at least 4.98:1 in both themes, status never shown by colour alone, reduced-motion support, keyboard-operable map.

## System architecture

```
  MTA GTFS-Realtime (8 protobuf feeds, no API key)
            │
            │  fetched in parallel every 15 s
            ▼
  Supabase Cron ── pg_cron schedule "15 seconds", pg_net HTTP call
            │
            │  POST + secret header (secret lives in Vault)
            ▼
  Supabase Edge Function  poll-subway  (Deno)
            │  check secret → claim a lease → fetch + decode → build candidate boards
            │
            │  one call:  commit_worker_run(run_id, feeds, boards)
            ▼
  PostgreSQL ── validate → compare with stored boards → write ONLY the changed rows
            │   platform_boards  ·  worker_status (heartbeat)  ·  worker_runs (log)
            │
            │  logical replication (WAL)
            ▼
  Supabase Realtime ── "postgres_changes", filtered by station
            │
            │  websocket
            ▼
  Next.js browser app on Vercel ── patches the open board; countdowns tick locally

  Vercel only serves the app. It is not in the data path: the worker keeps running with no one watching.
```

### What each part does

| Part | Role |
|---|---|
| **MTA feeds** | Eight protobuf feeds (`nyct%2Fgtfs`, `-ace`, `-bdfm`, `-g`, `-jz`, `-l`, `-nqrw`, `-si`) covering every route. Public, no key. |
| **Supabase Cron** | `pg_cron` runs a job every 15 seconds that uses `pg_net` to call the Edge Function. It runs inside the database, not on Vercel. A daily second job prunes old logs. |
| **Edge Function `poll-subway`** | Checks the secret header, claims a run, fetches and decodes all 8 feeds, and builds the next 3 trains per route per platform. It never reads the database back. |
| **PostgreSQL** | `commit_worker_run` validates the data, decides what changed, and writes only those rows, all in one transaction. It records each run and the heartbeat. |
| **Supabase Realtime** | Turns row changes in `platform_boards` and `worker_status` into websocket messages for subscribed browsers. |
| **Next.js on Vercel** | Static and streamed pages. The browser talks to Supabase directly for data and Realtime. |
| **Clerk** | Sign-in. Its session token is sent to Supabase, which verifies it as a third-party identity provider. |

### How changes are detected

A run builds candidate boards, and PostgreSQL compares them with what is stored using one function, `board_changed()`. A board is rewritten **immediately** when its trains' identity or order change, a departure appears or goes, the arriving window (under 60 s) changes, a live prediction turns scheduled or the reverse, the headsign or route changes, or a prediction disappears. Otherwise it is rewritten only when a time moved **30 seconds or more** from the **stored** value. Everything else is skipped.

This matters because every written row is a billed Realtime message. Live runs rewrite roughly 300–480 of 989 boards, not all of them. Comparing inside PostgreSQL also means the worker never reads the table: reading all boards each run would be about 148 GB a month against a 5 GB free allowance, versus about 45 MB with the SQL-side comparison ([benchmark](docs/step3/DATA_FLOW.md#36-benchmark-of-the-postgresql-side-comparison-2026-11-03)).

Other protections, all in `commit_worker_run`:

- **Concurrency.** An atomic lease and `run_id` fencing mean two overlapping runs cannot both write, and a late run cannot overwrite a newer one.
- **Bad input.** Each feed is checked for age, unknown stops and empty results. A broken feed is rejected on its own; its old trains are kept and marked "carried" only from its second bad run in a row.

### How the browser receives updates

The browser subscribes to `platform_boards` filtered to only the stations on screen (`station_id=eq.…` or `in.(…)`), never the whole table, plus the one-row `worker_status` heartbeat. A changed row arrives as a message and React patches that one board. Between messages, countdowns tick on the device from each train's absolute arrival time, corrected by a clock offset measured against the server. Subscriptions pause while the tab is hidden.

### Browser states

Three independent signals are combined, so a quiet worker is never mistaken for a lost connection:

| Signal | Source |
|---|---|
| Worker heartbeat | `worker_status` (a new run within 60 s) |
| Each feed's own freshness | MTA's `header.timestamp` (under 90 s old) |
| The browser's connection | The websocket, confirmed over REST when it goes quiet |

| State | When | Shown as |
|---|---|---|
| Loading | Nothing received yet | Skeleton boards, "Connecting…" |
| Live | A recent run, all needed feeds fresh | `Live · N s ago` in the header |
| Partial | Some of a station's feeds are behind | A warning on just those lines |
| Delayed | No successful run in 60 s | A banner, "times may be out of date" |
| Offline | The worker failed, or all of a station's feeds are down | An alert, with automatic retry |
| Reconnecting | The browser lost its connection | A bar under the header (never shown for a merely quiet worker) |

### Authentication and row-level security

Saved stations live in `public.follows`. Clerk issues the signed-in session token, and the browser sends it to Supabase with every request. Supabase verifies it as a third-party identity provider and gives the request the `authenticated` role, with the Clerk user ID as the token's `sub`. Row-level security then compares that to the row owner:

- Policies: `select`, `insert` and `delete` are allowed only where `(select auth.jwt()) ->> 'sub' = user_id`. There is no `update` grant at all.
- The owner of a new row is taken from the token, so nobody can save a station "as" another person.
- A trigger caps each user at 12 saved stations.
- The signed-out `anon` role has no access to `follows`, and signed-in users cannot call the worker's write functions.
- Tokens last 60 seconds, so the app asks Clerk for a fresh one on every request and never stores one.

## Development process (Steps 1–6)

Each step ended in a Git commit, so the repository shows the real progression. Links go to the commit, the documents and the main files.

| Step | Commit | Main documents and files |
|---|---|---|
| 1. Live data source | [`f517d45`](https://github.com/carsonjyw/assignment_5/commit/f517d45) | [`docs/step1/STEP1_LIVE_SOURCE.md`](docs/step1/STEP1_LIVE_SOURCE.md), [`docs/step1/evidence/`](docs/step1/evidence) |
| 2. Agent access and auth | [`baf5205`](https://github.com/carsonjyw/assignment_5/commit/baf5205) | [`app/layout.tsx`](app/layout.tsx), [`proxy.ts`](proxy.ts), [`AGENTS.md`](AGENTS.md) |
| 3. Data-flow plan | [`dd621f8`](https://github.com/carsonjyw/assignment_5/commit/dd621f8) | [`docs/step3/DATA_FLOW.md`](docs/step3/DATA_FLOW.md) |
| 4. Worker | [`cb3b9eb`](https://github.com/carsonjyw/assignment_5/commit/cb3b9eb), [`b027df6`](https://github.com/carsonjyw/assignment_5/commit/b027df6) | [`supabase/functions/poll-subway/`](supabase/functions/poll-subway), [`supabase/migrations/`](supabase/migrations), [`docs/step4-prep/`](docs/step4-prep) |
| 5. Make the page live | [`6fd3562`](https://github.com/carsonjyw/assignment_5/commit/6fd3562) | [`docs/step5/IMPLEMENTATION.md`](docs/step5/IMPLEMENTATION.md), [`components/`](components), [`lib/headway/`](lib/headway) |
| 6. Deploy and test | *(final commit)* | This README, [`AGENTS.md`](AGENTS.md) |

### Step 1: choose and verify a live data source

**Why MTA GTFS-Realtime.** It is free, needs no API key, covers the entire subway, and publishes per-train arrival predictions that change from minute to minute, which makes it a true live source rather than a page that merely looks live.

**How it was tested.** All 8 feeds were requested directly. They cover every route, including the three shuttles and the Staten Island Railway, and all returned HTTP 200 at about 650 KB total. They are protobuf (served as `text/plain`), so each was decoded with the official GTFS-Realtime schema, and MTA's own NYCT extension was decoded by hand. Of 29 static routes, 27 were running at midday; the other two (`Z`, `FX`) are part-time services.

**Evidence that predictions change.** Two real snapshots, A at 17:29:55 UTC and C at 17:35:21 UTC (5.5 minutes apart), were compared train by train:

| Measure | Count |
|---|---|
| Stops whose predicted time **changed** | 6,507 |
| Stops with the same predicted time | 8,296 |
| New trips / trips gone | 41 / 34 |
| Size of change | −415 s to +486 s, median +5 s |

Most changes were small whole-train shifts of a few seconds; a few were real events, such as an L train delayed 8 minutes. Feeds refresh every 3–15 seconds. The raw bytes change each time, so a byte hash can't show whether arrivals really changed, which is why the worker later compares decoded rows. Full tables are in [`STEP1_LIVE_SOURCE.md`](docs/step1/STEP1_LIVE_SOURCE.md) with [raw comparisons](docs/step1/evidence/compare_A_C.txt).

### Step 2: configure agent access

- **Supabase.** The Supabase MCP server was connected to the HEADWAY project only (project `fddulhtbsrrzepgehdhi`). All database changes, migrations and function deploys go through that connection, and are checked against the project's own advisors.
- **Clerk.** The Clerk CLI was authenticated and linked to one application, `headway`. A Clerk development instance supplies sign-in; Clerk and Supabase were then connected as third-party auth, and verified with real session tokens (Step 4).
- **Vercel and GitHub.** The Next.js app was initialised and the repository connected to GitHub; the Vercel project was created from that repository in Step 6.
- **Secrets.** Keys live only in the local `.env.local` (git-ignored, never committed or printed), in Vercel's environment settings, in Supabase Vault (the worker secret) and in the Edge Function's own secrets. The worker secret is never in code, and the AI agent was told never to read environment files. Only public values are in the repository: the Supabase URL and publishable key, which can do only what row-level security allows.

### Step 3: plan the data flow

[`docs/step3/DATA_FLOW.md`](docs/step3/DATA_FLOW.md) holds the diagram, the database design, the worker plan, the Realtime plan, the UX states, and a benchmark. The schema has 8 tables:

| Table | Purpose |
|---|---|
| `routes`, `stations`, `platforms`, `route_stops` | Static data from MTA, public read |
| `platform_boards` | The live data: the next 3 trains per route per platform. Public read, in Realtime |
| `worker_status` | A single heartbeat row with each feed's health. Public read, in Realtime |
| `worker_runs` | Private run log and lease |
| `follows` | User-owned, row-level security |

Key decisions and trade-offs:

- **Compare in PostgreSQL, not in the worker.** This cut egress from about 148 GB a month to about 45 MB.
- **Write only meaningful changes.** A prediction that moves 5 seconds is noise; one that moves 30 seconds, or changes identity, is news. This keeps Realtime messages inside the free quota.
- **Subscribe per station, never table-wide.** A typical rider gets about 2 board messages per 15-second run.
- **Three separate freshness signals**, so each failure reads honestly.
- **Poll every 15 seconds.** Faster than MTA's own feed refresh would only repeat data.

### Step 4: build and verify the worker

**What was built.** The Edge Function [`poll-subway`](supabase/functions/poll-subway) (a dependency-free protobuf decoder, a board builder, and one-run logic) and 10 migrations, including the static data seeded from MTA's GTFS by [`scripts/generate_static_seed.py`](scripts/generate_static_seed.py). `pg_cron` calls it every 15 seconds through `pg_net`.

**Key mechanisms.** PostgreSQL-side change detection (above), a heartbeat row, a run log, an atomic lease with fencing, per-feed validation, and a 12-station cap on saved stations. A performance fix to the RLS policies (`(select auth.jwt())`) came from Supabase's own advisor.

**Tests.** 11 Deno tests run the worker on saved MTA data and run every migration in an in-memory PostgreSQL (PGlite). Run them with `npm run test:worker`.

**Actual results** (from [`AGENTS.md`](AGENTS.md#verified-live-2026-11-03-19111920-utc)):

| Check | Result |
|---|---|
| Cron cadence | 30 fires, 0 failed; gaps 15.01–15.36 s |
| Worker runs | 33 runs, all `ok`, all 8 feeds healthy every run |
| Run time | Database 439 ms on average (max 652 ms) |
| Changed rows only | 307–485 of 982 boards rewritten per run (about 40%); a run 3.5 s after the last wrote 52 |
| Overlap | Two simultaneous calls gave one `skipped` and one run, with no duplicate writes |
| Auth | Missing, wrong or bearer-only secrets, and GET requests, all returned 401 |
| Secrets in logs | None found |

Benchmarks and failure-mode replays are in [`docs/step4-prep/`](docs/step4-prep).

### Step 5: make the page live

Design, map, planner and states are documented in [`docs/step5/IMPLEMENTATION.md`](docs/step5/IMPLEMENTATION.md), with design alternatives in [`REDESIGN_PROPOSAL.md`](docs/step5/REDESIGN_PROPOSAL.md).

- **Design: NYC-inspired "Wayfinding".** Black signage bands, white panels, and HEADWAY's own route marks (not MTA's artwork). The first design direction was rejected on review and redone.
- **Map.** A review found the first map looked fragmented. The data was fine; the cause was drawing each service pattern as its own line. It was rebuilt as one connected network from the real stations and tracks ([`scripts/build_transit_assets.py`](scripts/build_transit_assets.py)), with a geographic basemap ([`scripts/build_basemap.py`](scripts/build_basemap.py)).
- **Trip planner** ([`lib/headway/planner.ts`](lib/headway/planner.ts)). A shortest-path search over MTA's schedule using median run times and MTA transfer times, labelled "by schedule".
- **Realtime.** [`lib/headway/useStations.ts`](lib/headway/useStations.ts) and [`app/providers.tsx`](app/providers.tsx) subscribe per station and handle the heartbeat.
- **Clerk and saved stations.** [`components/FollowButton.tsx`](components/FollowButton.tsx) saves optimistically, with an undo; a signed-out visitor is sent to sign in and the save completes on return.
- **States.** The six [browser states](#browser-states). A false "Reconnecting" bar (it showed whenever the worker paused) was found in testing and fixed.
- **Accessibility, responsive design and testing.** Contrast measured for every text and background pair; reduced-motion support; desktop and 375 px phone layouts; 24 frontend tests.

### Step 6: deploy and test

- **Vercel deployment.** The project `headway` is connected to this repository, deploys `main`, and serves production at https://headway-one.vercel.app. The environment variables are the Clerk keys and URLs only (see [Local development](#local-development)).
- **Production verification.** On the deployed site: `/`, `/plan`, `/saved`, a station page and the map data files all return HTTP 200. The header's `Live · N s ago` badge reset on every cycle across a 16-second watch with no refresh, and there were no browser console errors and no Reconnecting bar.
- **The worker runs independently of Vercel.** Checked directly in the database after deploying: `poll-subway` is active on `15 seconds` with **20 runs in 5 minutes and 0 failures**. The latest runs (#584–#586) were `ok`, all 8 feeds healthy, 502–641 ms. The schedule lives in Supabase, so it doesn't depend on any deployment.
- **Classmate testing.** See [Real user testing](#real-user-testing).

#### One real update, end to end

Run **#586** (read from the production database, 2026-11-03):

1. **21:43:37.26 UTC, Cron.** `pg_cron` fires `poll-subway` through `pg_net`, with the worker secret from Vault.
2. **Edge Function.** It checks the secret and claims a lease. It fetches the 8 feeds in parallel and decodes them: **4,714 trains**, all 8 feeds healthy, 67 trains rejected by validation. It builds 989 candidate boards.
3. **PostgreSQL.** `commit_worker_run` compares each board with the stored one. **323 of 989** changed, and only those were upserted. One was platform `A50S`, **Rockaway Av southbound**, which now showed a live **C train toward Euclid Av** due at 21:55:05 UTC. It was written at 21:43:37.55, about 0.3 s after the run began. The heartbeat row was updated too. The run took **502 ms**.
4. **Realtime.** The change stream carries each changed row to Supabase Realtime, which sends it only to browsers subscribed to that station.
5. **Browser.** A page open on Rockaway Av receives the row over its websocket and patches that board. A train whose time moved by 30 s or more flashes briefly. Every page also receives the heartbeat, which resets the "Live · N s ago" badge. Between updates, countdowns tick on the device from the absolute arrival time.

Not measured: the delay from the database write to the pixels changing in a specific browser.

## Real user testing

A classmate tested the deployed HEADWAY application. Their feedback was: **"works well"**.

## Testing and verification

| Area | Result | Evidence |
|---|---|---|
| Cron cadence | Verified in Step 4: 30 fires, 0 failed, gaps 15.01–15.36 s. Re-checked after deployment: 20 runs in 5 minutes, 0 failed | [AGENTS.md](AGENTS.md#verified-live-2026-11-03-19111920-utc) |
| Worker execution | 33 live runs, all `ok`, all 8 feeds healthy. 11/11 worker tests pass | [`supabase/functions/tests/`](supabase/functions/tests/poll_subway_test.ts), [benchmark](docs/step3/DATA_FLOW.md#36-benchmark-of-the-postgresql-side-comparison-2026-11-03) |
| Realtime without refresh | On the deployed site, the freshness badge reset every cycle and boards changed with no navigation. Earlier local run: 13 board changes in 35 s | [Step 5 results](docs/step5/IMPLEMENTATION.md) |
| Row-level security | 15/15 live checks with two real Clerk test users: each sees only their own rows, cross-user writes are blocked, signed-out and tampered tokens are rejected, worker functions can't be called by users | [Step 5 results](docs/step5/IMPLEMENTATION.md) |
| Frontend tests | `npm test`: 24/24 (trip planner, freshness logic, map connectivity and alignment, label overlap) | [`tests/`](tests) |
| Lint and types | `npx eslint .` and `tsc --noEmit` report no problems | Run locally (`npx eslint .`) |
| Production build | `npm run build` succeeds | Vercel build for `6fd3562` is READY |
| States | Fresh and Stale (worker paused for about 85 s, then re-enabled) checked in the browser; Reconnecting not shown while the worker is quiet. Down, Partial and Loading are covered by a unit test of the freshness logic (precedence of all six states) | [`tests/headway-core.test.mts`](tests/headway-core.test.mts) |
| Desktop and mobile | Checked at desktop size and at 375×812: no horizontal scroll, map strip and tab bar on phones | [Step 5 results](docs/step5/IMPLEMENTATION.md) |
| Contrast | At least 4.98:1 for all text, both themes | [Step 5 results](docs/step5/IMPLEMENTATION.md) |

The results in the Step 5 rows were measured on the local build against the live backend; the deployed site was checked as described in Step 6.

## Local development

Requirements: Node 20 or newer, and for the worker tests [Deno](https://deno.com).

```bash
git clone https://github.com/carsonjyw/assignment_5.git
cd assignment_5
npm install
npm run dev            # http://localhost:3000
```

```bash
npm test               # planner, freshness logic, map (24 tests)
npm run test:worker    # worker + migrations in in-memory PostgreSQL (11 tests)
npx eslint .
npm run build
```

### Environment variables

Create `.env.local` (git-ignored) or set these in Vercel. Never commit real values.

| Name | Kind | Value |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Public | Clerk publishable key |
| `CLERK_SECRET_KEY` | **Secret** (server only) | Clerk secret key |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | Public | `/sign-in` |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | Public | `/sign-up` |
| `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL` | Public | `/` |
| `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL` | Public | `/` |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public, optional | Defaults for this project are built in ([`lib/supabase/config.ts`](lib/supabase/config.ts)); set them only to use your own Supabase project |

`NEXT_PUBLIC_` values are sent to the browser, so they must be safe to publish. The worker secret is **not** an app variable: it lives in Supabase Vault and in the Edge Function's secrets.

### Backend setup (own project)

1. Apply [`supabase/migrations/`](supabase/migrations) in order. They create the extensions, tables, RLS, worker functions, static data and the Cron schedule.
2. In Supabase, add Clerk under Authentication → Third-party auth.
3. Store the worker secret in Vault (`worker_secret`) and set the same value as the function secret `WORKER_SECRET`.
4. Deploy [`supabase/functions/poll-subway`](supabase/functions/poll-subway) with `verify_jwt` off. It checks the secret header itself.

Static map and planner data are regenerated from MTA's GTFS:

```bash
python3 -I scripts/build_transit_assets.py <gtfs_subway_dir> <Stations.csv> public/data
python3 -I scripts/build_basemap.py <download_dir> public/data/map.json public/data/basemap.json
```

## Limitations and future improvements

- **Scheduled estimates versus live predictions.** The planner's duration is a **schedule estimate**: median scheduled run times plus half the headway as the wait. Only the "next trains" beside each boarding station are live predictions. The two are always labelled differently, and the estimate does not change when a train is late.
- **Service changes and delays.** The planner doesn't know about holidays, planned weekend or overnight service changes, or live delays and reroutes. It plans for "now" only, not a chosen departure time. A stretch with no scheduled service gives "no route" rather than a guess, and Staten Island has no subway link to the rest of the system.
- **Map.** It is a geographic drawing, not a schematic like MTA's own, so dense areas (Midtown and Lower Manhattan) stay crowded until you zoom in. Where bundled lines meet, the colour order can swap sides. The New Jersey shoreline is more generalised than NYC's.
- **Search.** Typo tolerance is trigram-based, so very short words with swapped letters can miss.
- **Clerk development instance.** A Clerk production instance needs a custom domain, and `vercel.app` isn't accepted. Sign-in therefore uses the development instance, with a "Development mode" notice and a 500-user cap.
- **Free-tier budget.** Realtime messages, Edge Function calls and egress are deliberately kept small. A very large audience would need a paid plan.
- **Future improvements.** A chosen departure time; service alerts from MTA's alert feed; accessible-route (elevator) planning; schematic map option; a Clerk production domain.

## Data sources and attribution

HEADWAY is **not an official MTA app or map**. It uses its own route marks and doesn't use MTA logos or the official map.

- **MTA:** real-time and static GTFS (free to use; no implied endorsement).
- **NYC Open Data:** Borough Boundaries and 2020 Neighborhood Tabulation Areas (Department of City Planning); Parks Properties (Department of Parks and Recreation).
- **US Census Bureau:** 2023 Cartographic Boundary counties (public domain).

HEADWAY is a separate project from FERA and shares no code, database or configuration with it.
