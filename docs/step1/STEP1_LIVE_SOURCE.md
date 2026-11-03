# Step 1 — Choose a Live Source: NYC Subway GTFS-Realtime

All numbers below come from real requests made on **Tue 2026-11-03, 17:29–17:35 UTC (12:29–12:35 PM New York time)**.
Raw protobuf responses, decoded snapshots, and the scripts used are in [`evidence/`](evidence/) and [`scripts/`](scripts/).

---

## 1. Endpoints: full-system coverage (verified, not assumed)

Base URL: `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F<feed>`

| Feed path | Routes observed in the live response | HTTP | Size | Trip updates (A) |
|---|---|---|---|---|
| `gtfs` | 1 2 3 4 5 6 **6X** 7 **7X** **GS** (42 St Shuttle) | 200 | 183 KB | 246 |
| `gtfs-ace` | A C E **H** (Rockaway Park Shuttle) | 200 | 107 KB | 117 |
| `gtfs-bdfm` | B D F M **FS** (Franklin Av Shuttle) | 200 | 171 KB | 169 |
| `gtfs-g` | G | 200 | 20 KB | 25 |
| `gtfs-jz` | J (Z not running at midday; see §7) | 200 | 24 KB | 26 |
| `gtfs-l` | L | 200 | 26 KB | 28 |
| `gtfs-nqrw` | N Q R W | 200 | 133 KB | 126 |
| `gtfs-si` | **SI** (Staten Island Railway) | 200 | 5 KB | 6 |

**These 8 feeds cover the whole system**, including all three shuttles and SIR. Of the 29 routes in static `routes.txt`, 27 appeared live across the three rounds, each in exactly one feed. The other two are part-time services that weren't running at 12:30 PM: `Z` (rush hours, expected in `gtfs-jz`) and `FX` (Brooklyn F express, expected in `gtfs-bdfm`).
Shuttle placement is not obvious: GS is in `gtfs`, FS is in `gtfs-bdfm`, and H is in `gtfs-ace`.

**Authentication: none.** Every request was a plain `GET` with no API key or headers, and all returned `200`.
Responses come through CloudFront (`x-cache: Miss from cloudfront`) with `content-type: text/plain`, even though the body is binary protobuf. One fetch of all 8 feeds totals about 650 KB and takes about 0.1 s per feed. SIR was the slowest feed once, at 1.1 s.

---

## 2. The real API calls

The script decodes each response with the official GTFS-Realtime schema (`gtfs-realtime-bindings`). It also decodes MTA's NYCT extension (field 1001: `train_id`, `is_assigned`, `direction`, tracks) by hand.

| Round | Request time (UTC) | Feed timestamps (per feed) | Total trips | Purpose |
|---|---|---|---|---|
| **A** | 17:29:55 | 17:29:47 – 17:29:55 (1–9 s old) | 743 | baseline |
| B | 17:30:57 | 17:30:51 – 17:30:57 (1–7 s old) | 746 | +1 min (intermediate) |
| **C** | 17:35:21 | 17:35:12 – 17:35:22 (0–11 s old) | 750 | **+5.5 min: the main comparison** |

> Round B ran only ~1 minute after A, too soon for the assignment's "a few minutes apart". I kept it as a 1-minute data point and ran round C 5.5 minutes after A, so **A vs C** is the required comparison.

### One decoded record (round A, real)
```
entity_id   000001
trip_id     068500_1..S15R      route_id 1     start_date 20261103
NYCT ext    train_id "01 1125  242/SFT"  is_assigned true  direction SOUTH
stop_time_update: stop_id 142S (South Ferry)  arrival 1793727091  sched_track 1  actual_track 1
```

### Measured refresh cadence
I polled `gtfs`, `gtfs-l`, and `gtfs-si` every ~4 s for 65 s. Each feed's `header.timestamp` advanced every **3–15 s**: `gtfs` usually every 3–6 s, `gtfs-l` about every 5–15 s.
The raw bytes changed every time the timestamp did, so **a byte hash cannot tell you whether arrivals changed**. You have to diff the decoded rows.

