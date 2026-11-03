"""Generate bench.sql: prototype functions + a driver that replays real snapshots, all rolled back.
Usage: python bench.py <carry_after>   -> writes bench_<carry_after>.sql
"""
import json, csv, collections, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
carry_after = int(sys.argv[1]) if len(sys.argv) > 1 else 2

stops = {r['stop_id']: r for r in csv.DictReader(open(os.path.join(ROOT, 'static/sub/stops.txt')))}
cx = {r['GTFS Stop ID']: int(r['Complex ID']) for r in csv.DictReader(open(os.path.join(ROOT, 'static/Stations.csv')))}
plat = [[k, cx[v['parent_station']]] for k, v in stops.items() if v['location_type'] == '' and v['parent_station'] in cx]
pset = {p[0] for p in plat}
FEED = {'gtfs': ['1', '2', '3', '4', '5', '6', '6X', '7', '7X', 'GS'], 'gtfs-ace': ['A', 'C', 'E', 'H'],
        'gtfs-bdfm': ['B', 'D', 'F', 'FX', 'M', 'FS'], 'gtfs-g': ['G'], 'gtfs-jz': ['J', 'Z'], 'gtfs-l': ['L'],
        'gtfs-nqrw': ['N', 'Q', 'R', 'W'], 'gtfs-si': ['SI']}
FEEDS = list(FEED)
routes = [[r, f] for f, rs in FEED.items() for r in rs]
heads = []


def compact(lbl):
    s = json.load(open(os.path.join(ROOT, f'snap_{lbl}.json')))
    now = int(max(f['request_start_epoch'] for f in s['feeds'].values()))
    feeds = {fd: f['feed_timestamp'] for fd, f in s['feeds'].items()}
    b = collections.defaultdict(list)
    for fd, f in s['feeds'].items():
        for t in f['trips']:
            if not t['stops']:
                continue
            h = stops.get(t['stops'][-1]['stop_id'][:-1], {}).get('stop_name', '?')
            if h not in heads:
                heads.append(h)
            for x in t['stops']:
                eta = x['arrival'] or x['departure']
                if not eta or x['stop_id'] not in pset or eta < now - 30 or eta > now + 5400:
                    continue
                b[x['stop_id']].append([t['trip_id'], t['route_id'], eta, 0 if x['arrival'] else 1,
                                        heads.index(h), 1 if t['is_assigned'] else 0, FEEDS.index(fd)])
    boards = []
    for k, v in b.items():
        v.sort(key=lambda r: (r[2], r[0]))
        c = collections.Counter(); keep = []
        for r in v:
            if c[r[1]] < 3:
                keep.append(r); c[r[1]] += 1
        boards.append([k, keep])
    return {'now': now, 'feeds': feeds, 'b': boards}


snaps = {l: compact(l) for l in 'ABCDE'}
data = {'platforms': plat, 'routes': routes, 'heads': heads, 'feeds': FEEDS, 'snaps': snaps}

