# HEADWAY redesign — "New York in Motion"

**Status: proposal awaiting approval. Nothing here is implemented.** The backend (worker, Cron, database, Realtime, Clerk, RLS) is unchanged.
**Mockups:** open [`mockups/index.html`](mockups/index.html) in a browser. Add `#d1`, `#d2`, or `#d3` to the URL to show one direction.

**Every mockup is drawn from real data:**
* The map is MTA's own route geometry (`shapes.txt`, 134 line patterns, simplified) plus HEADWAY's 445 station locations.
* Arrival times are a live snapshot from HEADWAY's database.
* The Plan screen's journey was **computed** from MTA's weekday schedule and `transfers.txt` (§5), not drawn by hand.
* Route marks are HEADWAY's own shapes and type in each line's colour, not MTA artwork (§4.4).

---

## 1. Three directions

### 1 · Wayfinding: "the sign is the interface" *(recommended)*
* **Concept:** the confidence of subway wayfinding. Black sign bands, white type, arrows, and line marks lined up like a platform sign, around a luminous map of the real network.
* **Personality:** bold, direct, nocturnal, unmistakably New York, without copying any MTA artefact.
* **Typography:** *Inter Tight* (800–900) for signs and countdown numerals; tabular figures for times.
* **Colour:** near-black `#0d0e10` chrome; off-white `#f4f4f2` arrival panels; line colours only on route marks and map lines; one signal green for "Live". A **Day mode** (white surfaces, black sign bands) follows the system setting for sunlight on elevated platforms.
* **Composition:**
  * **Desktop:** the map fills the canvas, with a right-hand rail holding search, a line picker (all 24 marks), and the selected station's live board.
  * **Mobile:** a station "sign" header, line filter chips, one arrival panel per line group and direction, and a labelled tab bar.
* **Map:** central. Select a line and it thickens while the rest dims. A selected station pulses once, then its board opens in the rail (desktop) or as a sheet (mobile).
* **Live arrivals:** huge numerals (`2 min`, `Now`) with the destination and an explicit **LIVE / SCHEDULED** word under every row. Scheduled rows drop to regular weight.
* **Plan and Saved:**
  * Plan stacks the journey as sign-like legs (line mark → transfer → line mark) and draws the route on the map.
  * Saved is your followed stations as compact sign panels.
* **Distinctive because:** it uses the city's own visual grammar (signage) instead of decoration. Contrast is built in: white on near-black is about 18:1, and black on off-white about 17:1.
* **Weaknesses:**
  * Dark-first needs a real Day mode, not an afterthought.
  * A dense map needs careful label collision handling.
  * Grey line marks (L, shuttles) carry only their large letter, which passes AA for large text (≥ 3:1). Small text is never placed on line colours.

### 2 · Front Page: "a broadsheet of live arrivals"
* **Concept:** New York editorial culture, set as a newspaper front page: masthead, column rules, a headline about the trains, timetable tables, and the map as "Fig. 1".
* **Typography and colour:** *DM Serif Display* headlines with *IBM Plex Sans Condensed*; crisp white paper (not warm), black ink, one red kicker colour.
* **Map:** a figure plate beside the arrivals column, more illustration than tool.
* **Live arrivals:** typeset table rows; times in serif numerals.
* **Distinctive because:** very literate and elegant, unlike any transit app.
* **Weaknesses:**
  * Serif numerals at a glance are weaker than heavy grotesk.
  * Editorial headlines have to be generated from data, which risks sounding like claims ("running every few minutes") that need careful wording.
  * The map is secondary, against your map-first goal.
  * Dense columns don't translate naturally to mobile.

### 3 · Signal Blocks: "the line is the colour field"
* **Concept:** urban modernism. Each direction's next train becomes a full-bleed band in its line's colour with a giant numeral (*Archivo* Expanded, 900).
* **Map:** a light concrete-grey map with thick lines and white station dots, next to a rail of line rows.
* **Live arrivals:** one band per direction ("2 min · L to Canarsie · Live, then 7, 12"). Extremely glanceable.
* **Distinctive because:** loud, joyful, poster-like.
* **Weaknesses:**
  * **It fails your instructor's lesson by construction.** Text sits on 24 different line colours. White on the L's grey `#7C858C` is about 3.6:1, which fails AA for small text. Fixing it means overriding MTA text colours per line, or adding dark scrims, which weakens the concept.
  * Only the *first* train of each direction gets the band, so every other train is secondary.
  * Full-colour bands at a 7-line station like Union Sq become a rainbow stack.

### Comparison
| | 1 Wayfinding | 2 Front Page | 3 Signal Blocks |
|---|---|---|---|
| NYC identity | Signage grammar, strongest | Editorial, literate | Poster, energetic |
| Map-first | **Yes** | No (figure) | Partly |
| Glanceable times | **Excellent** (heavy numerals) | Good | Excellent for the first train only |
| Contrast across all states | **Safe by construction** | Safe | **Risky** (text on 24 line colours) |
| Busy stations (Times Sq) | Good (chips + panels) | Good (tables) | Weak (colour stack) |
| Mobile | Strong | Weak | Strong |
| Build effort | Medium | Medium | Medium |

