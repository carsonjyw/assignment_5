# Step 5: Wayfinding implementation and verification

Verified on 2026-11-03 against the live Supabase project (`fddulhtbsrrzepgehdhi`), with the Cron worker running. The backend from Step 4 (tables, RLS, worker, Cron) is unchanged. The only database addition is `20261103193011_station_search.sql`, which adds the read-only `search_stations` and `server_now` RPCs.

## What was built

| Area | Files |
|---|---|
| Shell, nav (Explore · Plan · Saved), tokens | `app/layout.tsx`, `app/globals.css`, `components/Nav.tsx` |
| Live data and freshness | `app/providers.tsx`, `lib/headway/core.ts`, `lib/headway/useStations.ts`, `components/Status.tsx` |
| Explore / Station / Line / Saved | `app/(explore)/**`, `components/panels.tsx`, `components/StationView.tsx`, `components/TrainRow.tsx`, `components/FollowButton.tsx`, `components/StationSearch.tsx`, `components/RouteMark.tsx` |
| Interactive map (P1) | `components/map/SubwayMap.tsx`, `components/map/MapContext.tsx`, `public/data/map.json` |
| Trip planner (P2) | `lib/headway/planner.ts`, `components/PlanPanel.tsx`, `public/data/plan.json` |
| Asset generator | `scripts/build_transit_assets.py` |
| Tests | `tests/planner.test.mts`, `tests/headway-core.test.mts` |

## Automated results

| Check | Result |
|---|---|
| `npx eslint .` | 0 problems |
| `npx tsc --noEmit` | 0 errors |
| `npm test` (planner + core) | 15/15 pass |
| `deno task test` (worker) | 11/11 pass |
| `npm run build` | Success. All routes are Partial Prerender. |
| Live RLS (`follows`, two real Clerk test users) | 15/15 pass. Users see only their own rows. Cross-user insert gets 403; cross-user delete removes 0 rows. Anon read and insert get 401. A tampered token gets 401. Signed-in users can't call worker functions or write boards (403). |

## Browser verification (built-in browser, dev server)

### Navigation and Explore
- **Navigation:** Explore, Plan and Saved all render, and the active tab is marked with `aria-current`. Signed-out Saved shows "Sign in to save stations"; Explore and Plan work without an account.
- **Search:** "jamacia" finds the three Jamaica stations, and "union sq" finds 14 St–Union Sq. A short word with swapped letters ("unoin") doesn't match (see the limitations section).

### Map
- **Map:** 134 route paths and 445 stations come from MTA GTFS.
  - Drag pans and the wheel zooms (the transform changes).
  - Tapping 125 St opens `/station/153`, and the map centres on it.
  - `/line/L` highlights the L and dims the other lines.
- **Station:** live boards for every platform, LIVE / SCHEDULED in words plus outlined marks, and a countdown. The "updated N s ago" counter resets every ~15 s without a refresh.

### Planner
- **Transfer trip:** `/plan?from=153&to=602` (125 St → 14 St–Union Sq):
  - A downtown, 4 stops to 14 St, about 15 min.
  - Transfer at 14 St to the L ("MTA allows about 2 min").
  - L to 14 St–Union Sq, 2 stops.
  - Total "About 26 min · by schedule · Weekday midday timetable". Each boarding shows the live next trains. The route is drawn on the map.
- **Direct trip:** `/plan?from=1&to=617` (Astoria–Ditmars Blvd → Atlantic Av–Barclays Ctr): one N leg, 15 stops, about 46 min, no transfers.

### States
- **Fresh, no false Reconnecting:** watched for 40 s; the Reconnecting bar never appeared.
- **Stale:** paused the `poll-subway` Cron job for about 85 s, then re-enabled it.
  - The bar still never appeared.
  - After 60 s the status changed to "Last updated 1 min ago, times may be off".
  - Once Cron was back on, the page returned to "Live · 1 s ago".
- **Responsive:** at 375 × 812, the page doesn't scroll sideways (`scrollWidth` 375). The bottom tab bar and the map strip both show.
- **Night theme:** the dark scheme renders the shell dark, and boards stay on light panels.

### Contrast and motion
- **Contrast (WCAG):** text tokens measure from 6.2:1 to 19.3:1, Day and Night. Status colours on the black sign use light variants. The single failing pair (plan error text on the Night page background) was fixed by putting it in the tinted alert box. Route-mark ink is chosen for maximum contrast. Status never depends on colour alone: there's always a word, an icon and a mark style.
- **Reduced motion:** with `prefers-reduced-motion: reduce`, every animation class (flash, enter, slide-in, ping, map-draw, press) is switched off, and the map jumps instead of flying.