---

## 3. What changed: A (17:29:55) → C (17:35:21), matched by `(trip_id, stop_id)`

| Measure | Count |
|---|---|
| Trips in both rounds | 709 |
| New trips (entered the feed) | 41 |
| Trips gone (finished or dropped) | 34 |
| `(trip, stop)` pairs with the **same** predicted time | 8,296 |
| `(trip, stop)` pairs whose **predicted time changed** | 6,507 |
| Stops dropped from a trip still running (train passed them) | 986 |
| Change size | min **−415 s**, median **+5 s**, max **+486 s**; 3,536 later / 2,971 earlier |

### Changes in the prediction vs. passage of time

Two different things move:

* **The prediction** is the absolute `arrival.time` epoch. It changes only when MTA revises its estimate.
* **"Minutes until"** is `arrival.time − now`. It shrinks every second even when the prediction doesn't change.

Real rows at **Times Sq–42 St, downtown platform (`127S`)** and elsewhere:

| Trip | Stop | Arrival @A (17:29:55) | Arrival @B (17:30:57) | Arrival @C (17:35:21) | What actually happened |
|---|---|---|---|---|---|
| `071500_1..S15R` (1) | 127S | 17:38:27 (8.5 min) | 17:38:40 (7.7 min) | **17:38:40** (3.3 min) | Prediction +13 s A→B, then **unchanged** B→C; the countdown fell 4.4 min from passage of time alone |
| `073350_3..S06R` (3) | 127S | 17:36:02 (6.1 min) | 17:34:51 (3.9 min) | 17:34:12 (70 s ago) | Prediction moved **−71 s** then **−39 s** (train running early); still listed after its predicted time |
| `070900_1..S15R` (1) | 127S | 17:33:31 | 17:33:58 | 17:34:07 (75 s ago) | Prediction +27 s, then +9 s; still listed after its time |
| `072350_L..N` (L) | L03N 14 St–Union Sq | 17:38:15 | **17:46:21** | 17:46:21 | **+486 s (8 min) delay** inserted between A and B, then unchanged |
| `075600_7..S` (7) | 702S Mets–Willets Pt | 17:38:10 | 17:38:10 | **17:31:15** | **−415 s** revision; the new time was already in the past when published |
| `072600_7..S` (7) | 719S Court Sq | 17:35:13 | 17:32:15 | *(not listed)* | −178 s revision, then the stop dropped off because the train passed it |
| `071950_3..N01R` (3) | 127N … 120N | 17:46:29 … | | 17:46:34 … | **+5 s on every downstream stop**, a typical small whole-trip shift |

Full outputs: [`evidence/compare_A_C.txt`](evidence/compare_A_C.txt), [`evidence/compare_A_B.txt`](evidence/compare_A_B.txt).

**What this shows about how predictions change**
* Most changes are small whole-trip shifts of a few seconds; the A→B median was +1 s. These are jitter, not news.
* A minority are real events, like the L train's +8 min or the 7 train's −7 min. These are what users care about.
* After a train passes a stop, that stop is **removed** from the trip. Sometimes a stop **lingers past its predicted time** (−70 s, −75 s, −247 s above), so the app must hide or relabel arrivals that are already past.
* About 40% of trips are `is_assigned = false`. These are scheduled departures from terminals with no train attached yet, so their times are the schedule, not a live prediction.

---

## 4. The fields, explained

