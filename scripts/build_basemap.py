"""Build public/data/basemap.json: a deliberately minimal NYC basemap in the SAME projection as map.json.

Sources (real geography, nothing drawn by hand):
  boroughs   NYC Department of City Planning, Borough Boundaries (water areas excluded), NYC Open Data gthc-hcne
  parks      NYC Department of Parks & Recreation, Parks Properties, NYC Open Data enfh-gkve (selected large parks)
  areas      NYC Department of City Planning, 2020 Neighborhood Tabulation Areas, NYC Open Data 9nt8-h7nd
             (only used to place neighbourhood labels at the centroid of the named areas)
  region     US Census Bureau, 2023 Cartographic Boundary File, counties 1:500,000 (KML), for the land around NYC
Water is not drawn: it is whatever is not land, so rivers and bays come straight from the shorelines.
Water labels are placed at the middle of the widest stretch of water found by scanning the real shorelines.

Usage: python3 -I scripts/build_basemap.py <download_dir> public/data/map.json public/data/basemap.json
"""
import json, math, os, re, sys

DL, MAP, OUT = sys.argv[1:4]
m = json.load(open(MAP))
P = m["proj"]
W, H = m["w"], m["h"]
px = lambda lon, lat: ((lon * P["kx"] - P["minx"]) * P["s"], (P["maxy"] - lat) * P["s"])
UNIT_M = 111_320.0 / P["s"]  # metres per map unit
PAD = 60  # map units of margin kept around the network

def rdp(p, eps):
    if len(p) < 3: return p
    stack, keep = [(0, len(p) - 1)], {0, len(p) - 1}
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = p[a], p[b]
        dx, dy = x2 - x1, y2 - y1; n = math.hypot(dx, dy) or 1e-12
        i, dmax = a, 0.0
        for k in range(a + 1, b):
            d = abs(dy * p[k][0] - dx * p[k][1] + x2 * y1 - y2 * x1) / n
            if d > dmax: i, dmax = k, d
        if dmax > eps:
            keep.add(i); stack += [(a, i), (i, b)]
    return [p[i] for i in sorted(keep)]

def clip(ring, x0=-PAD, y0=-PAD, x1=W + PAD, y1=H + PAD):
    """Sutherland–Hodgman clip of a closed ring to the map frame."""
    def run(pts, inside, cross):
        out = []
        for i, cur in enumerate(pts):
            prev = pts[i - 1]
            if inside(cur):
                if not inside(prev): out.append(cross(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cross(prev, cur))
        return out
    lerp = lambda a, b, t: (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    for inside, cross in (
        (lambda p: p[0] >= x0, lambda a, b: lerp(a, b, (x0 - a[0]) / (b[0] - a[0]))),
        (lambda p: p[0] <= x1, lambda a, b: lerp(a, b, (x1 - a[0]) / (b[0] - a[0]))),
        (lambda p: p[1] >= y0, lambda a, b: lerp(a, b, (y0 - a[1]) / (b[1] - a[1]))),
        (lambda p: p[1] <= y1, lambda a, b: lerp(a, b, (y1 - a[1]) / (b[1] - a[1]))),
    ):
        if not ring: break
        ring = run(ring, inside, cross)
    return ring

def area(r):
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1])) / 2

def centroid(rings):
    A = cx = cy = 0.0
    for r in rings:
        for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]):
            c = x1 * y2 - x2 * y1; A += c; cx += (x1 + x2) * c; cy += (y1 + y2) * c
    return (cx / (3 * A), cy / (3 * A)) if A else rings[0][0]

