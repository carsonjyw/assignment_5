"""Build static map + trip-planner assets from MTA static GTFS (no invented data).

  public/data/map.json   track network: one segment per pair of adjacent stations, carrying every route that
                         runs over it (MTA shapes.txt geometry; express hops split at the stations they pass),
                         station positions (MTA Stations.csv complex average, same as the DB seed) and the
                         positions of each complex's member stations (for transfer connectors)
  public/data/plan.json  schedule graph per service period and time band (MTA stop_times.txt medians),
                         headways, typical headsigns, and transfers (MTA transfers.txt min_transfer_time)

Usage: python3 -I scripts/build_transit_assets.py <gtfs_subway_dir> <Stations.csv> public/data
"""
import collections, csv, json, math, os, statistics, sys

G, STATIONS_CSV, OUT = sys.argv[1:4]
os.makedirs(OUT, exist_ok=True)
read = lambda n: list(csv.DictReader(open(os.path.join(G, n), encoding="utf-8-sig")))

stops = {r["stop_id"]: r for r in read("stops.txt")}
routes = {r["route_id"]: r for r in read("routes.txt")}
trips = {r["trip_id"]: r for r in read("trips.txt")}
mta = list(csv.DictReader(open(STATIONS_CSV, encoding="utf-8-sig")))
complex_of = {r["GTFS Stop ID"]: int(r["Complex ID"]) for r in mta}
members = collections.defaultdict(list)
for r in mta:
    members[int(r["Complex ID"])].append(r)
route_order = sorted(routes, key=lambda r: int(routes[r].get("route_sort_order") or 999))

# ------------------------------------------------------------------ projection (shared by map, basemap and plan)
LAT0 = 40.70
KX = math.cos(math.radians(LAT0))
M = 111_320.0  # metres per degree of latitude; x is already scaled by cos(lat0), so x and y are both ~metres/M
xy = lambda lon, lat: (lon * KX, lat)

def rdp(p, eps):
    if len(p) < 3: return p
    (x1, y1), (x2, y2) = p[0], p[-1]
    dx, dy = x2 - x1, y2 - y1; n = math.hypot(dx, dy) or 1e-12
    i, dmax = 0, 0.0
    for k in range(1, len(p) - 1):
        d = abs(dy * p[k][0] - dx * p[k][1] + x2 * y1 - y2 * x1) / n
        if d > dmax: i, dmax = k, d
    return rdp(p[:i + 1], eps)[:-1] + rdp(p[i:], eps) if dmax > eps else [p[0], p[-1]]

def secs(t):
    h, m, s = map(int, t.split(":")); return h * 3600 + m * 60 + s

rows_by_trip = collections.defaultdict(list)
for st in read("stop_times.txt"):
    if st["trip_id"] in trips:
        rows_by_trip[st["trip_id"]].append((int(st["stop_sequence"]), st["stop_id"], secs(st["arrival_time"]), secs(st["departure_time"])))
for rows in rows_by_trip.values():
    rows.sort()

# ------------------------------------------------------------------ track network (topology from GTFS)
# Every service pattern (shape) is cut at the stations its representative trip serves, and express hops are
# split again at the stations the train physically runs through (stations within 30 m of the shape, on a
# parallel line). The result is one segment per pair of adjacent stations, carrying every route that uses
# it, so shared track is drawn once (bundled by trunk colour) and the network reads as connected. Geometry
# is always MTA's shape; only the end points snap to the GTFS station coordinate so segments meet exactly.
parent_xy = {sid: xy(float(r["stop_lon"]), float(r["stop_lat"])) for sid, r in stops.items() if r["location_type"] == "1"}

shape_raw = collections.defaultdict(list)
for r in read("shapes.txt"):
    shape_raw[r["shape_id"]].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lon"]), float(r["shape_pt_lat"])))
shape_pts = {sid: [xy(lon, lat) for _, lon, lat in sorted(p)] for sid, p in shape_raw.items()}

rep_trip = {}  # shape → the trip with the most stops (the full pattern)
for tid, t in trips.items():
    n = len(rows_by_trip.get(tid, ()))
    if n > rep_trip.get(t["shape_id"], (0, None))[0]:
        rep_trip[t["shape_id"]] = (n, tid)

def nearest_on(pts, q, lo=0):
    """(distance in metres, segment index, t) of the closest point to q on pts[lo:]."""
    best = (1e18, lo, 0.0)
    for i in range(lo, len(pts) - 1):
        (x1, y1), (x2, y2) = pts[i], pts[i + 1]
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((q[0] - x1) * dx + (q[1] - y1) * dy) / L2))
        d = math.hypot(x1 + t * dx - q[0], y1 + t * dy - q[1]) * M
        if d < best[0]:
            best = (d, i, t)
    return best

