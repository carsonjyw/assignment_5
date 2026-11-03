"""Generate the static MTA seed migration (routes, stations, platforms, route_stops).

Inputs come from MTA's static GTFS (https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip, unzipped)
and Stations.csv (https://web.mta.info/developers/data/nyct/subway/Stations.csv).

Usage:
  python3 scripts/generate_static_seed.py <gtfs_dir> <Stations.csv> supabase/migrations/20261103190300
  -> writes …190300_seed_routes_stations_a.sql, …190305_seed_stations_b.sql, …190310_seed_platforms.sql, …190320_seed_route_stops.sql
"""
import collections
import csv
import json
import os
import sys

FEED = {
    'gtfs': ['1', '2', '3', '4', '5', '6', '6X', '7', '7X', 'GS'],
    'gtfs-ace': ['A', 'C', 'E', 'H'],
    'gtfs-bdfm': ['B', 'D', 'F', 'FX', 'M', 'FS'],
    'gtfs-g': ['G'],
    'gtfs-jz': ['J', 'Z'],
    'gtfs-l': ['L'],
    'gtfs-nqrw': ['N', 'Q', 'R', 'W'],
    'gtfs-si': ['SI'],
}
ROUTE_FEED = {r: f for f, rs in FEED.items() for r in rs}


def main(gtfs_dir, stations_csv, out_prefix):
    read = lambda name: list(csv.DictReader(open(os.path.join(gtfs_dir, name), encoding='utf-8-sig')))
    stops = {r['stop_id']: r for r in read('stops.txt')}
    routes = read('routes.txt')
    trips = {r['trip_id']: r for r in read('trips.txt')}
    mta = list(csv.DictReader(open(stations_csv, encoding='utf-8-sig')))

    by_gtfs = {r['GTFS Stop ID']: r for r in mta}
    complex_of = {gid: int(r['Complex ID']) for gid, r in by_gtfs.items()}

    # ---- routes
    unknown = [r['route_id'] for r in routes if r['route_id'] not in ROUTE_FEED]
    if unknown:
        sys.exit(f'routes without a feed mapping: {unknown}')
    route_rows = []
    for i, r in enumerate(sorted(routes, key=lambda r: int(r.get('route_sort_order') or 999))):
        route_rows.append((r['route_id'], r['route_short_name'] or r['route_id'], r['route_long_name'],
                           (r.get('route_color') or '808183').upper(), (r.get('route_text_color') or 'FFFFFF').upper(),
                           ROUTE_FEED[r['route_id']], i + 1))
    sort_of = {r[0]: r[6] for r in route_rows}

    # ---- route_stops from the static schedule: longest pattern first, then branches
    patterns = collections.defaultdict(list)
    for st in read('stop_times.txt'):
        patterns[st['trip_id']].append((int(st['stop_sequence']), st['stop_id']))
    by_route = collections.defaultdict(list)
    for tid, seq in patterns.items():
        t = trips.get(tid)
        if t:
            by_route[t['route_id']].append([s for _, s in sorted(seq)])
    route_stop_rows = []
    station_routes = collections.defaultdict(set)
    for rid, pats in by_route.items():
        # one direction only (stop ids end in N or S): pick the direction of the longest pattern
        pats.sort(key=len, reverse=True)
        suffix = pats[0][0][-1]
        order = []
        for p in pats:
            if p[0][-1] != suffix:
                continue
            for sid in p:
                cid = complex_of.get(stops[sid]['parent_station'])
                if cid is not None and cid not in order:
                    order.append(cid)
        for i, cid in enumerate(order):
            route_stop_rows.append((rid, cid, i + 1))
            station_routes[cid].add(rid)

    # ---- stations (complexes)
    members = collections.defaultdict(list)
    for r in mta:
        members[int(r['Complex ID'])].append(r)
    station_rows = []
    for cid, rs in sorted(members.items()):
        names = collections.Counter(r['Stop Name'] for r in rs)
        top = max(names.items(), key=lambda kv: (kv[1], max(len(r['Daytime Routes'].split()) for r in rs if r['Stop Name'] == kv[0])))[0]
        lat = round(sum(float(r['GTFS Latitude']) for r in rs) / len(rs), 6)
        lon = round(sum(float(r['GTFS Longitude']) for r in rs) / len(rs), 6)
        rlist = sorted(station_routes.get(cid, set()), key=lambda x: sort_of.get(x, 999))
        search = ' / '.join(sorted({r['Stop Name'] for r in rs})).lower()
        station_rows.append((cid, top, rs[0]['Borough'], rlist, lat, lon, search))

    # ---- platforms: every directional GTFS stop whose parent is an MTA station
    platform_rows = []
    for sid, s in sorted(stops.items()):
        if s.get('location_type') not in ('', '0') or not s.get('parent_station'):
            continue
        m = by_gtfs.get(s['parent_station'])
        if not m or sid[-1] not in 'NS':
            continue
        d = sid[-1]
        label = m['North Direction Label'] if d == 'N' else m['South Direction Label']
        label = label.strip() or ('Northbound' if d == 'N' else 'Southbound')
        platform_rows.append((sid, s['parent_station'], int(m['Complex ID']), d, label, m['Line']))

    # Compact JSON payload (repeated labels/lines stored once) unpacked by SQL; keeps the migration small
    labels, lines = [], []
    def idx(lst, v):
        if v not in lst:
            lst.append(v)
        return lst.index(v)
    parents = collections.OrderedDict()
    for sid, parent, cid, d, label, line in platform_rows:
        e = parents.setdefault(parent, [parent, cid, None, None, idx(lines, line)])
        e[2 if d == 'N' else 3] = idx(labels, label)
    missing = [p for p, e in parents.items() if e[2] is None or e[3] is None]
    if missing:
        sys.exit(f'stations without both N and S platforms: {missing}')
    by_route_seq = collections.defaultdict(list)
    for rid, cid, seq in route_stop_rows:
        by_route_seq[rid].append(cid)
    names_of = collections.defaultdict(set)
    for r in mta:
        names_of[int(r['Complex ID'])].add(r['Stop Name'])
    payload = {
        'routes': [list(r) for r in route_rows],
        'labels': labels,
        'lines': lines,
        'stations': [[cid, name, boro, rl, round(lat, 5), round(lon, 5), sorted(names_of[cid] - {name})]
                     for cid, name, boro, rl, lat, lon, _ in station_rows],
        'stops': list(parents.values()),
        'route_stops': by_route_seq,
    }
    # Three self-contained migrations, each small enough to apply and review on its own
    half = len(payload['stations']) // 2
    parts = [
        (0, 'seed_routes_stations_a', {'routes': payload['routes'], 'stations': payload['stations'][:half]}, SQL_ROUTES_STATIONS),
        (5, 'seed_stations_b', {'routes': [], 'stations': payload['stations'][half:]}, SQL_ROUTES_STATIONS),
        (10, 'seed_platforms', {'labels': labels, 'lines': lines, 'stops': payload['stops']}, SQL_PLATFORMS),
        (20, 'seed_route_stops', {'route_stops': payload['route_stops']}, SQL_ROUTE_STOPS),
    ]
    version = int(os.path.basename(out_prefix))
    for offset, name, data, sql in parts:
        path = os.path.join(os.path.dirname(out_prefix), f'{version + offset}_{name}.sql')
        blob = json.dumps(data, separators=(',', ':'), ensure_ascii=False)
        with open(path, 'w') as out:
            out.write('-- GENERATED by scripts/generate_static_seed.py from MTA static GTFS + Stations.csv. Do not edit by hand.\n'
                      '-- Idempotent (on conflict do nothing) so it can be re-run safely.\n')
            out.write(HEAD.replace('__SEED__', blob) + sql + TAIL)
        print(f'{path}: {os.path.getsize(path)} bytes')
    print(f'routes={len(route_rows)} stations={len(station_rows)} platforms={len(platform_rows)} route_stops={len(route_stop_rows)}')


