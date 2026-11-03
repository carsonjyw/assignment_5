"""Real network geometry for the mockups: MTA shapes.txt (one representative northbound shape per
distinct pattern), simplified with Douglas–Peucker, projected to SVG. Stations from HEADWAY's DB."""
import csv, collections, json, math, os, sys, urllib.request

G = sys.argv[1]
OUT = sys.argv[2]
KEY = sys.argv[3]
PROJ = "https://fddulhtbsrrzepgehdhi.supabase.co/rest/v1/"

def rest(path):
    req = urllib.request.Request(PROJ + path, headers={"apikey": KEY})
    return json.load(urllib.request.urlopen(req, timeout=20))

pts = collections.defaultdict(list)
for r in csv.DictReader(open(f"{G}/shapes.txt")):
    pts[r["shape_id"]].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lon"]), float(r["shape_pt_lat"])))
route_of = {}
for t in csv.DictReader(open(f"{G}/trips.txt")):
    route_of.setdefault(t["shape_id"], t["route_id"])

def rdp(p, eps):
    if len(p) < 3: return p
    (x1, y1), (x2, y2) = p[0], p[-1]
    dx, dy = x2 - x1, y2 - y1; n = math.hypot(dx, dy) or 1e-12
    i, dmax = 0, 0
    for k in range(1, len(p) - 1):
        d = abs(dy * p[k][0] - dx * p[k][1] + x2 * y1 - y2 * x1) / n
        if d > dmax: i, dmax = k, d
    if dmax > eps:
        return rdp(p[:i + 1], eps)[:-1] + rdp(p[i:], eps)
    return [p[0], p[-1]]

LAT0 = 40.70
kx = math.cos(math.radians(LAT0))
shapes = []
for sid, p in pts.items():
    if "..N" not in sid and ".N" not in sid:  # one direction is enough for drawing
        continue
    p.sort()
    xy = [(lon * kx, lat) for _, lon, lat in p]
    shapes.append({"route": route_of.get(sid, sid.split(".")[0]), "pts": rdp(xy, 0.00018)})

stations = rest("stations?select=station_id,name,borough,routes,lat,lon")
routes = rest("routes?select=route_id,short_name,long_name,color,text_color,sort_order&order=sort_order")
platforms = rest("platforms?select=station_id,parent_stop_id")
groups = collections.Counter()
for p in {(r["station_id"], r["parent_stop_id"]) for r in platforms}:
    groups[p[0]] += 1

xs = [x for s in shapes for x, _ in s["pts"]] + [s["lon"] * kx for s in stations]
ys = [y for s in shapes for _, y in s["pts"]] + [s["lat"] for s in stations]
minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
W = 1000
scale = W / (maxx - minx)
H = round((maxy - miny) * scale)
P = lambda x, y: (round((x - minx) * scale, 1), round((maxy - y) * scale, 1))

out = {
    "w": W, "h": H,
    "lines": [{"route": s["route"], "d": "M" + " L".join(f"{a},{b}" for a, b in (P(x, y) for x, y in s["pts"]))} for s in shapes],
    "stations": [{"id": s["station_id"], "name": s["name"], "routes": s["routes"], "xfer": groups[s["station_id"]] > 1 or len(s["routes"]) > 3,
                  "x": P(s["lon"] * kx, s["lat"])[0], "y": P(s["lon"] * kx, s["lat"])[1]} for s in stations],
    "routes": {r["route_id"]: r for r in routes},
}
json.dump(out, open(OUT, "w"), separators=(",", ":"))
print(f"lines={len(out['lines'])} points={sum(len(s['pts']) for s in shapes)} stations={len(stations)} size={os.path.getsize(OUT)}B view={W}x{H}")