def at(pts, i, t):
    (x1, y1), (x2, y2) = pts[i], pts[i + 1]
    return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))

patterns = []  # (shape_id, route, [parent...], [(segment i, t) per parent along the shape])
for sid, (_, tid) in rep_trip.items():
    seq = []
    for _, stop_id, _, _ in rows_by_trip[tid]:
        par = stops[stop_id]["parent_station"] or stop_id
        if par in parent_xy and (not seq or seq[-1] != par):
            seq.append(par)
    pts = shape_pts[sid]
    locs, lo = [], 0
    for par in seq:
        _, i, t = nearest_on(pts, parent_xy[par], lo)
        locs.append((i, t)); lo = i
    patterns.append((sid, trips[tid]["route_id"], seq, locs))

# direction of the line(s) through each station, from the stations it is directly connected to
station_dirs = collections.defaultdict(list)
for _, _, seq, _ in patterns:
    for a, b in zip(seq, seq[1:]):
        (x1, y1), (x2, y2) = parent_xy[a], parent_xy[b]
        n = math.hypot(x2 - x1, y2 - y1) or 1e-12
        station_dirs[a].append(((x2 - x1) / n, (y2 - y1) / n)); station_dirs[b].append(((x2 - x1) / n, (y2 - y1) / n))

neighbours = collections.defaultdict(set)
for _, _, seq, _ in patterns:
    for a, b in zip(seq, seq[1:]):
        neighbours[a].add(b); neighbours[b].add(a)

def on_interior(pts, q, limit=30):
    d, i, t = nearest_on(pts, q)
    return d <= limit and not (i == 0 and t == 0) and not (i == len(pts) - 2 and t == 1), i, t

def passed_stations(pts, a, b):
    """Stations a hop physically runs through. A station counts only when it sits within 30 m of the hop's
    track, on a parallel line (|cos| >= 0.8), is not another platform of either end's complex, and its own
    track continues along the hop (one of its neighbours is an end of the hop or also lies on the hop).
    That keeps real express-past-local cases and rejects lines that merely cross or touch the corridor."""
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    pad = 40 / M
    ends = {complex_of.get(a), complex_of.get(b)} - {None}
    found = []
    for par, q in parent_xy.items():
        if par in (a, b) or complex_of.get(par) in ends:
            continue
        if not (min(xs) - pad <= q[0] <= max(xs) + pad and min(ys) - pad <= q[1] <= max(ys) + pad):
            continue
        ok, i, t = on_interior(pts, q)
        if not ok:
            continue
        (x1, y1), (x2, y2) = pts[i], pts[i + 1]
        n = math.hypot(x2 - x1, y2 - y1) or 1e-12
        h = ((x2 - x1) / n, (y2 - y1) / n)
        if not any(abs(h[0] * u + h[1] * v) >= 0.8 for u, v in station_dirs[par]):
            continue
        if not any(nb in (a, b) or on_interior(pts, parent_xy[nb])[0] for nb in neighbours[par]):
            continue
        found.append((i + t, par, i, t))
    return sorted(found)

segments = {}  # (a, b) sorted → {"routes", "pts" oriented a→b, "direct", "north"}
hops = collections.defaultdict(set)  # (route, complex A, complex B) → segment keys, to draw planned legs on track
passed_log = collections.Counter()
for sid, route, seq, locs in patterns:
    pts_all = shape_pts[sid]
    northbound = ".N" in sid
    for k in range(len(seq) - 1):
        a, b = seq[k], seq[k + 1]
        (ia, ta), (ib, tb) = locs[k], locs[k + 1]
        if (ib, tb) < (ia, ta):
            continue
        slice_ = [at(pts_all, ia, ta)] + pts_all[ia + 1:ib + 1] + [at(pts_all, ib, tb)]
        nodes, cut = [a], [(0, 0.0)]
        for _, par, i, t in passed_stations(slice_, a, b):
            nodes.append(par); cut.append((i, t)); passed_log[route] += 1
        nodes.append(b); cut.append((len(slice_) - 2, 1.0))
        direct = len(nodes) == 2
        ca, cb = complex_of.get(a), complex_of.get(b)
        for j in range(len(nodes) - 1):
            u, v = nodes[j], nodes[j + 1]
            if u == v:
                continue
            (i0, _), (i1, _) = cut[j], cut[j + 1]
            piece = [parent_xy[u]] + slice_[i0 + 1:i1 + 1] + [parent_xy[v]]
            key = tuple(sorted((u, v)))
            oriented = piece if (u, v) == key else piece[::-1]
            seg = segments.get(key)
            if seg is None:
                seg = segments[key] = {"routes": set(), "pts": oriented, "direct": direct, "north": None}
            elif direct and not seg["direct"]:
                seg["pts"], seg["direct"] = oriented, True  # prefer a local train's own hop for the drawing
            seg["routes"].add(route)
            if seg["north"] is None and northbound:
                seg["north"] = (u, v) == key  # draw in railroad-north direction: consistent bundle order along corridors
            if ca is not None and cb is not None and ca != cb:
                hops[(route, min(ca, cb), max(ca, cb))].add(key)