| Field | Where | Meaning | Changes how often | App needs it? |
|---|---|---|---|---|
| `header.timestamp` | FeedHeader | When MTA generated this feed snapshot (POSIX seconds) | Every 3–15 s | **Yes**: freshness, and skipping unchanged feeds |
| `header.gtfs_realtime_version` | FeedHeader | Always `1.0` | Never | No |
| `trip_id` | TripDescriptor | e.g. `068500_1..S15R` = origin time in 1/100 min after midnight (`068500` → 11:25), route `1`, direction `S`, shape/variant `15R`. It matches the end of the static trip_id `AFA26GEN-1095-Weekday-00_068500_1..S15R` | Stable for a trip's life | **Yes**: row key |
| `start_date` | TripDescriptor | Service date `YYYYMMDD` | Daily | **Yes**: makes the key unique across days |
| `route_id` | TripDescriptor | `1`…`7`, `6X`, `7X`, `A`…`W`, `GS`, `FS`, `H`, `SI` | Stable | **Yes**: bullet, color, filter |
| `stop_id` | StopTimeUpdate | Platform-direction ID: parent station (`127`) + `N`/`S`. It joins to static `stops.txt` | Stable | **Yes**: which board |
| `arrival.time` / `departure.time` | StopTimeUpdate | Predicted epoch seconds. The origin stop often has only `departure` (105 rows had no arrival); the last stop has only `arrival` | Revised on many polls (44% of pairs moved within 5.5 min) | **Yes**: use `arrival ?? departure` |
| Direction | Stop suffix `N`/`S`; trip_id `..N`/`..S`; NYCT ext `direction` | `N`/`S` = "north"/"south" in railroad terms, not compass directions. Human labels ("Uptown & The Bronx", "Downtown & Brooklyn") come from `Stations.csv` | Stable | **Yes**. Use the **stop suffix**: the NYCT `direction` field was missing on ~370 of 750 trips, while the suffix was always present and never disagreed |
| `train_id`, `is_assigned` | NYCT extension | Train's internal ID; whether a real train is assigned | Stable | `is_assigned` is useful for a "scheduled" vs "live" label |
| `scheduled_track` / `actual_track` | NYCT extension | Track numbers | Occasionally | No (nice-to-have) |
| `vehicle` entities | VehiclePosition | Current stop + `IN_TRANSIT_TO`/`STOPPED_AT`; no GPS lat/lon | Each poll | Not for v1 |
| `alert` entities | Alert | Only "Train delayed" text (1 in `gtfs`) | Rare | No. MTA publishes real service alerts in a separate feed |

### Minutes until the next train
```
eta            = arrival.time ?? departure.time            // absolute epoch, stored in DB
secondsAway    = eta − now()                                // computed in the browser, ticking every second
skip if secondsAway < −30   (stale "lingering" stop, see §3)
show "Arriving"  if secondsAway < 60
else show floor(secondsAway / 60) + " min"
next train     = min over all trips of eta at this platform stop_id, after the filter above
```
The database stores the **absolute** time and the browser computes the countdown. The countdown then moves every second with no database writes or Realtime messages. A write only happens when MTA changes the prediction.

---

## 5. Combining 8 feeds without duplicating trains or stations

* **Trains:** across all 743 trips in round A, **no `trip_id` appeared twice**, either within a feed or across feeds. Each physical train lives in exactly one feed. Key: `(start_date, trip_id)`.
* **Stations:** a station is shared, not a train. **61 parent stations appear in more than one feed.** For example, `A15` (125 St) appears in both ACE and BDFM, and `A42` (Hoyt–Schermerhorn) in both ACE and G. The board for a platform `stop_id` is the **merge of trains from every feed**, so 125 St southbound shows A, B, C, and D together.
* **Complexes:** one "station" to a rider can be several GTFS stations. Times Sq complex `611` = `127` (1 2 3) + `725` (7) + `902` (S) + `R16` (N Q R W) + `A27` (A C E, Port Authority). `Stations.csv` provides `Complex ID` (496 stations → 445 complexes). Users follow a complex; the page groups its platforms by direction.
* **Processing order:** fetch all 8 feeds in parallel, flatten them into `(stop_id → trips)`, then build boards. A feed that fails keeps its previous rows instead of wiping its trains.

## 6. Static GTFS mapping