driver = r'''
do $drv$
declare
  D jsonb := $J$__DATA__$J$::jsonb;
  out text := ''; r bigint; res jsonb; t0 timestamptz; ms numeric; v jsonb; bad_feeds jsonb; nowt timestamptz;
  watch int[]; n_watch int; avg_row numeric; err text;
  function_note text;
begin
  perform set_config('headway.carry_after', '__CARRY__', true);
  insert into platforms select p->>0, (p->>1)::int from jsonb_array_elements(D->'platforms') p;
  insert into routes select x->>0, x->>1 from jsonb_array_elements(D->'routes') x;
  -- the stations a sample rider follows: Times Sq (127S), 125 St (A15S), Union Sq (L03N)
  select array_agg(distinct station_id) into watch from platforms where stop_id in ('127S', 'A15S', 'L03N');

  for v in select * from jsonb_array_elements(jsonb_build_array(
      jsonb_build_object('label','A initial fill','snap','A','dt',0,'fail','[]'::jsonb),
      jsonb_build_object('label','B (+62 s after A)','snap','B','dt',0,'fail','[]'::jsonb),
      jsonb_build_object('label','C (+264 s after B)','snap','C','dt',0,'fail','[]'::jsonb),
      jsonb_build_object('label','D (live, +55 min)','snap','D','dt',0,'fail','[]'::jsonb),
      jsonb_build_object('label','E (live, +15 s after D)','snap','E','dt',0,'fail','[]'::jsonb),
      jsonb_build_object('label','E +15 s, gtfs feed fails (1st run)','snap','E','dt',15,'fail','["gtfs"]'::jsonb),
      jsonb_build_object('label','E +30 s, gtfs feed fails (2nd run)','snap','E','dt',30,'fail','["gtfs"]'::jsonb),
      jsonb_build_object('label','E +45 s, gtfs recovers','snap','E','dt',45,'fail','[]'::jsonb),
      jsonb_build_object('label','E +45 s, identical replay','snap','E','dt',45,'fail','[]'::jsonb),
      jsonb_build_object('label','E +60 s, L feed stop_ids renamed (format change)','snap','E','dt',60,'fail','[]'::jsonb,'rename','gtfs-l'),
      jsonb_build_object('label','B replayed late (older MTA timestamps)','snap','B','dt',-9999,'fail','[]'::jsonb)))
  loop
    declare
      s jsonb := D->'snaps'->(v->>'snap');
      boards jsonb; feeds jsonb;
    begin
      nowt := to_timestamp((s->>'now')::bigint + greatest((v->>'dt')::int, 0)) + case when (v->>'dt')::int = -9999 then interval '60 seconds' else interval '0' end;
      if (v->>'dt')::int = -9999 then nowt := to_timestamp((D->'snaps'->'E'->>'now')::bigint + 60); end if;
      select jsonb_object_agg(f.key, jsonb_build_object('ok', not (v->'fail' ? f.key), 'feed_ts', f.value,
               'reason', case when v->'fail' ? f.key then 'timeout' end))
        into feeds from jsonb_each(s->'feeds') f;
      select jsonb_agg(jsonb_build_object('stop_id', b->>0, 'trains',
               (select jsonb_agg(jsonb_build_object('trip_id', t->>0, 'route_id', t->>1, 'eta', (t->>2)::bigint,
                  'kind', case when t->>3 = '0' then 'arr' else 'dep' end, 'headsign', D->'heads'->>((t->>4)::int),
                  'live', t->>5 = '1', 'feed', D->'feeds'->>((t->>6)::int))) from jsonb_array_elements(b->1) t)))
        into boards from jsonb_array_elements(s->'b') b;
      -- worker would not send trains from a feed it couldn't fetch
      select jsonb_agg(jsonb_build_object('stop_id', b->>'stop_id', 'trains',
               coalesce((select jsonb_agg(t) from jsonb_array_elements(b->'trains') t where not (v->'fail' ? (t->>'feed'))), '[]')))
        into boards from jsonb_array_elements(boards) b;

      if v ? 'rename' then
        select jsonb_agg(case when exists (select 1 from jsonb_array_elements(x->'trains') t where t->>'feed' = v->>'rename')
                              then jsonb_set(x, '{stop_id}', to_jsonb('Z' || (x->>'stop_id'))) else x end)
          into boards from jsonb_array_elements(boards) x;
      end if;
      r := pg_temp.claim_worker_run(nowt);
      t0 := clock_timestamp();
      res := pg_temp.commit_worker_run(r, feeds, boards, nowt);
      ms := round(extract(epoch from clock_timestamp() - t0)::numeric * 1000, 1);
      select count(*) into n_watch from platform_boards where run_id = r and station_id = any (watch);
      select round(avg(length(trains::text) + 80)) into avg_row from platform_boards where run_id = r;
      out := out || format(E'\n%-42s run=%s %-7s changed=%-4s carried=%-4s watched_changed=%-2s avg_row=%sB commit=%sms reply=%sB rejected_trains=%s feeds_rejected=%s',
        v->>'label', r, res->>'status', res->>'boards_changed',
        (select count(*) from platform_boards pb, jsonb_array_elements(pb.trains) t where (t->>'carried')::boolean),
        n_watch, coalesce(avg_row::text, '-'), ms, length(res::text), res->>'trains_rejected', res->'feeds_rejected');
    end;
  end loop;

  -- Concurrency + validation checks
  r := pg_temp.claim_worker_run(nowt + interval '60 seconds');
  out := out || format(E'\nclaim A=%s', r);
  out := out || format(' | overlapping claim=%s', coalesce(pg_temp.claim_worker_run(nowt + interval '61 seconds')::text, 'null'));
  begin
    perform pg_temp.commit_worker_run(r - 1,
      (select jsonb_object_agg(f, jsonb_build_object('ok', true, 'feed_ts', 9999999999)) from jsonb_array_elements_text(D->'feeds') f),
      '[]'::jsonb, nowt + interval '62 seconds');
  exception when others then err := sqlerrm; end;
  out := out || format(E'\nstale run %s commit -> %s', r - 1, err);
  begin
    perform pg_temp.commit_worker_run(r, '{"gtfs":{}}'::jsonb, '[]'::jsonb, nowt + interval '62 seconds');
  exception when others then err := sqlerrm; end;
  out := out || format(E'\nbad feeds object -> %s', err);
  res := pg_temp.commit_worker_run(r,
    (select jsonb_object_agg(f, jsonb_build_object('ok', true, 'feed_ts', 9999999999)) from jsonb_array_elements_text(D->'feeds') f),
    '[{"stop_id":"127S","trains":[{"trip_id":"x","route_id":"A","eta":1,"kind":"arr","live":true,"feed":"gtfs"}]},{"stop_id":"NOPE","trains":[]}]'::jsonb,
    nowt + interval '62 seconds');
  out := out || format(E'\nall feeds "ok" but only invalid trains (route/feed mismatch, bad eta, unknown stop) -> status=%s rejected_trains=%s feeds_empty=%s changed=%s', res->>'status', res->>'trains_rejected', jsonb_array_length(res->'feeds_empty'), res->>'boards_changed');
  out := out || format(E'\n  -> boards empty=%s of %s, boards with only carried trains=%s', (select count(*) from platform_boards where trains = '[]'), (select count(*) from platform_boards),
     (select count(*) from platform_boards pb where jsonb_array_length(trains) > 0 and not exists (select 1 from jsonb_array_elements(pb.trains) t where not (t->>'carried')::boolean)));
  out := out || format(E'\nworker_runs rows=%s statuses=%s', (select count(*) from worker_runs),
                       (select jsonb_object_agg(status, n) from (select status, count(*) n from worker_runs group by 1) x));
  out := out || format(E'\nworker_status reply size=%sB', (select length(to_jsonb(ws)::text) from worker_status ws));
  raise exception 'BENCH (rolled back, carry_after=__CARRY__):%', out;
end $drv$;
'''
proto = open(os.path.join(HERE, 'prototype.sql')).read()
sql = 'begin;\n' + proto + driver.replace('__DATA__', json.dumps(data, separators=(',', ':'))).replace('__CARRY__', str(carry_after))
open(os.path.join(HERE, f'bench_{carry_after}.sql'), 'w').write(sql)
print(f'bench_{carry_after}.sql', len(sql), 'bytes')