## 2. Recommendation: Direction 1, Wayfinding
1. **It best answers the three questions.**
   * *Where am I going?* The map and search are the first screen.
   * *How do I get there?* Plan is one tab away and draws the route on the same map.
   * *When is my train?* The station board's numerals are the largest type in the app.
2. **It's the only map-first direction where the map is a tool, not an illustration.**
3. **It fits your instructor's feedback.** Text never sits on photos or line colours: just white on black or black on white, in every state including highlights. Motion has clear meanings:
   * a line thickens when selected;
   * a station pulses once when chosen;
   * a row flashes when MTA revises its time;
   * a planned route draws itself in line order.
4. **It's authentically New York without imitation:** the visual language of signage, our own route marks, and real geography.

## 3. Navigation: Explore · Plan · Saved
| Tab | Answers | Contents |
|---|---|---|
| **Explore** (home) | "Where?" and "When?" | Map + search + line picker. Selecting a station opens its live board (desktop: right rail; mobile: sheet with a real URL, `/station/[id]`) |
| **Plan** | "How do I get there?" | From / To (search or "pick on map") → suggested route legs with transfers → route drawn on the map → live next train at the origin |
| **Saved** | "My trains, now" | Followed stations as live sign panels. Signed out, this tab says "Sign in to save stations" with one button |

* **Desktop:** tabs in the top bar, search always visible. **Mobile:** a labelled 3-item bottom bar, search at the top of Explore. No hamburger, no gestures.
* A signed-in returning rider who has saved stations opens on **Saved**; everyone else lands on **Explore**. The choice is remembered per device.
* All existing URLs stay: `/station/[id]`, `/line/[route]`. New ones: `/plan?from=153&to=602`.

## 4. Interactive map: feasibility
### 4.1 What we already have vs. what's needed
| Feature | Data | Status |
|---|---|---|
| Station positions | `stations.lat/lon` (MTA Stations.csv, complex average) | ✅ in the database |
| Line identity (colour, name) | `routes` | ✅ |
| Which lines serve a station; stop order along a line | `stations.routes`, `route_stops` | ✅ |
| **Line geometry** | MTA `shapes.txt` (261 shapes, 153k points) | ✅ available; **must be preprocessed** into a static asset (simplified per route, about 110 KB). No database change |
| **Transfer connections** between stations | MTA `transfers.txt` (613 rows, 150 cross-station, with min transfer time) | ✅ available; add as a static asset or a small table |
| Live arrivals at a station | `platform_boards` + Realtime | ✅ |
| Live train *positions* | GTFS-RT vehicle entities (stop-level only: "in transit to X") | ❌ **Not stored.** The worker deliberately drops them. Showing moving trains would need worker and schema changes and more Realtime traffic. **Not proposed.** We never invent positions |

### 4.2 Rendering options
| Option | What it is | Pros | Cons |
|---|---|---|---|
| **A. Own SVG/Canvas network map** *(recommended)* | Real geography from `shapes.txt`, no basemap; pan/zoom with `d3-zoom` (ISC licence) | Light (no tiles), fully styleable in the Wayfinding identity, works offline after load, no third-party uptime, no API key, no extra licence beyond MTA attribution | No streets or neighbourhoods; we have to build label placement and touch interactions |
| B. MapLibre GL + OpenFreeMap tiles | Vector basemap (OpenStreetMap) with our lines on top | Real streets; zoom feels native | About 250 KB of JS + tiles; OSM/OpenMapTiles attribution; the public tile service has no SLA; harder to make "ours" visually |
| C. Schematic diagram | Octilinear, spaced like the official map | Most readable for planning | **No open schematic coordinates exist.** Copying the official map's layout isn't allowed; generating our own is a research project. **Not feasible for Assignment 5** |

Plan: **A for v1**, with B as a possible later "show streets" toggle.

### 4.3 Interactions (all backed by real data)
* **Select a line:** that line's shapes thicken while the others dim to 28%; its stations show labels. Uses `route_stops`.
* **Select a station:** a one-time pulse, then the live board opens. Uses the existing `useStations()` hook and Realtime, so the backend is unchanged.
* **Transfers:** stations with more than one line group or a `transfers.txt` link draw as larger rings, and the board lists "Transfer to …" lines.
* **Live on the map:** only stations with an open board get a live ring. No fake moving trains.

