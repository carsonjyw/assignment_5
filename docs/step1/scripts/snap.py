"""Fetch every MTA subway GTFS-RT feed once, decode it, and save a JSON snapshot.
Usage: python snap.py <label>   -> writes snap_<label>.json and raw/<label>_<feed>.pb
"""
import json, sys, time, urllib.request, os
from datetime import datetime, timezone
from google.transit import gtfs_realtime_pb2
from google.protobuf.unknown_fields import UnknownFieldSet

BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F"
FEEDS = ["gtfs", "gtfs-ace", "gtfs-bdfm", "gtfs-g", "gtfs-jz", "gtfs-l", "gtfs-nqrw", "gtfs-si"]
HERE = os.path.dirname(os.path.abspath(__file__))
DIR = {1: "NORTH", 2: "EAST", 3: "SOUTH", 4: "WEST"}


def varint(b, i):
    n = s = 0
    while True:
        c = b[i]; i += 1
        n |= (c & 0x7F) << s; s += 7
        if c < 0x80:
            return n, i


def raw_fields(b):
    """Minimal protobuf wire parser: {field_number: value} for varint and length-delimited fields."""
    out, i = {}, 0
    while i < len(b):
        key, i = varint(b, i)
        num, wt = key >> 3, key & 7
        if wt == 0:
            v, i = varint(b, i)
        elif wt == 2:
            ln, i = varint(b, i)
            v = b[i:i + ln].decode(errors="replace"); i += ln
        elif wt == 5:
            v = int.from_bytes(b[i:i + 4], "little"); i += 4
        elif wt == 1:
            v = int.from_bytes(b[i:i + 8], "little"); i += 8
        else:
            break
        out[num] = v
    return out


def ext(msg, field=1001):
    """Decode the NYCT extension (field 1001, from nyct-subway.proto) out of the unknown fields."""
    for f in UnknownFieldSet(msg):
        if f.field_number == field:
            return raw_fields(f.data)
    return {}


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None


def fetch(feed):
    t0 = time.time()
    with urllib.request.urlopen(BASE + feed, timeout=20) as r:
        body = r.read()
        status = r.status
    return t0, time.time(), status, body


def main(label):
    snap = {"label": label, "feeds": {}}
    for feed in FEEDS:
        t0, t1, status, body = fetch(feed)
        open(os.path.join(HERE, "raw", f"{label}_{feed}.pb"), "wb").write(body)
        m = gtfs_realtime_pb2.FeedMessage()
        m.ParseFromString(body)
        hx = ext(m.header)
        trips, vehicles, alerts = [], 0, 0
        for e in m.entity:
            if e.HasField("vehicle"):
                vehicles += 1
            if e.HasField("alert"):
                alerts += 1
            if not e.HasField("trip_update"):
                continue
            tu = e.trip_update
            tx = ext(tu.trip)  # 1=train_id 2=is_assigned 3=direction
            stus = []
            for s in tu.stop_time_update:
                sx = ext(s)  # 1=scheduled_track 2=actual_track
                stus.append({
                    "stop_id": s.stop_id,
                    "arrival": s.arrival.time if s.HasField("arrival") else None,
                    "departure": s.departure.time if s.HasField("departure") else None,
                    "sched_track": sx.get(1), "actual_track": sx.get(2),
                })
            trips.append({
                "entity_id": e.id, "trip_id": tu.trip.trip_id, "route_id": tu.trip.route_id,
                "start_date": tu.trip.start_date, "start_time": tu.trip.start_time,
                "train_id": tx.get(1), "is_assigned": bool(tx.get(2)),
                "direction": DIR.get(tx.get(3), tx.get(3)), "stops": stus,
            })
        snap["feeds"][feed] = {
            "request_start_utc": iso(t0), "request_start_epoch": round(t0, 3),
            "latency_ms": round((t1 - t0) * 1000), "http": status, "bytes": len(body),
            "gtfs_realtime_version": m.header.gtfs_realtime_version,
            "feed_timestamp": m.header.timestamp, "feed_timestamp_utc": iso(m.header.timestamp),
            "feed_age_s_at_request": round(t0 - m.header.timestamp, 1),
            "nyct_header": hx, "entities": len(m.entity), "trip_updates": len(trips),
            "vehicles": vehicles, "alerts": alerts,
            "routes": sorted({t["route_id"] for t in trips}), "trips": trips,
        }
        f = snap["feeds"][feed]
        print(f"{feed:10} http={status} {len(body):>7}B feed_ts={f['feed_timestamp_utc']} "
              f"age={f['feed_age_s_at_request']:>5}s trips={len(trips):>3} veh={vehicles:>3} "
              f"alerts={alerts} routes={','.join(f['routes'])}")
    json.dump(snap, open(os.path.join(HERE, f"snap_{label}.json"), "w"), indent=1)


if __name__ == "__main__":
    main(sys.argv[1])