## False Reconnecting fix
There were three causes:
1. The initial "connecting" phase counted as unhealthy, so the bar flashed on every load.
2. A removed channel's late `CLOSED` callback could overwrite a newer `SUBSCRIBED`.
3. On returning to the tab, the old heartbeat time read as silence.

The fixes:
- A new connection gets a 10 s grace period.
- Callbacks from a torn-down channel are ignored.
- Hiding the tab resets the connection state.
- A quiet socket is confirmed over REST: `last_run_id` isn't newer than what the socket delivered.

## Known limitations
- **Planner estimates are scheduled, not live:** median run times, half the headway as the wait, and MTA minimum transfer times. They don't include holidays, planned weekend or night service changes, or live delays. The UI says this under every plan.
- **Time bands:** the planner uses one timetable per service (Weekday / Saturday / Sunday) × band. It doesn't plan for a future departure time.
- **Search:** typo tolerance is trigram-based. Short words with swapped letters may not match.
- **Map:** a geographic drawing of GTFS shapes, with no streets basemap. Labels can crowd at mid zoom in Midtown.
- **Not re-run in the browser:** save and unsave while signed in. Signing in would mean entering credentials on Clerk's hosted service. Follow and unfollow behaviour and RLS were verified live through the API with real Clerk test-user sessions (above), and the UI logic is the same as in Step 4.

---

# Refinement pass (review feedback, 2026-11-03)

## 1. Map connectivity and accuracy

**Diagnosis.** The geometry itself was complete and accurate: all 261 GTFS shapes are present, every trip references one, and the shapes render in the right places. The fragmented look came from how they were turned into lines:
- **Per-pattern drawing:** each of the 134 service patterns was drawn as its own polyline. Where routes share a trunk, colours overwrote each other piece by piece.
- **Express chords:** express patterns cut straight across local stations, with no shared topology.
- **Short-turn patterns** ended mid-line.
- **No transfer links:** nothing showed that stations were connected.

**Fix (still MTA data only).** `scripts/build_transit_assets.py` now builds a track network:
- **Segments:** each shape is cut at the stations its fullest trip serves, giving one segment per pair of adjacent stations. Each segment carries every route that runs over it: 506 segments, of which 111 carry 2 trunk colours and 12 carry 3.
- **Express hops** are split at the stations the train physically passes. A station counts when:
  - it is within 30 m of the track;
  - it is on a parallel line;
  - it is not part of either end's complex;
  - its own neighbour also lies on the hop.
- **Audit:** the first version of this rule produced false splits at crossing lines (e.g. the 4/5 "passing" Lexington Av/63 St) and at other platforms of the hop's own complex. These were found with `AUDIT_SPLITS=1` and removed.
- **Remaining cross-trunk splits are physically real:** the B express passes the Q-local stations on the four-track Brighton line, and the 4/5 run express past Hoyt St in the shared Fulton St tunnel.
- **Drawing:** shared track is drawn once, with routes bundled side by side by trunk colour. Bundles are drawn in railroad-north order, so the line order stays consistent along a corridor.
- **Transfers:** interchanges use connectors along the shortest links (a spanning tree) between the complex's real station positions.
- `plan.json` is byte-identical to before; the planner is unaffected.

**Labels and framing:**
- **Collision handling:** labels are placed greedily per zoom step, trying right, left, above and below each station.
- **Same-name stations:** a label is skipped when another with the same name was placed within 150 px ("23 St", "86 St"); this rule is off when zoomed far in.
- **Density by zoom:** major hubs appear first, then interchanges, then every station.
- **Selection:** the selected station and the journey's ends are always labelled, on a black station-sign plate.
- **Default view:** Manhattan, the South Bronx, western Queens and Brooklyn. It re-fits on resize until the user moves the map, and fitted views keep clear of the zoom controls.
- **Highlighting:** a selected line or journey is drawn thick with a casing on top of a uniformly greyed network. A journey's legs follow the real track (from `hops`) with a zoom-independent draw-on animation.

## 2. Geographic basemap

`scripts/build_basemap.py` builds `public/data/basemap.json` (180 KB) in the **same projection**, read from `map.json` → `proj`.

| Layer | Source | Licence / terms |
|---|---|---|
| Borough land (water excluded) | NYC Dept. of City Planning, Borough Boundaries (`gthc-hcne`) | NYC Open Data terms of use (free, attribution) |
| Parks (19 large parks) | NYC Parks, Parks Properties (`enfh-gkve`) | NYC Open Data terms of use |
| Neighbourhood label positions | NYC DCP 2020 NTAs (`9nt8-h7nd`): centroids of the named areas | NYC Open Data terms of use |
| NJ / Nassau / Westchester land | US Census Bureau, 2023 Cartographic Boundary counties, 1:500k | US Government work, public domain |