| File | Source (verified 200) | Use |
|---|---|---|
| `stops.txt` | `rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip` (5.6 MB, version `20261028-fall-2026-pick-with-long-term-supplements`) | 496 parent stations + 992 `N`/`S` platform stops, with names and lat/lon. **Includes SIR (`S09`…`S31`).** |
| `routes.txt` | same | 29 routes with `route_color` and `route_text_color` for bullets |
| `trips.txt` | same | `trip_headsign` (e.g. "South Ferry") via the trip_id suffix match. Simpler alternative: the name of the last stop in the trip update |
| `Stations.csv` | `web.mta.info/developers/data/nyct/subway/Stations.csv` | `Complex ID`, borough, `North/South Direction Label`, ADA |

Load these once as seed data. They change a few times a year with each schedule "pick".
`gtfs_si.zip` is Staten Island **buses**, not SIR, so it isn't needed.

**Unmapped stop IDs:** 128 of 15,963 stop updates (**0.8%**) used IDs missing from both the regular and supplemented static GTFS (`R60`, `R65`, `X22`, `H19`, `A29`, …). They sit mid-trip between real stations, so they look like non-public timing points. The worker should skip them and count them in the run log.

---

## 7. Feasibility, limits, and risks

**Freshness and reliability**
* Feeds were 0–11 s old at request time, and all 8 returned 200 on every request (~80 requests total).
* Predictions are noisy (±1–5 s), can lurch by minutes, can be **in the past**, and unassigned trips are only the schedule.
* `Z` was absent at midday. It runs only in rush hours, so that's expected, but I haven't confirmed it appears during a rush hour. Same for 5X/FX-style variants that weren't running at this time.

**API limitations**
* There is no API key and I found no published rate limit. Don't count on that: a cap or key requirement could appear. Fetch each feed once per run, never per user.
* The format is protobuf plus a custom NYCT extension. Standard decoders ignore the extension, which is fine because the app doesn't need it.
* The payload is about 650 KB per full fetch. At one fetch every 15 s that's ~3.7 GB a month of *inbound* traffic to the Edge Function. Inbound traffic isn't Supabase egress, but it's worth knowing.

**Supabase limits (from Supabase docs today, plus the assignment PDF)**

| Limit (Free) | Value | Our use |
|---|---|---|
| Edge Function invocations | 500,000 / month | **One invocation fetches all 8 feeds.** Every 10 s = 259,200 (52%); **15 s = 172,800 (35%)**; 30 s = 86,400 (17%) |
| Edge Function CPU time | 2 s per request | JS protobuf decode of all 8 feeds measured **5–13 ms** in Node (`gtfs-realtime-bindings`). Not a problem |
| Wall clock | 150 s | ~1 s used |
| Realtime messages | 2,000,000 / month | Each DB change counts **once per client listening to it** |
| Realtime throughput | 100 messages/s, 200 connections | A client subscribed to *every* board could get hundreds of messages per run and be throttled. Clients must filter |

**Protobuf in an Edge Function (Deno):** `npm:gtfs-realtime-bindings` (protobufjs) works through Deno's npm support. Decoding is a few milliseconds. Confirmed in Node; not yet run on Deno.

**Polling all feeds every 10–30 s:** feasible. Recommendation: **every 15 s**. The feeds refresh every ~5 s, but ETAs are shown in minutes, and 15 s leaves 65% of the invocation quota spare for testing and manual runs. Per the PDF, 10 s also fits.

### How many writes? (measured from real data)

| Strategy | Rows written per run |
|---|---|
| Naive: upsert every `(trip, stop)` row | **~15,800 every run**. That would burn the Realtime quota in hours |
| Upsert only `(trip, stop)` rows that changed at all | 5,494 per minute (A→B). Mostly ±1 s jitter |
| …only if changed by ≥ 60 s | 915 per minute (A→B) |
| **Recommended: one row per platform "board" (next 3 trains)** | 975 boards in total. Over 1 min: 822 changed at all, **607 with a ≥ 30 s threshold** |

