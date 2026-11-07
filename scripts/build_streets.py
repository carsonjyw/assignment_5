"""Build public/data/streets/: the NYC street grid as tiles, in the SAME projection as map.json.

Source: NYC Office of Technology and Innovation, Street Centerline (CSCL), NYC Open Data inkn-q76z.
Constructed streets, highways and bridges only (status 2, rw_type 1/2/3). Nothing is drawn by hand.
Tiles keep the download small: the map fetches only what's in view, and only when zoomed in.

Input: one or more JSON pages of {the_geom, stname_label, rw_type} rows from the Socrata API.
Usage: python3 -I scripts/build_streets.py public/data/map.json public/data/streets <page.json> [...]
"""
import collections, json, math, os, re, shutil, sys

MAP, OUT, *PAGES = sys.argv[1:]
P = json.load(open(MAP))["proj"]
px = lambda lon, lat: ((lon * P["kx"] - P["minx"]) * P["s"], (P["maxy"] - lat) * P["s"])
TILE = 120  # map units (about 5 km)
MIN_LABEL_LEN = 1.5  # map units: don't label a stub
LABEL_SPACING = 40  # map units between repeats of one street's name (about 1.7 km)

KEEP_UPPER = {"FDR", "JFK", "NY", "US", "SR", "CPW", "II", "III", "MLK"}
def pretty(name):
    return " ".join(w if w in KEEP_UPPER or w[0].isdigit() else w.capitalize() for w in name.split()) if name else None

tiles = collections.defaultdict(lambda: {"parts": [], "names": {}})
count = 0
for page in PAGES:
    for row in json.load(open(page)):
        geom = row.get("the_geom")
        if not geom:
            continue
        lines = geom["coordinates"] if geom["type"] == "MultiLineString" else [geom["coordinates"]]
        name = pretty(row.get("stname_label"))
        for line in lines:
            pts = [px(*c[:2]) for c in line]
            if len(pts) < 2:
                continue
            count += 1
            mx, my = pts[len(pts) // 2 - 1 if len(pts) % 2 == 0 else len(pts) // 2]
            key = f"{math.floor(mx / TILE)}_{math.floor(my / TILE)}"
            t = tiles[key]
            t["parts"].append("M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in pts))
            if name:
                # repeat a street's name along its length, so it's named wherever you're zoomed in
                for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
                    if math.hypot(x2 - x1, y2 - y1) < MIN_LABEL_LEN:
                        continue
                    x, y = (x1 + x2) / 2, (y1 + y2) / 2
                    placed = t["names"].setdefault(name, [])
                    if all(math.hypot(x - px_, y - py_) >= LABEL_SPACING for px_, py_, _ in placed):
                        rot = math.degrees(math.atan2(y2 - y1, x2 - x1))
                        rot = rot - 180 if rot > 90 else rot + 180 if rot < -90 else rot
                        placed.append((round(x, 1), round(y, 1), round(rot, 1)))

shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT)
total = 0
for key, t in tiles.items():
    body = {"d": "".join(t["parts"]), "n": [[n, x, y, r] for n, places in t["names"].items() for x, y, r in places]}
    path = os.path.join(OUT, f"{key}.json")
    json.dump(body, open(path, "w"), separators=(",", ":"))
    total += os.path.getsize(path)
json.dump({"size": TILE, "tiles": sorted(tiles),
           "source": "NYC OTI Street Centerline (CSCL), NYC Open Data inkn-q76z"}, open(os.path.join(OUT, "index.json"), "w"), separators=(",", ":"))
sizes = sorted(os.path.getsize(os.path.join(OUT, f"{k}.json")) for k in tiles)
print(f"{count} lines, {len(tiles)} tiles, {total / 1e6:.2f} MB total, largest tile {sizes[-1] / 1e3:.0f} KB")
