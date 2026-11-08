"""Add transfer data to public/data/map.json: `complexes` (stops and transfers per multi-stop station) and `walks`.

Source: MTA static GTFS. transfers.txt has transfer_type 2 on every row and only gives a minimum time, and the feed
has no pathways.txt or levels.txt, so MTA's data can't tell an underground passage from a street walk, and never
says where one runs. The one real distinction is structural, and it's what the map draws:
  solid   documented transfer between stops of ONE MTA station complex (a minimal tree per complex, in `links`)
  dashed  documented transfer between stops of TWO separate complexes (`walks`: one per pair of complexes)
Both are schematic: straight lines between real stop positions. Tree choice: lowest total documented transfer
time, then no hubs (lowest highest-degree), then shortest. A complex with no documented transfer gets no line.

Run after build_transit_assets.py, which rewrites map.json.
Usage: python3 -I scripts/build_station_complexes.py <gtfs_subway.zip> public/data/plan.json public/data/map.json
"""
import collections, csv, io, itertools, json, math, sys, zipfile

ZIP, PLAN, MAP = sys.argv[1:4]
plan = json.load(open(PLAN))
m = json.load(open(MAP))
P = m["proj"]
proj = lambda lon, lat: [round((lon * P["kx"] - P["minx"]) * P["s"], 2), round((P["maxy"] - lat) * P["s"], 2)]
with zipfile.ZipFile(ZIP) as z:
    rows = lambda n: csv.DictReader(io.TextIOWrapper(z.open(n), encoding="utf-8-sig"))
    stops = {r["stop_id"]: r for r in rows("stops.txt")}
    trip_route = {r["trip_id"]: r["route_id"] for r in rows("trips.txt")}
    stop_routes = collections.defaultdict(set)
    for r in rows("stop_times.txt"):
        route = trip_route.get(r["trip_id"])
        if route:
            stop_routes[stops[r["stop_id"]]["parent_station"] or r["stop_id"]].add(route)

complex_of = {p[1]: p[2] for p in plan["platforms"]}
members = collections.defaultdict(list)
for parent, cid in complex_of.items():
    if cid is not None:
        members[cid].append(parent)
secs, cross = {}, {}  # same-complex and between-complex documented transfers: (stop, stop) → shortest seconds
for a, b, t in plan["transfers"]:
    ca, cb = complex_of.get(a), complex_of.get(b)
    if a == b or ca is None or cb is None:
        continue
    bucket = secs if ca == cb else cross
    key = (min(a, b), max(a, b))
    bucket[key] = min(t, bucket.get(key, t))

pos = {}
def stop_pos(p):
    if p not in pos:
        pos[p] = proj(float(stops[p]["stop_lon"]), float(stops[p]["stop_lat"]))
    return pos[p]

def connected(n, edges):
    parent = list(range(n))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for a, b in edges:
        parent[find(a)] = find(b)
    return len({find(i) for i in range(n)}) == 1

def best_tree(entries, t):
    """Fewest links that still connect every stop MTA documents a transfer for. Complexes are small: brute force."""
    used = sorted({i for i, j, _ in t for i in (i, j)})
    remap = {u: k for k, u in enumerate(used)}
    time = {(i, j): s for i, j, s in t}
    best, best_score = [], None
    for tree in itertools.combinations(time, len(used) - 1):
        if not connected(len(used), [(remap[a], remap[b]) for a, b in tree]):
            continue
        degree = collections.Counter(x for k in tree for x in k)
        length = sum(math.dist((entries[a]["x"], entries[a]["y"]), (entries[b]["x"], entries[b]["y"])) for a, b in tree)
        score = (sum(time[k] for k in tree), max(degree.values()), length)
        if best_score is None or score < best_score:
            best, best_score = list(tree), score
    return [[a, b] for a, b in best]

order = {r: i for i, r in enumerate(m["routes"])}
routes_of = lambda p: sorted(stop_routes[p], key=lambda r: order.get(r, 99))
out = []
for st in m["stations"]:
    if len(st["nodes"]) < 2:
        continue
    parents = sorted(members[st["id"]], key=lambda p: min((order.get(r, 99) for r in stop_routes[p]), default=99))
    index = {p: i for i, p in enumerate(parents)}
    entries = []
    for p in parents:
        x, y = stop_pos(p)
        assert [x, y] in st["nodes"], f"{p} isn't a node of {st['name']}"
        entries.append({"n": stops[p]["stop_name"], "r": routes_of(p), "x": x, "y": y})
    t = [[index[a], index[b], s] for (a, b), s in sorted(secs.items()) if a in index and b in index]
    out.append({"id": st["id"], "stops": entries, "t": t, "links": best_tree(entries, t) if t else []})

# Between complexes: one dashed line per pair of complexes, between its closest documented stops
by_pair = collections.defaultdict(list)
for (a, b), t in cross.items():
    by_pair[tuple(sorted((complex_of[a], complex_of[b])))].append((a, b, t))
walks = []
names = {s["id"]: s["name"] for s in m["stations"]}
for (ca, cb), options in sorted(by_pair.items()):
    a, b, t = min(options, key=lambda o: math.dist(stop_pos(o[0]), stop_pos(o[1])))
    if complex_of[a] != ca:
        a, b = b, a
    walks.append({"a": ca, "b": cb, "s": t, "ax": stop_pos(a)[0], "ay": stop_pos(a)[1], "bx": stop_pos(b)[0], "by": stop_pos(b)[1],
                  "ar": routes_of(a), "br": routes_of(b)})
    print(f"walk: {names[ca]} {routes_of(a)} <-> {names[cb]} {routes_of(b)}, {t} s")
m["walks"] = walks
m["complexes"] = out
json.dump(m, open(MAP, "w"), separators=(",", ":"))
ts = next(c for c in out if c["id"] == 611)
print(f"{len(out)} complexes; without documented transfers: {[c['id'] for c in out if not c['t']]}")
print("Times Sq links:", [(ts["stops"][a]["r"], ts["stops"][b]["r"]) for a, b in ts["links"]])