- **Water:** water is simply "not land", so the Hudson, East River and Harlem River come straight from the shorelines.
- **Water labels:** placed at the middle of the widest water found by scanning those shorelines, and rotated along the river.
- **Borough labels:** placed at each landmass's centroid. MANHATTAN is rotated along the island and sits over Central Park.
- **Hierarchy:** quiet land, water and park colours sit below the vivid network, which sits below the strongest selection emphasis.
- **Label density by zoom:**
  - boroughs at low zoom;
  - major neighbourhoods (Midtown, Harlem, Astoria, Williamsburg, Flushing …) from k ≈ 1.35, the rest from k ≈ 2.4;
  - big parks from k ≈ 2.2.
- **Attribution** is shown on the map: "Not an official MTA map · Lines: MTA GTFS · Land & parks: NYC Open Data, US Census", with the full credit in its tooltip.

## 3–5. Status, station hierarchy, actions, visual design

- **One freshness indicator:** the header badge. It is now visible at every width, gives an icon and words in every state (Live · N s ago / Delayed · N min ago / Offline), and announces changes to screen readers. Station panels and Saved cards no longer repeat it.
- **LIVE / SCHEDULED** stays on every train. Feed-specific warnings ("Live data for N, Q, R, W is delayed"), a stale banner, and the Down alert appear only where relevant.
- **Station sign:**
  - the name scales with its length (30 / 25 / 22 px, smaller on phones);
  - route marks and the borough share one row;
  - "Plan a trip from here · to here" is a quiet text row;
  - Save is the one solid primary button, and its messages float without shifting the layout.
- **Line filter:** a single scrolling row of marks with an underline for the selection, instead of wrapping pills.
- **Measured:** the first arrival now starts at ~262 px on desktop (was ~390), and on a 375×812 phone at 653 px (was 737).
- **Design:**
  - a fine white pinstripe on the black sign bands (a signage nod, not MTA artwork), and a matching wordmark;
  - a warm paper rail behind white arrival cards;
  - lines grouped by trunk colour, from GTFS `route_color`, with trunk captions;
  - a compact Plan header with the swap button on the seam between the two fields;
  - tighter train rows.

## Verification (refinement)

| Check | Result |
|---|---|
| Map vs GTFS | Per-route connectivity test: every one of the 29 routes is a single connected network. All 445 stations fall inside the land polygons; Times Sq is in Manhattan, Coney Island in Brooklyn, St George on Staten Island. |
| Transfers | Times Sq draws 5 real member stations joined by connectors; the express-split audit is in the build script (`AUDIT_SPLITS=1`). |
| Zoom levels | Whole system (k≈0.66): boroughs, NJ and Westchester, connected network, only major interchanges marked. Overview (k≈1.5): neighbourhoods, Hudson River. Street level (k≈5–6): every station, bundles, transfer pills, parks. |
| Stations | 163 St–Amsterdam Av (2 lines) and Times Sq–42 St (13 routes, 5 stations), desktop and mobile. |
| Explore / Plan / Saved | Search; line highlight; tap a station on the map; Plan 125 St → Union Sq (A + L) and Astoria → Atlantic Av (N); pick an origin on the map (also fixed an update loop in pick mode); Saved signed out. |
| Realtime | Times Sq for 35 s: the badge reset every ~15 s, the board's rows changed 13 times, no Reconnecting, no repeated status in the panel. |
| Contrast | All text pairs ≥ 4.98:1, Day and Night, including area, water and park labels. Dimmed network vs the grey L line 3.0:1 (Day), 3.4:1 (Night). |
| Motion | All map and panel animations are off under reduced motion; the fly-to jumps instead, and also lands if frames are throttled. |
| Automated | `npx eslint .` clean · `tsc` clean · `npm test` 24/24 · `deno task test` 11/11 · `npm run build` OK |

## Remaining limitations (refinement)

- **Bundle order:** lines in a bundle keep railroad-north order with a fixed colour order. Where a corridor bends or a line joins, colours can swap sides at a station. Real map tools optimise this; we don't.
- **Geographic, not schematic:** Midtown and Lower Manhattan stay dense at the overview zoom, so labels there appear only as you zoom in.
- **Basemap resolution:** neighbouring counties come from the Census 1:500k file, so the NJ shoreline is more generalised than NYC's.
- **No streets:** deliberately left out.
- **Browser checks in a hidden pane:** the in-app browser pane was hidden during this pass, so animation frames and CSS animations were throttled. Visual checks used an injected `animation: none` style; animations themselves were last observed running in the earlier pass.