So a 15 s poll, with board rows and a 30 s threshold, should write roughly **100–150 rows per run** (prorated from the 607 per minute measured; not yet measured at 15 s spacing).

---

## 8. Recommended architecture (proposal only, nothing built)

```
MTA (8 feeds) ──every 15 s── Edge Function `poll-subway` ──upsert changed boards── Postgres ──Realtime (filtered)── Next.js page
                              │                                     │
                              └── fetch 8 feeds in parallel          ├─ feed_status (8 rows: last header.timestamp, ok/error)
                                  skip a feed if header.timestamp    ├─ platform_boards (≈992 rows, one per stop_id N/S)
                                  hasn't moved                       ├─ worker_runs (one row per run: time, ok, rows_changed, per-feed errors)
                                                                     └─ stations / routes (static seed) + follows (per user, RLS)
```

**Changed-records-only strategy**
1. **Skip unchanged feeds:** compare each feed's `header.timestamp` with `feed_status`. If it's the same, don't process that feed.
2. **Materialize boards, not raw stop updates:** for each platform `stop_id`, keep the next 3 trains as `[{route, trip_id, eta, headsign, assigned}]`.
3. **Compare against what was last *written*, not the last poll:** write a board only if its train list changed (a train arrived, left, or entered the top 3) or any ETA moved ≥ 30 s from the **stored** value. Small drift adds up until it crosses the threshold and gets written, so nothing is lost.
4. **One batched upsert** of only the changed boards, then one `worker_runs` row.
5. **Countdowns tick in the browser** from the stored absolute times, with zero Realtime traffic.

**Limiting Realtime messages**
* Clients subscribe only to their followed platforms, with a filter `stop_id=in.(127N,127S,…)` (max 100 values), never to the whole table.
* Estimate: about 150 changed boards per run, and a user following 3 stations (6 platforms of 992), gives **~1 message per run per open tab**. That's ~5–6k messages per tab per day, so the 2M/month quota covers hundreds of tab-days. Fine for classmates.
* Scale path if needed: database-triggered **Broadcast** to a topic per platform (`platform:127S`), so messages go only to subscribers of that platform.

**Page states** (required by the PDF), driven by `worker_runs` and `feed_status`:
* **Loading**
* **Fresh:** last successful run < 45 s ago
* **Stale:** more than 3 missed runs, i.e. > 60 s
* **Down:** the last run failed
* **Feed-level warning:** one line's feed failed while the others are fine

---

## 9. Recommended initial scope for today's deadline

**Full system coverage stays**: all 8 feeds, every route including the shuttles and SIR. The scope is reduced in *features*, not lines:

* ✅ All 8 feeds, one worker, every 15 s, changed-boards-only writes, `worker_runs` log
* ✅ Static seed: stations/complexes, platforms, routes (colors), direction labels
* ✅ Sign in (Clerk), search and follow stations (RLS on follows), live board per followed station: route bullet, headsign, minutes, "scheduled" tag when unassigned
* ✅ Freshness indicator + loading/fresh/stale/down states
* ✅ Test: run the worker's parse/diff logic on the saved `evidence/raw/*.pb` files
* ⏭️ Later: service alerts feed, vehicle positions/map, track numbers, historical delay stats, Broadcast

---

## 10. Name ideas

| Name | Why |
|---|---|
| **Headway** ⭐ | The transit term for the gap between trains, which is exactly what the app shows. Short, neutral, and not MTA branding |
| **Next Stop** | Plain and instantly understood |
| **Stand Clear** | A nod to the subway door chime without copying MTA branding |
| **Platform** | What you're standing on while you check it |
| **Dwell** | The rail term for time stopped at a station; calm and minimal |
| **Countdown NYC** | Literal: the app is a countdown clock |
| **Uptown / Downtown** | A playful way to choose your direction |

*(Avoid "MTA", the official bullet artwork, or "Subway Time" as the name, since those suggest an official MTA product.)*
