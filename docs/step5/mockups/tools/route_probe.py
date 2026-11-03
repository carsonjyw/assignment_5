"""Feasibility probe: can we route station→station with transfers from MTA static GTFS alone?
Graph nodes = (parent_stop, route, direction). Ride edges = consecutive stops of weekday 10:00–16:00 trips,
weighted by the MEDIAN scheduled run time. Transfer edges = transfers.txt min_transfer_time (same-station
line changes and the 150 cross-station connections). Dijkstra over that graph."""
import csv, collections, heapq, json, statistics, sys, os

G = sys.argv[1]  # unzipped gtfs_subway dir
stops = {r["stop_id"]: r for r in csv.DictReader(open(f"{G}/stops.txt"))}
trips = {r["trip_id"]: r for r in csv.DictReader(open(f"{G}/trips.txt")) if r["service_id"] == "Weekday"}

def secs(t):
    h, m, s = map(int, t.split(":")); return h * 3600 + m * 60 + s

by_trip = collections.defaultdict(list)
for st in csv.DictReader(open(f"{G}/stop_times.txt")):
    if st["trip_id"] in trips:
        by_trip[st["trip_id"]].append((int(st["stop_sequence"]), st["stop_id"], secs(st["arrival_time"]), secs(st["departure_time"])))

seg = collections.defaultdict(list)       # (route, from_platform, to_platform) -> run seconds
headways = collections.defaultdict(list)  # (route, platform) -> departure times midday
for tid, rows in by_trip.items():
    rows.sort(); route = trips[tid]["route_id"]
    if not (10 * 3600 <= rows[0][3] <= 16 * 3600):
        continue
    for (a, sa, _, da), (b, sb, ab, _) in zip(rows, rows[1:]):
        seg[(route, sa, sb)].append(ab - da)
        headways[(route, sa)].append(da)

edges = collections.defaultdict(list)
for (route, a, b), v in seg.items():
    edges[(a, route)].append(((b, route), statistics.median(v), "ride"))
# transfers: change line at the same platform group or walk to a connected station
parent = lambda s: stops[s]["parent_station"] or s
routes_at = collections.defaultdict(set)
for (route, a, b) in seg:
    routes_at[parent(a)].add((a, route)); routes_at[parent(b)].add((b, route))
xfer = {}
for r in csv.DictReader(open(f"{G}/transfers.txt")):
    xfer[(r["from_stop_id"], r["to_stop_id"])] = int(r["min_transfer_time"] or 180)
for (fp, tp), t in xfer.items():
    for (pa, ra) in routes_at.get(fp, ()):
        for (pb, rb) in routes_at.get(tp, ()):
            if ra != rb or fp != tp:
                edges[(pa, ra)].append(((pb, rb), t, "transfer"))

def median_headway(route, platform):
    t = sorted(headways.get((route, platform), []))
    gaps = [b - a for a, b in zip(t, t[1:]) if b > a]
    return statistics.median(gaps) if gaps else None

def plan(orig_parents, dest_parents, transfer_penalty=120):
    pq, best, prev = [], {}, {}
    for p in orig_parents:
        for (plat, route) in routes_at.get(p, ()):
            h = median_headway(route, plat) or 600
            node = (plat, route); best[node] = h / 2  # expected wait = half the scheduled headway
            heapq.heappush(pq, (h / 2, node))
    while pq:
        d, node = heapq.heappop(pq)
        if d > best.get(node, 1e18):
            continue
        if parent(node[0]) in dest_parents:
            path = [node]
            while path[-1] in prev:
                path.append(prev[path[-1]][0])
            return d, list(reversed(path)), prev
        for nxt, w, kind in edges.get(node, ()):
            nd = d + w + (transfer_penalty if kind == "transfer" else 0)
            if nd < best.get(nxt, 1e18):
                best[nxt] = nd; prev[nxt] = (node, kind); heapq.heappush(pq, (nd, nxt))
    return None, [], prev

def legs(path, prev):
    out = []
    for node in path:
        name = stops[parent(node[0])]["stop_name"]
        if not out or out[-1]["route"] != node[1]:
            out.append({"route": node[1], "board": name, "board_stop": node[0], "stops": 0, "alight": name})
        else:
            out[-1]["stops"] += 1; out[-1]["alight"] = name
    return [l for l in out if l["stops"] > 0]

if __name__ == "__main__":
    o, d = sys.argv[2].split(","), sys.argv[3].split(",")
    total, path, prev = plan(set(o), set(d))
    print(json.dumps({"scheduled_total_s": round(total) if total else None, "legs": legs(path, prev),
                      "graph": {"ride_edges": sum(1 for v in edges.values() for e in v if e[2] == "ride"),
                                "transfer_edges": sum(1 for v in edges.values() for e in v if e[2] == "transfer")}}, indent=1))
