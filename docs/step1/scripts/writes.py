"""Estimate DB writes between two snapshots under different change-detection strategies.
Usage: python writes.py A C
"""
import json, sys, os, csv, collections

HERE = os.path.dirname(os.path.abspath(__file__))
a_lbl, b_lbl = sys.argv[1], sys.argv[2]
A = json.load(open(os.path.join(HERE, f"snap_{a_lbl}.json")))
B = json.load(open(os.path.join(HERE, f"snap_{b_lbl}.json")))
static = {r["stop_id"] for r in csv.DictReader(open(os.path.join(HERE, "static/sub/stops.txt")))}


def rows(snap):
    out = {}
    for feed, f in snap["feeds"].items():
        for t in f["trips"]:
            for s in t["stops"]:
                ts = s["arrival"] or s["departure"]
                if ts and s["stop_id"] in static:
                    out[(t["trip_id"], s["stop_id"])] = (t["route_id"], ts)
    return out


def boards(r, now, n=3):
    """Per platform stop: next n arrivals after `now` as (route, trip, ts)."""
    b = collections.defaultdict(list)
    for (trip, stop), (route, ts) in r.items():
        if ts >= now:
            b[stop].append((ts, route, trip))
    return {k: sorted(v)[:n] for k, v in b.items()}


ra, rb = rows(A), rows(B)
now_b = max(f["request_start_epoch"] for f in B["feeds"].values())
common = ra.keys() & rb.keys()
print(f"=== {a_lbl} -> {b_lbl}  (gap {now_b - max(f['request_start_epoch'] for f in A['feeds'].values()):.0f}s) ===")
print(f"raw stop-level rows in {b_lbl}: {len(rb)}  (naive 'rewrite everything' = {len(rb)} writes per run)")
any_change = sum(ra[k][1] != rb[k][1] for k in common) + len(rb.keys() - ra.keys())
print(f"stop-level rows changed at all (incl. +/-1s jitter) + new: {any_change}")
for thr in (30, 60):
    c = sum(abs(ra[k][1] - rb[k][1]) >= thr for k in common) + len(rb.keys() - ra.keys())
    print(f"stop-level rows changed >= {thr}s + new: {c}")

ba, bb = boards(ra, now_b), boards(rb, now_b)


def same_board(x, y, thr):
    if [t[2] for t in x] != [t[2] for t in y]:
        return False
    return all(abs(p[0] - q[0]) < thr for p, q in zip(x, y))


print(f"\nplatform boards (next 3 trains per stop_id+direction): {len(bb)}")
for thr in (1, 30, 60):
    ch = sum(not same_board(ba.get(k, []), bb[k], thr) for k in bb)
    print(f"  boards whose content changed (trip set changed or any ETA moved >= {thr}s): {ch}")