# ------------------------------------------------------------------ stations + extent
st_xy = {}
for cid, rs in members.items():
    lat = sum(float(r["GTFS Latitude"]) for r in rs) / len(rs)
    lon = sum(float(r["GTFS Longitude"]) for r in rs) / len(rs)
    st_xy[cid] = xy(lon, lat)

xs = [x for seg in segments.values() for x, _ in seg["pts"]] + [x for x, _ in st_xy.values()]
ys = [y for seg in segments.values() for _, y in seg["pts"]] + [y for _, y in st_xy.values()]
minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
W = 1000.0
S = W / (maxx - minx)
H = round((maxy - miny) * S, 1)
proj = lambda x, y: (round((x - minx) * S, 2), round((maxy - y) * S, 2))

stop_routes = collections.defaultdict(set)
for tid, rows in rows_by_trip.items():
    for _, stop_id, _, _ in rows:
        stop_routes[stop_id].add(trips[tid]["route_id"])
station_routes = collections.defaultdict(set)
station_parents = collections.defaultdict(set)
for sid, rs in stop_routes.items():
    parent = stops[sid]["parent_station"] or sid
    cid = complex_of.get(parent)
    if cid is not None:
        station_routes[cid] |= rs
        station_parents[cid].add(parent)

transfers = []  # walking connections between different GTFS stations, with MTA's min transfer time
for r in read("transfers.txt"):
    a, b = r["from_stop_id"], r["to_stop_id"]
    if a != b and a in complex_of and b in complex_of:
        transfers.append([a, b, int(r["min_transfer_time"] or 180)])
self_xfer = {r["from_stop_id"]: int(r["min_transfer_time"] or 180) for r in read("transfers.txt") if r["from_stop_id"] == r["to_stop_id"]}

def complex_name(rs):
    """Same rule as scripts/generate_static_seed.py, so map names match stations.name in the DB."""
    names = collections.Counter(r["Stop Name"] for r in rs)
    return max(names.items(), key=lambda kv: (kv[1], max(len(r["Daytime Routes"].split()) for r in rs if r["Stop Name"] == kv[0])))[0]

colors = []  # trunk colours from routes.txt, in route order (also the order lines sit in a bundle)
for r in route_order:
    if routes[r]["route_color"] not in colors:
        colors.append(routes[r]["route_color"])
seg_keys = sorted(segments)
seg_index = {k: i for i, k in enumerate(seg_keys)}
on_network = {p for k in seg_keys for p in k}
station_nodes = collections.defaultdict(list)
for par in sorted(parent_xy):
    cid = complex_of.get(par)
    if cid is not None and par in on_network:
        station_nodes[cid].append(list(proj(*parent_xy[par])))

def flat(pts):
    pts = rdp(pts, 3 / M)  # ~3 m tolerance keeps curves, drops redundant points
    return [v for x, y in pts for v in proj(x, y)]

map_out = {
    "source": "MTA static GTFS (shapes.txt, stop_times.txt, stops.txt, routes.txt) + MTA Stations.csv",
    "proj": {"lat0": LAT0, "kx": KX, "minx": minx, "maxy": maxy, "s": S},
    "w": W, "h": H,
    "colors": colors,
    "routes": route_order,
    # one entry per pair of adjacent stations: colour indices, route indices, flattened x,y (railroad north)
    "segs": [{"c": sorted({colors.index(routes[r]["route_color"]) for r in segments[k]["routes"]}),
              "r": sorted(route_order.index(r) for r in segments[k]["routes"]),
              "d": flat(segments[k]["pts"] if segments[k]["north"] is not False else segments[k]["pts"][::-1])}
             for k in seg_keys],
    # route, complex A, complex B (A < B, consecutive stops of that route) → segments it runs over
    "hops": [[route_order.index(r), a, b, sorted(seg_index[k] for k in ks)] for (r, a, b), ks in sorted(hops.items())],
    "stations": [{"id": cid, "name": complex_name(rs),
                  "x": proj(*st_xy[cid])[0], "y": proj(*st_xy[cid])[1],
                  "nodes": station_nodes.get(cid, []),
                  "routes": sorted(station_routes.get(cid, []), key=lambda r: route_order.index(r) if r in route_order else 99),
                  "groups": len(station_parents.get(cid, [])) or 1}
                 for cid, rs in sorted(members.items())],
}
json.dump(map_out, open(os.path.join(OUT, "map.json"), "w"), separators=(",", ":"))

