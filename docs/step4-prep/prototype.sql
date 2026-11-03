-- Prototype of the Step 4 commit path, built on pg_temp objects so nothing persists.
-- Placeholders replaced by bench.py: __STATIC__, __PAYLOADS__

create temp table platforms (stop_id text primary key, station_id int not null) on commit drop;
create temp table routes (route_id text primary key, feed text not null) on commit drop;
create temp table platform_boards (
  stop_id text primary key, station_id int not null, trains jsonb not null default '[]',
  run_id bigint not null, updated_at timestamptz not null default now()
) on commit drop;
create temp table worker_runs (
  id bigint generated always as identity primary key, started_at timestamptz not null default now(),
  finished_at timestamptz, lease_expires_at timestamptz not null, status text not null,
  boards_changed int, trains_in int, trains_rejected int, feeds_ok int, error text
) on commit drop;
create unique index worker_runs_one_running on worker_runs ((true)) where status = 'running';
create temp table worker_status (
  id smallint primary key check (id = 1), last_run_id bigint not null default 0,
  last_run_at timestamptz, last_success_at timestamptz, last_status text, last_error text,
  feeds jsonb not null default '{}', boards_changed int
) on commit drop;
insert into worker_status (id) values (1);

-- Approved change rule. True = write the board now.
create function pg_temp.board_changed(o jsonb, n jsonb, now_s bigint) returns boolean
language sql immutable as $$
  select jsonb_array_length(o) <> jsonb_array_length(n)
  or exists (
    select 1
    from jsonb_array_elements(o) with ordinality a(x, i)
    join jsonb_array_elements(n) with ordinality b(y, j) on i = j
    where x->>'trip_id'  is distinct from y->>'trip_id'           -- identity / order / departure
       or x->'live'      is distinct from y->'live'               -- assigned vs scheduled
       or x->>'route_id' is distinct from y->>'route_id'          -- route
       or x->>'headsign' is distinct from y->>'headsign'          -- destination
       or x->>'kind'     is distinct from y->>'kind'              -- arrival vs departure time
       or x->'carried'   is distinct from y->'carried'            -- feed health of this train
       or ((x->>'eta')::bigint - now_s < 60) <> ((y->>'eta')::bigint - now_s < 60)  -- arriving window
       or abs((x->>'eta')::bigint - (y->>'eta')::bigint) >= 30   -- ETA moved >= 30 s
  )
$$;

create function pg_temp.claim_worker_run(p_now timestamptz) returns bigint
language plpgsql as $$
declare v_id bigint;
begin
  perform pg_advisory_xact_lock(hashtext('headway.poll-subway'));
  update worker_runs set status = 'superseded', finished_at = p_now
   where status = 'running' and lease_expires_at < p_now;
  insert into worker_runs (started_at, lease_expires_at, status)
  values (p_now, p_now + interval '30 seconds', 'running')
  on conflict ((true)) where status = 'running' do nothing
  returning id into v_id;
  return v_id;
end $$;

create function pg_temp.commit_worker_run(p_run_id bigint, p_feeds jsonb, p_boards jsonb, p_now timestamptz)
returns jsonb language plpgsql as $$
declare
  v_now_s bigint := extract(epoch from p_now)::bigint;
  v_lease timestamptz; v_status text;
  v_bad text[]; v_empty text[]; v_unmapped text[]; v_mark text[]; v_in int; v_ok int; v_changed int; v_feeds_ok int; v_run_status text;
  c_feeds constant text[] := array['gtfs','gtfs-ace','gtfs-bdfm','gtfs-g','gtfs-jz','gtfs-l','gtfs-nqrw','gtfs-si'];