def rings_of(geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    return [[px(lon, lat) for lon, lat in ring[:-1]] for poly in polys for ring in poly]

def simplify_ring(r, eps):
    """RDP for a closed ring: split at the point farthest from the start (a ring's ends coincide)."""
    k = max(range(len(r)), key=lambda i: (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2)
    return rdp(r[:k + 1], eps)[:-1] + rdp(r[k:] + [r[0]], eps)[:-1]

def prep(rings, eps_m, min_area_m2):
    out = []
    for r in rings:
        r = clip(simplify_ring(r, eps_m / UNIT_M))
        if len(r) >= 3 and abs(area(r)) * UNIT_M ** 2 >= min_area_m2:
            out.append(r)
    return out

path = lambda rings: "".join("M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in r) + "Z" for r in rings)

def point_in(rings, q):
    inside = False
    for r in rings:
        for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]):
            if (y1 > q[1]) != (y2 > q[1]) and q[0] < x1 + (q[1] - y1) * (x2 - x1) / (y2 - y1):
                inside = not inside
    return inside

# ------------------------------------------------------------------ boroughs (land)
boro = json.load(open(os.path.join(DL, "boroughs.geojson")))
land, labels, all_land = [], [], []
for f in boro["features"]:
    name = f["properties"]["boroname"]
    full = rings_of(f["geometry"])
    rings = prep(full, 6, 2500)
    land.append({"n": name, "k": "borough", "d": path(rings)})
    all_land += rings
    biggest = max(full, key=lambda r: abs(area(r)))
    # label: centroid of the main landmass, rotated along it when it is long and thin (Manhattan)
    cx, cy = centroid([biggest])
    xs = [p[0] - cx for p in biggest]; ys = [p[1] - cy for p in biggest]
    sxx = sum(x * x for x in xs); syy = sum(y * y for y in ys); sxy = sum(x * y for x, y in zip(xs, ys))
    ang = 0.5 * math.degrees(math.atan2(2 * sxy, sxx - syy))
    elong = (sxx + syy + math.hypot(sxx - syy, 2 * sxy)) / max(1e-9, sxx + syy - math.hypot(sxx - syy, 2 * sxy))
    rot = round(ang if ang < 90 else ang - 180, 1) if elong > 6 else 0
    if rot < -60: rot += 180  # keep text upright
    if rot > 90: rot -= 180
    labels.append({"t": "THE BRONX" if name == "Bronx" else name.upper(), "k": "borough", "x": round(cx, 1), "y": round(cy, 1), "r": rot})

# ------------------------------------------------------------------ region around NYC (Census counties)
KEEP = {"34017": "Hudson", "34003": "Bergen", "34013": "Essex", "34039": "Union", "34023": "Middlesex", "34031": "Passaic",
        "34025": "Monmouth", "36059": "Nassau", "36119": "Westchester"}
kml = open(os.path.join(DL, "census", "x", "cb_2023_us_county_500k.kml"), encoding="utf-8").read()
region = []
for pm in re.findall(r"<Placemark[^>]*>(.*?)</Placemark>", kml, re.S):
    geoid = re.search(r'<SimpleData name="GEOID">(\d+)</SimpleData>', pm)
    if not geoid or geoid.group(1) not in KEEP:
        continue
    for coords in re.findall(r"<outerBoundaryIs>.*?<coordinates>(.*?)</coordinates>", pm, re.S):
        ring = [px(float(a), float(b)) for a, b, *_ in (c.split(",") for c in coords.split())]
        r = clip(simplify_ring(ring[:-1], 25 / UNIT_M))
        if len(r) >= 3 and abs(area(r)) * UNIT_M ** 2 > 20000:
            region.append(r)
all_land += region
land.insert(0, {"n": "Region", "k": "region", "d": path(region)})
for t, lon, lat in (("NEW JERSEY", -74.085, 40.755), ("NASSAU", -73.735, 40.690), ("WESTCHESTER", -73.835, 40.905)):
    x, y = px(lon, lat)
    if point_in(region, (x, y)) and -PAD < x < W + PAD and -PAD < y < H + PAD:
        labels.append({"t": t, "k": "region", "x": round(x, 1), "y": round(y, 1), "r": 0})

# ------------------------------------------------------------------ parks
BIG = {"Central Park", "Prospect Park", "Flushing Meadows Corona Park", "Van Cortlandt Park", "Pelham Bay Park", "Forest Park"}
parks_geo = json.load(open(os.path.join(DL, "parks.geojson")))
parks = []
seen = set()
for f in parks_geo["features"]:
    name = f["properties"]["signname"]
    full = rings_of(f["geometry"])
    rings = prep(full, 5, 15000)
    if not rings:
        continue
    parks.append({"n": name, "d": path(rings)})
    if name not in seen:
        seen.add(name)
        cx, cy = centroid([max(full, key=lambda r: abs(area(r)))])
        short = name.replace(" Corona Park", "").replace("Freshkills Park", "Freshkills")
        labels.append({"t": short, "k": "park", "x": round(cx, 1), "y": round(cy, 1), "r": 0, "big": name in BIG})
        if name == "Central Park":
            # Manhattan's name sits over Central Park, along the island: the one open stretch of Manhattan
            # with no stations, so it never competes with station names
            for l in labels:
                if l["t"] == "MANHATTAN":
                    l["x"], l["y"] = round(cx, 1), round(cy, 1)

# ------------------------------------------------------------------ neighbourhood labels (NTA centroids)
MAJOR = {"Harlem", "Midtown", "Astoria", "Williamsburg", "Flushing", "Downtown Brooklyn", "Long Island City", "Jamaica",
         "Upper West Side", "Upper East Side", "Financial District", "Park Slope", "Bushwick", "Coney Island", "St. George"}
HOODS = [  # label, NTA names (prefix match) whose combined centroid places it
    ("Harlem", ["Harlem (South)", "Harlem (North)"]), ("East Harlem", ["East Harlem"]),
    ("Washington Heights", ["Washington Heights"]), ("Upper West Side", ["Upper West Side"]),
    ("Upper East Side", ["Upper East Side"]), ("Midtown", ["Midtown-Times Square", "Midtown South"]),
    ("Chelsea", ["Chelsea-Hudson Yards"]), ("Greenwich Village", ["Greenwich Village"]),
    ("Lower East Side", ["Lower East Side"]), ("Financial District", ["Financial District"]),
    ("Williamsburg", ["Williamsburg"]), ("Greenpoint", ["Greenpoint"]), ("Bushwick", ["Bushwick"]),
    ("Downtown Brooklyn", ["Downtown Brooklyn"]), ("Park Slope", ["Park Slope"]),
    ("Bed-Stuy", ["Bedford-Stuyvesant"]), ("Crown Heights", ["Crown Heights"]), ("Flatbush", ["Flatbush"]),
    ("Sunset Park", ["Sunset Park"]), ("Bay Ridge", ["Bay Ridge"]), ("Coney Island", ["Coney Island"]),
    ("East New York", ["East New York"]), ("Canarsie", ["Canarsie"]),
    ("Astoria", ["Astoria"]), ("Long Island City", ["Long Island City"]), ("Jackson Heights", ["Jackson Heights"]),
    ("Flushing", ["Flushing-Willets Point"]), ("Jamaica", ["Jamaica"]), ("Forest Hills", ["Forest Hills"]),
    ("Elmhurst", ["Elmhurst"]), ("Ridgewood", ["Ridgewood"]),
    ("Mott Haven", ["Mott Haven"]), ("Fordham", ["Fordham Heights"]), ("Riverdale", ["Riverdale"]),
    ("Parkchester", ["Parkchester"]), ("St. George", ["St. George"]),
]
nta = json.load(open(os.path.join(DL, "nta.geojson")))
matched = {}
for label, prefixes in HOODS:
    rings = []
    names = []
    for f in nta["features"]:
        nm = f["properties"]["ntaname"]
        if any(nm == p or nm.startswith(p + "-") or nm.startswith(p + " (") for p in prefixes):
            rings += [max(rings_of(f["geometry"]), key=lambda r: abs(area(r)))]; names.append(nm)
    if rings:
        cx, cy = centroid(rings)
        if not point_in(all_land, (cx, cy)):  # a combined centroid can fall in water; use the largest area's own
            cx, cy = centroid([max(rings, key=lambda r: abs(area(r)))])
        labels.append({"t": label, "k": "hood", "x": round(cx, 1), "y": round(cy, 1), "r": 0, "big": label in MAJOR})
        matched[label] = names

# ------------------------------------------------------------------ water labels from the real shorelines
def water_mid(lat, lon0, lon1):
    """Middle of the longest run of water along a line of latitude (from the land polygons)."""
    best, run = None, None
    steps = 240
    for i in range(steps + 1):
        lon = lon0 + (lon1 - lon0) * i / steps
        wet = not point_in(all_land, px(lon, lat))
        if wet:
            run = (run[0], lon) if run else (lon, lon)
            if best is None or abs(run[1] - run[0]) > abs(best[1] - best[0]):
                best = run
        else:
            run = None
    return px((best[0] + best[1]) / 2, lat) if best else None

WATER = [  # name, latitude (two for the angle), lon scan window
    ("Hudson River", (40.775, 40.815), (-74.03, -73.95)),
    ("East River", (40.725, 40.745), (-73.985, -73.94)),
    ("Harlem River", None, None),
    ("Upper New York Bay", (40.660, 40.660), (-74.08, -74.02)),
    ("Jamaica Bay", (40.615, 40.615), (-73.88, -73.79)),
    ("Lower New York Bay", (40.555, 40.555), (-74.06, -73.98)),
    ("Long Island Sound", (40.815, 40.815), (-73.80, -73.74)),
]
for name, lats, lons in WATER:
    if name == "Harlem River":
        # runs north–south: scan along longitude instead
        pts = []
        for lat in (40.825, 40.845):
            best, run = None, None
            for i in range(241):
                lon = -73.95 + 0.04 * i / 240
                wet = not point_in(all_land, px(lon, lat))
                run = ((run[0], lon) if run else (lon, lon)) if wet else None
                if run and (best is None or run[1] - run[0] > best[1] - best[0]): best = run
            if best: pts.append(px((best[0] + best[1]) / 2, lat))
    else:
        pts = [p for p in (water_mid(lat, *lons) for lat in sorted(set(lats))) if p]
    if not pts:
        continue
    x = sum(p[0] for p in pts) / len(pts); y = sum(p[1] for p in pts) / len(pts)
    rot = 0
    if len(pts) == 2:
        (x1, y1), (x2, y2) = pts
        rot = math.degrees(math.atan2(y2 - y1, x2 - x1))
        if rot > 90: rot -= 180
        if rot < -90: rot += 180
    if point_in(all_land, (x, y)):  # a narrow, curving river: use one scanned midpoint instead of the average
        x, y = pts[0]
    if not point_in(all_land, (x, y)):
        labels.append({"t": name, "k": "water", "x": round(x, 1), "y": round(y, 1), "r": round(rot, 1)})

out = {
    "attribution": "Basemap: NYC Dept. of City Planning (borough boundaries, 2020 NTAs), NYC Parks (parks), US Census Bureau (counties) · NYC Open Data",
    "land": land, "parks": parks, "labels": labels,
}
json.dump(out, open(OUT, "w"), separators=(",", ":"))
print(OUT, os.path.getsize(OUT), "bytes;", len(land), "land layers,", len(parks), "parks,", len(labels), "labels")
for k, v in matched.items():
    print(f"  {k:20} ← {', '.join(v)}")
print("  water:", [l["t"] for l in labels if l["k"] == "water"])
print("  boroughs:", [(l["t"], l["r"]) for l in labels if l["k"] == "borough"])