### 4.4 Licensing
* **MTA data:** free. We must not imply MTA endorsement, and the data must be served from our own servers, which the worker already does. A footer credits the source. ([MTA terms](https://www.mta.info/developers/terms-and-conditions))
* **MTA logos, maps, symbols:** require a licence. We **don't copy the official map**, and we use **our own route marks** (rounded-square tiles in our typeface) carrying line colours, not MTA bullet artwork. ([nomenclature](https://en.wikipedia.org/wiki/New_York_City_Subway_nomenclature))
* **OpenFreeMap (if option B):** MIT; OSM data; the attribution "© OpenMapTiles, Data from OpenStreetMap" is required. ([openfreemap.org](https://openfreemap.org))
* **Note:** MTA's terms also ask apps to register for a developer key. Worth doing before public deployment.

## 5. Trip planner: feasibility
### 5.1 Probe result (real data, `mockups/tools/route_probe.py`)
**Graph:**
* Nodes are (platform, route).
* **Ride edges:** 1,503 consecutive-stop segments, weighted by the **median scheduled run time** of weekday 10:00–16:00 trips in `stop_times.txt`.
* **Transfer edges:** 5,530, from `transfers.txt` `min_transfer_time` (line changes within a station, plus the 150 walking connections).
* **Starting wait:** half the scheduled headway at the origin.
* **Search:** Dijkstra, with a small penalty per transfer.

| Query | Result | Correct? |
|---|---|---|
| 125 St → 14 St–Union Sq | A express 4 stops to 14 St; transfer to the L at 8 Av; L 2 stops. About 25 min scheduled | ✅ the route a New Yorker would take |
| Astoria–Ditmars Blvd → Atlantic Av–Barclays | N, 15 stops, one seat. About 46 min scheduled | ✅ |

### 5.2 What's needed to ship it
1. **A precomputed graph asset** built at build time from static GTFS:
   * segments and headways per **service period** (weekday, Saturday, Sunday) and **time band** (AM peak, midday, PM peak, evening, late night), so express and local patterns are right for the time;
   * transfers;
   * about 300–500 KB of JSON, cached.
2. **Routing in the browser** (Dijkstra over about 1.5k nodes takes milliseconds), returning up to 3 alternatives (fewest transfers, fastest).
3. **Live overlay (honest):** the **next live departure** of the first leg at the origin comes from the existing board. Times for transfer platforms come from their boards when the next 3 trains there cover the connection. Everything else is labelled **"by schedule"**.
4. **On the map:** the legs draw in line order with transfer rings.

### 5.3 Limits we must state, not hide
* Base GTFS doesn't include **planned weekend or night service changes**. MTA's `gtfs_supplemented.zip` (7-day horizon) does; we'd regenerate the graph from it daily. Without that, the planner may suggest a line that's rerouted that weekend.
* **Unplanned disruptions** (delays, suspensions) aren't in the graph. The service-alerts feed isn't ingested.
* Travel times are **scheduled estimates**, always labelled that way, never shown as live predictions.
* Accessibility (elevator) routing needs MTA's elevator data. Out of scope.

**Conclusion:** a **useful, honest planner v1** is feasible with no backend change: route + transfers + scheduled estimate + live first departure. A "live door-to-door ETA" is not feasible reliably and isn't proposed.

## 6. Architecture impact
* **Worker, Cron, schema, Realtime, RLS:** unchanged. The map and planner use **static, build-time assets** generated from MTA static GTFS (like the station seed).
* **Realtime and free-tier usage:** unchanged per station opened. The map never subscribes to every station; only the open board or saved stations subscribe (filtered by `station_id`, as today).
* **Egress:** the map and graph assets ship from Vercel as static files, not from Supabase.
* **Optional later:** a `transfers` table and planner-side Postgres functions, only if we need server-side routing.

## 7. Roadmap
| Priority | Work | Notes |
|---|---|---|
| **P0: required for Assignment 5** | Wayfinding visual system (tokens, type, route marks, Day mode); Explore shell and tab navigation; station board redesigned; Saved; all six states; Realtime without refresh; follows and RLS; **fix the "Reconnecting" false positive**; build, lint, tests, deploy readiness | Reuses all existing logic modules (below) |
| **P1: map** | Build-time map asset from `shapes.txt`; SVG map with pan/zoom, line select, station select → live board, transfer rings; mobile sheet | No backend change |
| **P2: planner v1** | Build-time graph per service period and time band; From/To; route legs; scheduled estimate; live next departure; route drawn on the map | Clearly labelled estimates |
| **P3: optional** | Supplemented GTFS for planned changes; service alerts; street basemap toggle; vehicle-position-based "train approaching" | Some need worker changes, so after Assignment 5 |

If time is short, **P0 + P1 is a complete, polished Assignment 5**. P2 adds value only if it's honest and finished.

## 8. What's preserved
* **Backend, all of it:** the 8-feed worker, Cron (15 s), `commit_worker_run` and change detection, the 10 migrations, Realtime publication, Clerk ↔ Supabase auth, RLS on follows, the search RPC.
* **Frontend logic (tested, reused as-is):**
  * `lib/headway/core.ts` (time formatting, direction labels, grouping, freshness; 7 unit tests);
  * `lib/headway/useStations.ts` (filtered Realtime subscription);
  * `app/providers.tsx` (Supabase + Clerk token + heartbeat + clock);
  * `FollowButton` behaviour (optimistic + sign-in return);
  * `StationSearch` behaviour.
* **Replaced:** the visual layer, meaning `globals.css` tokens, the layout and header, and the markup of HomeView, StationView, TrainRow, YourStations, LineBrowser and LineView. Behaviour moves over; the look is rebuilt.