begin
  -- 1. Structural validation: reject the whole call
  if p_run_id is null or jsonb_typeof(p_feeds) is distinct from 'object' or jsonb_typeof(p_boards) is distinct from 'array' then
    raise exception 'invalid_input: run_id, feeds object and boards array are required';
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(p_feeds) k) is distinct from (select array_agg(f order by f) from unnest(c_feeds) f) then
    raise exception 'invalid_input: feeds must contain exactly the 8 subway feeds';
  end if;
  if jsonb_array_length(p_boards) > 2000 then
    raise exception 'invalid_input: too many boards (%)', jsonb_array_length(p_boards);
  end if;

  -- 2. Lease / fencing on the run itself
  select status, lease_expires_at into v_status, v_lease from worker_runs where id = p_run_id for update;
  if v_status is distinct from 'running' then raise exception 'superseded: run % is %', p_run_id, coalesce(v_status, 'missing'); end if;
  if v_lease < p_now then raise exception 'superseded: lease of run % expired', p_run_id; end if;

  -- 3. Feeds rejected this run: unhealthy, or older than the last accepted MTA timestamp
  select coalesce(array_agg(f.key), '{}') into v_bad
  from jsonb_each(p_feeds) f
  left join lateral (select (ws.feeds->f.key->>'feed_ts')::bigint as prev_ts from worker_status ws where ws.id = 1) p on true
  where coalesce((f.value->>'ok')::boolean, false) = false
     or (f.value->>'feed_ts') is null
     or (p.prev_ts is not null and (f.value->>'feed_ts')::bigint < p.prev_ts);

  -- Format-change guard: a feed whose stop_ids mostly don't match platforms is rejected ('unmapped_spike')
  select coalesce(array_agg(feed), '{}') into v_unmapped from (
    select tr->>'feed' feed, count(*) filter (where pl.stop_id is null)::numeric / count(*) ratio
    from jsonb_array_elements(p_boards) b
    cross join lateral jsonb_array_elements(case when jsonb_typeof(b->'trains') = 'array' then b->'trains' else '[]' end) tr
    left join platforms pl on pl.stop_id = b->>'stop_id'
    group by 1) x
  where ratio > 0.2 and feed = any (c_feeds);
  v_bad := v_bad || array(select unnest(v_unmapped) except select unnest(v_bad));

  -- 4. Expand + validate incoming trains (invalid entries are dropped and counted)
  create temp table if not exists _in (stop_id text, station_id int, t jsonb, eta bigint, route text, src int) on commit drop;
  truncate _in;
  insert into _in
  select b->>'stop_id', pl.station_id,
         jsonb_build_object('trip_id', tr->>'trip_id', 'route_id', tr->>'route_id', 'eta', (tr->>'eta')::bigint,
                            'kind', tr->>'kind', 'headsign', left(tr->>'headsign', 100), 'live', (tr->>'live')::boolean,
                            'feed', tr->>'feed', 'carried', false),
         (tr->>'eta')::bigint, tr->>'route_id', 0
  from jsonb_array_elements(p_boards) b
  cross join lateral jsonb_array_elements(case when jsonb_typeof(b->'trains') = 'array' then b->'trains' else '[]' end) tr
  join platforms pl on pl.stop_id = b->>'stop_id'
  join routes r on r.route_id = tr->>'route_id' and r.feed = tr->>'feed'        -- route must belong to the claimed feed
  where jsonb_typeof(tr->'eta') = 'number'
    and (tr->>'eta')::bigint between v_now_s - 30 and v_now_s + 5400
    and tr->>'kind' in ('arr', 'dep')
    and jsonb_typeof(tr->'live') = 'boolean'
    and length(coalesce(tr->>'trip_id', '')) between 1 and 64
    and not (tr->>'feed' = any (v_bad));                                         -- never accept trains from a rejected feed
  get diagnostics v_ok = row_count;
  select coalesce(sum(jsonb_array_length(case when jsonb_typeof(b->'trains') = 'array' then b->'trains' else '[]' end)), 0)
    into v_in from jsonb_array_elements(p_boards) b;

  -- A feed reported healthy that contributes no valid trains is treated as unhealthy ('empty'):
  -- protects every board from being blanked by a worker bug or a truncated MTA response
  select coalesce(array_agg(f), '{}') into v_empty from unnest(c_feeds) f
   where not (f = any (v_bad)) and not exists (select 1 from _in where t->>'feed' = f);
  v_bad := v_bad || v_empty;

  -- Feeds failing for a 2nd+ consecutive run: their carried trains get carried=true (one-run blips don't churn boards)
  select coalesce(array_agg(f), '{}') into v_mark from unnest(v_bad) f, worker_status ws
   where ws.id = 1 and coalesce((ws.feeds->f->>'fail_streak')::int, 0) + 1 >= current_setting('headway.carry_after', true)::int;

  -- 5. Carry over stored trains from rejected feeds
  insert into _in
  select pb.stop_id, pb.station_id,
         case when tr->>'feed' = any (v_mark) then tr || '{"carried": true}' else tr end,
         (tr->>'eta')::bigint, tr->>'route_id', 1
  from platform_boards pb cross join lateral jsonb_array_elements(pb.trains) tr
  where tr->>'feed' = any (v_bad) and (tr->>'eta')::bigint >= v_now_s - 30;

  -- 6. Build next-3-per-route boards, 7. diff in SQL, 8. fenced upsert of changed rows only
  with dedup as (
    select distinct on (stop_id, t->>'trip_id') * from _in order by stop_id, t->>'trip_id', src
  ), ranked as (
    select *, row_number() over (partition by stop_id, route order by eta, t->>'trip_id') rn from dedup
  ), built as (
    select stop_id, max(station_id) station_id, jsonb_agg(t order by eta, t->>'trip_id') trains
    from ranked where rn <= 3 group by stop_id
  ), candidates as (
    select coalesce(b.stop_id, pb.stop_id) stop_id, coalesce(b.station_id, pb.station_id) station_id,
           coalesce(b.trains, '[]'::jsonb) new_trains, pb.trains old_trains
    from built b full join platform_boards pb on pb.stop_id = b.stop_id
  ), changed as (
    select * from candidates
    where (old_trains is null and jsonb_array_length(new_trains) > 0)
       or (old_trains is not null and pg_temp.board_changed(old_trains, new_trains, v_now_s))
  ), up as (
    insert into platform_boards as pb (stop_id, station_id, trains, run_id, updated_at)
    select stop_id, station_id, new_trains, p_run_id, p_now from changed
    on conflict (stop_id) do update
      set trains = excluded.trains, run_id = excluded.run_id, updated_at = excluded.updated_at
      where pb.run_id < excluded.run_id                                          -- fencing: newer run wins
    returning 1
  )
  select count(*) into v_changed from up;

  -- 9. Heartbeat + per-feed health (fenced), 10. finish the run log row
  v_feeds_ok := 8 - coalesce(array_length(v_bad, 1), 0);
  v_run_status := case when v_feeds_ok = 8 then 'ok' when v_feeds_ok > 0 then 'partial' else 'error' end;
  update worker_status ws set
    last_run_id = p_run_id, last_run_at = p_now, last_status = v_run_status,
    last_success_at = case when v_feeds_ok > 0 then p_now else ws.last_success_at end,
    boards_changed = v_changed,
    feeds = (select jsonb_object_agg(f.key, jsonb_build_object(
               'ok', not (f.key = any (v_bad)),
               'feed_ts', case when f.key = any (v_bad) then ws.feeds->f.key->'feed_ts' else f.value->'feed_ts' end,
               'reason', case when f.key = any (v_unmapped) then 'unmapped_spike' when f.key = any (v_empty) then 'empty'
                              when f.key = any (v_bad) then coalesce(f.value->>'reason', 'not_newer') end,
               'last_ok_at', case when f.key = any (v_bad) then ws.feeds->f.key->'last_ok_at' else to_jsonb(p_now) end,
               'fail_streak', case when f.key = any (v_bad) then coalesce((ws.feeds->f.key->>'fail_streak')::int, 0) + 1 else 0 end))
             from jsonb_each(p_feeds) f)
  where ws.id = 1 and ws.last_run_id < p_run_id;
  update worker_runs set status = v_run_status, finished_at = p_now, boards_changed = v_changed,
         trains_in = v_in, trains_rejected = v_in - v_ok, feeds_ok = v_feeds_ok
   where id = p_run_id;
  return jsonb_build_object('run_id', p_run_id, 'status', v_run_status, 'boards_changed', v_changed,
                            'trains_in', v_in, 'trains_rejected', v_in - v_ok, 'feeds_rejected', v_bad, 'feeds_empty', v_empty);
end $$;