HEAD = """do $seed$
declare seed jsonb := $json$__SEED__$json$::jsonb;
begin
"""
TAIL = """end $seed$;
"""
SQL_ROUTES_STATIONS = """  insert into public.routes (route_id, short_name, long_name, color, text_color, feed, sort_order)
  select r->>0, r->>1, r->>2, r->>3, r->>4, r->>5, (r->>6)::int from jsonb_array_elements(seed->'routes') r
  on conflict do nothing;

  insert into public.stations (station_id, name, borough, routes, lat, lon, search_text)
  select (s->>0)::int, s->>1, s->>2,
         array(select jsonb_array_elements_text(s->3)),
         (s->>4)::double precision, (s->>5)::double precision,
         lower(concat_ws(' / ', s->>1, (select string_agg(n, ' / ') from jsonb_array_elements_text(s->6) n)))
  from jsonb_array_elements(seed->'stations') s
  on conflict do nothing;
"""
SQL_PLATFORMS = """  insert into public.platforms (stop_id, parent_stop_id, station_id, direction, direction_label, line_name)
  select (p->>0) || dir.dirn, p->>0, (p->>1)::int, dir.dirn,
         seed->'labels'->>((p->>(case dir.dirn when 'N' then 2 else 3 end))::int),
         seed->'lines'->>((p->>4)::int)
  from jsonb_array_elements(seed->'stops') p cross join (values ('N'), ('S')) dir(dirn)
  on conflict do nothing;
"""
SQL_ROUTE_STOPS = """  insert into public.route_stops (route_id, station_id, seq)
  select r.key, x.cid::int, x.seq::int
  from jsonb_each(seed->'route_stops') r
  cross join lateral jsonb_array_elements_text(r.value) with ordinality x(cid, seq)
  on conflict do nothing;
"""


if __name__ == '__main__':
    main(*sys.argv[1:4])
