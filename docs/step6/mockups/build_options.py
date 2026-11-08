"""Build transfer-options.html: four ways to draw subway transfers, on HEADWAY's real map data.

Static comparison only; nothing here ships in the app. Geometry and transfer times come from public/data
(MTA GTFS, NYC Open Data, US Census), so every option shows the same real stops, tracks and streets.
Usage: python3 -I docs/step6/mockups/build_options.py   (from the repo root)
"""
import json, math, os, re

ROOT = "public/data"
HERE = "docs/step6/mockups"
m = json.load(open(f"{ROOT}/map.json"))
base = json.load(open(f"{ROOT}/basemap.json"))
index = json.load(open(f"{ROOT}/streets/index.json"))
FOCUS = [611, 602, 628, 613]  # Times Sq, Union Sq, Fulton St, Lexington Av/59 St
R = 95  # map units of streets kept around each station
by_id = {s["id"]: s for s in m["stations"]}
centres = [(by_id[i]["x"], by_id[i]["y"]) for i in FOCUS]
near = lambda x, y: any(math.hypot(x - cx, y - cy) < R for cx, cy in centres)

streets, names = [], []
for key in index["tiles"]:
    col, row = map(int, key.split("_"))
    box = (col * index["size"], row * index["size"])
    if not any(box[0] - R < cx < box[0] + index["size"] + R and box[1] - R < cy < box[1] + index["size"] + R for cx, cy in centres):
        continue
    t = json.load(open(f"{ROOT}/streets/{key}.json"))
    for part in t["d"].split("M")[1:]:
        pts = [float(v) for v in re.split("[L,]", part)]
        if near(pts[0], pts[1]):
            streets.append(pts)
    names += [n for n in t["n"] if near(n[1], n[2])]

data = {
    "w": m["w"], "h": m["h"], "colors": m["colors"], "routes": m["routes"],
    "segs": [{"c": s["c"], "r": s["r"], "d": s["d"]} for s in m["segs"]],
    "stations": [{"id": s["id"], "n": s["name"], "x": s["x"], "y": s["y"], "nodes": s["nodes"], "r": s["routes"]} for s in m["stations"]],
    "complexes": m["complexes"], "walks": m["walks"],
    "land": base["land"], "parks": base["parks"], "labels": base["labels"],
    "streets": streets, "names": names,
}
html = open(f"{HERE}/template.html").read().replace("/*DATA*/null", json.dumps(data, separators=(",", ":")))
open(f"{HERE}/transfer-options.html", "w").write(html)
print(f"transfer-options.html {os.path.getsize(f'{HERE}/transfer-options.html') / 1e6:.2f} MB; {len(streets)} street lines, {len(names)} street names")