# ------------------------------------------------------------------ planner graph
BANDS = [("early", 0, 6), ("am", 6, 10), ("midday", 10, 16), ("pm", 16, 20), ("evening", 20, 24)]
SERVICES = ["Weekday", "Saturday", "Sunday"]
platforms = sorted({s for rows in rows_by_trip.values() for _, s, _, _ in rows if s in stops})
pidx = {p: i for i, p in enumerate(platforms)}
ridx = {r: i for i, r in enumerate(route_order)}
headsign_pool = []
hidx = {}

def h_index(h):
    if h not in hidx:
        hidx[h] = len(headsign_pool); headsign_pool.append(h)
    return hidx[h]

bands_out = {}
for svc in SERVICES:
    for name, h0, h1 in BANDS:
        seg = collections.defaultdict(list); deps = collections.defaultdict(list); heads = collections.defaultdict(collections.Counter)
        for tid, rows in rows_by_trip.items():
            t = trips[tid]
            if t["service_id"] != svc:
                continue
            r = t["route_id"]
            for (a, sa, _, da), (b, sb, ab, _) in zip(rows, rows[1:]):
                if h0 * 3600 <= da % 86400 < h1 * 3600:
                    seg[(r, sa, sb)].append(ab - da)
                    deps[(r, sa)].append(da)
                    heads[(r, sa[-1])][t["trip_headsign"]] += 1
        segs_out = [[pidx[a], pidx[b], ridx[r], round(statistics.median(v))] for (r, a, b), v in seg.items() if a in pidx and b in pidx]
        headways = []
        for (r, p), d in deps.items():
            d = sorted(set(d)); gaps = [y - x for x, y in zip(d, d[1:]) if y > x]
            if p in pidx:
                # trips per band also tells the UI when a line barely runs
                headways.append([pidx[p], ridx[r], round(statistics.median(gaps)) if gaps else (h1 - h0) * 3600, len(d)])
        hs = [[ridx[r], d, h_index(c.most_common(1)[0][0])] for (r, d), c in heads.items()]
        bands_out[f"{svc}:{name}"] = {"segments": segs_out, "headways": headways, "headsigns": hs}

plan_out = {
    "source": "MTA static GTFS stop_times.txt (median scheduled run times per band), transfers.txt",
    "feed_version": open(os.path.join(G, "feed_info.txt")).read().splitlines()[1].split(",")[5] if os.path.exists(os.path.join(G, "feed_info.txt")) else None,
    "bands": [[n, a, b] for n, a, b in BANDS], "services": SERVICES,
    "routes": route_order,
    "platforms": [[p, stops[p]["parent_station"] or p, complex_of.get(stops[p]["parent_station"] or p)] for p in platforms],
    "same_station_transfer_s": self_xfer,
    "transfers": transfers,
    "headsigns": headsign_pool,
    "graph": bands_out,
}
json.dump(plan_out, open(os.path.join(OUT, "plan.json"), "w"), separators=(",", ":"))
for f in ("map.json", "plan.json"):
    print(f, os.path.getsize(os.path.join(OUT, f)), "bytes")
print(f"segments={len(map_out['segs'])} hops={len(map_out['hops'])} stations={len(map_out['stations'])} "
      f"passed-station splits by route={dict(passed_log)} platforms={len(platforms)} bands={len(bands_out)}")

if os.environ.get("AUDIT_SPLITS"):
    for sid, route, seq, locs in patterns:
        if ".N" not in sid: continue
        pts_all = shape_pts[sid]
        for k in range(len(seq) - 1):
            a, b = seq[k], seq[k + 1]; (ia, ta), (ib, tb) = locs[k], locs[k + 1]
            if (ib, tb) < (ia, ta): continue
            sl = [at(pts_all, ia, ta)] + pts_all[ia + 1:ib + 1] + [at(pts_all, ib, tb)]
            for _, par, _, _ in passed_stations(sl, a, b):
                served = {r for s2, rs in stop_routes.items() if (stops[s2]["parent_station"] or s2) == par for r in rs}
                same = any(routes[r]["route_color"] == routes[route]["route_color"] for r in served)
                if not same:
                    print("CROSS", route, sid, stops[a]["stop_name"], "→", stops[b]["stop_name"], "passes", par, stops[par]["stop_name"], sorted(served))
