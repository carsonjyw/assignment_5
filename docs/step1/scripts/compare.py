"""Compare two snapshots keyed by (trip_id, stop_id).
Usage: python compare.py A C
"""
import json, sys, os, collections, csv
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
a_lbl, b_lbl = sys.argv[1], sys.argv[2]
A = json.load(open(os.path.join(HERE, f"snap_{a_lbl}.json")))
B = json.load(open(os.path.join(HERE, f"snap_{b_lbl}.json")))
names = {r["stop_id"]: r["stop_name"] for r in csv.DictReader(open(os.path.join(HERE, "static/sub/stops.txt")))}
hhmmss = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%H:%M:%S") if t else "-"


def index(snap):
    rows, trips = {}, {}
    for feed, f in snap["feeds"].items():
        for t in f["trips"]:
            trips[t["trip_id"]] = (feed, t)
            for s in t["stops"]:
                rows[(t["trip_id"], s["stop_id"])] = (feed, t, s)
    return rows, trips


ra, ta = index(A)
rb, tb = index(B)
print(f"=== {a_lbl} -> {b_lbl} ===")
for feed in A["feeds"]:
    fa, fb = A["feeds"][feed], B["feeds"][feed]
    print(f"{feed:10} feed_ts {fa['feed_timestamp_utc'][11:19]} -> {fb['feed_timestamp_utc'][11:19]} "
          f"(+{fb['feed_timestamp'] - fa['feed_timestamp']}s)  trips {fa['trip_updates']} -> {fb['trip_updates']}")

new_trips = set(tb) - set(ta)
gone_trips = set(ta) - set(tb)
common_trips = set(ta) & set(tb)
print(f"\ntrips: common={len(common_trips)} new={len(new_trips)} disappeared={len(gone_trips)}")

# per (trip, stop) comparison
same = changed = 0
passed = 0      # stop present in A but dropped from B on a trip still running -> train passed it
added_stops = 0
deltas = []
feed_change = collections.Counter(); feed_total = collections.Counter()
for key, (feed, t, s) in ra.items():
    if key[0] not in common_trips:
        continue
    if key not in rb:
        passed += 1
        continue
    s2 = rb[key][2]
    feed_total[feed] += 1
    t1 = s["arrival"] or s["departure"]; t2 = s2["arrival"] or s2["departure"]
    if t1 == t2 and s["departure"] == s2["departure"]:
        same += 1
    else:
        changed += 1; feed_change[feed] += 1
        deltas.append((t2 - t1, feed, t, s, s2))
for key in rb:
    if key[0] in common_trips and key not in ra:
        added_stops += 1

print(f"(trip,stop) pairs on common trips: unchanged={same} prediction_changed={changed} "
      f"dropped(passed)={passed} added={added_stops}")
print("changed share by feed:", {f: f"{feed_change[f]}/{feed_total[f]}" for f in feed_total})
d = sorted(x[0] for x in deltas)
if d:
    print(f"delta seconds: min={d[0]} median={d[len(d)//2]} max={d[-1]} later={sum(x>0 for x in d)} earlier={sum(x<0 for x in d)}")

# sample rows: biggest delays, biggest gains, and a typical one
print("\nSAMPLES (arrival A -> arrival B, delta):")
deltas.sort(key=lambda x: x[0])
picks = deltas[:3] + deltas[len(deltas)//2: len(deltas)//2 + 2] + deltas[-3:]
for dl, feed, t, s, s2 in picks:
    print(f"  [{feed}] route {t['route_id']:>2} trip {t['trip_id']:<22} {str(t['direction']):<5} stop {s['stop_id']:<5} "
          f"{names.get(s['stop_id'], '?')[:28]:<28} arr {hhmmss(s['arrival'])} -> {hhmmss(s2['arrival'])}  ({dl:+d}s)")

# track one trip end to end
if deltas:
    tid = deltas[len(deltas)//2][2]["trip_id"]
    feed, t1 = ta[tid]; _, t2 = tb[tid]
    print(f"\nFULL TRIP {tid} route {t1['route_id']} {t1['direction']} train_id={t1['train_id']!r}")
    s2map = {s["stop_id"]: s for s in t2["stops"]}
    for s in t1["stops"][:10]:
        o = s2map.get(s["stop_id"])
        print(f"  {s['stop_id']:<5} {names.get(s['stop_id'], '?')[:26]:<26} {hhmmss(s['arrival'])} -> "
              f"{hhmmss(o['arrival']) if o else 'GONE (passed)'}"
              + (f"  ({(o['arrival'] or 0) - (s['arrival'] or 0):+d}s)" if o and s['arrival'] and o['arrival'] else ""))
json.dump([{"delta": x[0], "feed": x[1], "trip_id": x[2]["trip_id"], "route": x[2]["route_id"],
            "stop_id": x[3]["stop_id"], "arr_a": x[3]["arrival"], "arr_b": x[4]["arrival"]} for x in deltas],
          open(os.path.join(HERE, f"diff_{a_lbl}_{b_lbl}.json"), "w"))
