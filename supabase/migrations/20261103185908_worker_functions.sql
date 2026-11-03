-- Worker functions (docs/step3/DATA_FLOW.md §3). The Edge Function calls these over PostgREST with the
-- service_role key; nobody else can execute them. The worker never reads tables: all comparison happens here.

-- ---------------------------------------------------------------- change rule
-- True when the stored board must be rewritten. Both arrays are sorted by (eta, trip_id).
create function public.board_changed(o jsonb, n jsonb, now_s bigint) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_array_length(o) <> jsonb_array_length(n)                          -- prediction appeared / disappeared
  or exists (
    select 1
    from jsonb_array_elements(o) with ordinality a(x, i)
    join jsonb_array_elements(n) with ordinality b(y, j) on i = j
    where x->>'trip_id'  is distinct from y->>'trip_id'                            -- identity / order / departure
       or x->'live'      is distinct from y->'live'                                -- assigned vs scheduled
       or x->>'route_id' is distinct from y->>'route_id'                           -- route
       or x->>'headsign' is distinct from y->>'headsign'                           -- destination
       or x->>'kind'     is distinct from y->>'kind'                               -- arrival vs departure time
       or x->'carried'   is distinct from y->'carried'                             -- feed health of this train
       or ((x->>'eta')::bigint - now_s < 60) <> ((y->>'eta')::bigint - now_s < 60) -- arriving window
       or abs((x->>'eta')::bigint - (y->>'eta')::bigint) >= 30                     -- ETA moved >= 30 s
  )
$$;

-- ---------------------------------------------------------------- claim
-- Returns a new run id (the fencing token), or null when another live run holds the lease.
create function public.claim_worker_run(p_now timestamptz default now()) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  perform pg_advisory_xact_lock(hashtext('headway.poll-subway'));
  update public.worker_runs set status = 'superseded', finished_at = p_now, error = 'lease expired'
   where status = 'running' and lease_expires_at < p_now;
  insert into public.worker_runs (started_at, lease_expires_at, status)
  values (p_now, p_now + interval '30 seconds', 'running')
  on conflict ((true)) where status = 'running' do nothing
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------- commit
-- p_feeds:  {"gtfs": {"ok": true, "feed_ts": 1793727000, "reason": null}, ... exactly 8 keys}
-- p_boards: [{"stop_id": "127S", "trains": [{"trip_id","route_id","eta","kind","dest","live","feed"}]}]
-- p_meta:   worker timings/counts, stored in worker_runs.details
create function public.commit_worker_run(
  p_run_id bigint, p_feeds jsonb, p_boards jsonb, p_meta jsonb default '{}', p_now timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now_s bigint := extract(epoch from p_now)::bigint;
  v_lease timestamptz; v_status text; v_started timestamptz;
  v_bad text[]; v_empty text[]; v_unmapped text[]; v_mark text[];
  v_in int; v_ok int; v_changed int; v_feeds_ok int; v_run_status text; v_reasons jsonb;
  c_feeds constant text[] := array['gtfs','gtfs-ace','gtfs-bdfm','gtfs-g','gtfs-jz','gtfs-l','gtfs-nqrw','gtfs-si'];
  c_carry_after constant int := 2;   -- mark trains carried from a feed's 2nd consecutive failed run
begin
  -- 1. Structural validation (rejects the whole call)
  if p_run_id is null or jsonb_typeof(p_feeds) is distinct from 'object' or jsonb_typeof(p_boards) is distinct from 'array' then
    raise exception 'invalid_input: run_id, feeds object and boards array are required';
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(p_feeds) k)
     is distinct from (select array_agg(f order by f) from unnest(c_feeds) f) then
    raise exception 'invalid_input: feeds must contain exactly the 8 subway feeds';
  end if;
  if jsonb_array_length(p_boards) > 2000 then
    raise exception 'invalid_input: too many boards (%)', jsonb_array_length(p_boards);
  end if;

  -- 2. Lease check on the run itself
  select status, lease_expires_at, started_at into v_status, v_lease, v_started
    from public.worker_runs where id = p_run_id for update;
  if v_status is distinct from 'running' then
    raise exception 'superseded: run % is %', p_run_id, coalesce(v_status, 'missing');
  end if;
  if v_lease < p_now then
    raise exception 'superseded: lease of run % expired', p_run_id;
  end if;

  -- 3. Feeds rejected by the worker, or older than the last accepted MTA timestamp
  select coalesce(array_agg(f.key), '{}') into v_bad
  from jsonb_each(p_feeds) f
  cross join public.worker_status ws
  where ws.id = 1 and (
        coalesce((f.value->>'ok')::boolean, false) = false
     or jsonb_typeof(f.value->'feed_ts') is distinct from 'number'
     or (f.value->>'feed_ts')::bigint < coalesce((ws.feeds->f.key->>'feed_ts')::bigint, 0));

  -- Format-change guard: > 20% of a feed's trains at unknown stops rejects the feed
  select coalesce(array_agg(feed), '{}') into v_unmapped from (
    select tr->>'feed' feed, count(*) filter (where pl.stop_id is null)::numeric / count(*) ratio
    from jsonb_array_elements(p_boards) b
    cross join lateral jsonb_array_elements(case when jsonb_typeof(b->'trains') = 'array' then b->'trains' else '[]' end) tr
    left join public.platforms pl on pl.stop_id = b->>'stop_id'
    group by 1) x
  where ratio > 0.2 and feed = any (c_feeds) and not (feed = any (v_bad));
  v_bad := v_bad || v_unmapped;

  -- 4. Expand + validate incoming trains; invalid ones are dropped and counted
  create temp table if not exists _headway_in (stop_id text, station_id int, t jsonb, eta bigint, route text, src int) on commit drop;
  truncate _headway_in;
  insert into _headway_in
  select b->>'stop_id', pl.station_id,
         jsonb_build_object('trip_id', tr->>'trip_id', 'route_id', tr->>'route_id', 'eta', (tr->>'eta')::bigint,
                            'kind', tr->>'kind', 'headsign', ds.name, 'live', (tr->>'live')::boolean,
                            'feed', tr->>'feed', 'carried', false),
         (tr->>'eta')::bigint, tr->>'route_id', 0
  from jsonb_array_elements(p_boards) b
  cross join lateral jsonb_array_elements(case when jsonb_typeof(b->'trains') = 'array' then b->'trains' else '[]' end) tr
  join public.platforms pl on pl.stop_id = b->>'stop_id'
  join public.routes r on r.route_id = tr->>'route_id' and r.feed = tr->>'feed'   -- route must belong to the claimed feed
  left join public.platforms dp on dp.stop_id = tr->>'dest'
  left join public.stations ds on ds.station_id = dp.station_id
  where jsonb_typeof(tr->'eta') = 'number'
    and (tr->>'eta')::bigint between v_now_s - 30 and v_now_s + 5400
    and tr->>'kind' in ('arr', 'dep')
    and jsonb_typeof(tr->'live') = 'boolean'
    and length(coalesce(tr->>'trip_id', '')) between 1 and 64
    and not (tr->>'feed' = any (v_bad));
  get diagnostics v_ok = row_count;
  select coalesce(sum(jsonb_array_length(case when jsonb_typeof(b->'trains') = 'array' then b->'trains' else '[]' end)), 0)
    into v_in from jsonb_array_elements(p_boards) b;

  -- A feed reported healthy that contributes no valid trains is unhealthy ('empty'):
  -- a worker bug or a truncated MTA response must never blank every board.
  select coalesce(array_agg(f), '{}') into v_empty from unnest(c_feeds) f
   where not (f = any (v_bad)) and not exists (select 1 from _headway_in where t->>'feed' = f);
  v_bad := v_bad || v_empty;

  -- Feeds failing for the 2nd+ consecutive run: their carried trains get carried=true
  select coalesce(array_agg(f), '{}') into v_mark
  from unnest(v_bad) f cross join public.worker_status ws
  where ws.id = 1 and coalesce((ws.feeds->f->>'fail_streak')::int, 0) + 1 >= c_carry_after;

  -- 5. Carry over stored trains from rejected feeds (still upcoming)
  insert into _headway_in
  select pb.stop_id, pb.station_id,
         case when tr->>'feed' = any (v_mark) then tr || '{"carried": true}' else tr end,
         (tr->>'eta')::bigint, tr->>'route_id', 1
  from public.platform_boards pb cross join lateral jsonb_array_elements(pb.trains) tr
  where tr->>'feed' = any (v_bad) and (tr->>'eta')::bigint >= v_now_s - 30;

  -- 6. Build next-3-per-route boards, 7. diff against stored, 8. fenced upsert of changed rows only
  with dedup as (
    select distinct on (stop_id, t->>'trip_id') * from _headway_in order by stop_id, t->>'trip_id', src
  ), ranked as (
    select *, row_number() over (partition by stop_id, route order by eta, t->>'trip_id') rn from dedup
  ), built as (
    select stop_id, max(station_id) station_id, jsonb_agg(t order by eta, t->>'trip_id') trains
    from ranked where rn <= 3 group by stop_id
  ), candidates as (
    select coalesce(b.stop_id, pb.stop_id) stop_id, coalesce(b.station_id, pb.station_id) station_id,
           coalesce(b.trains, '[]'::jsonb) new_trains, pb.trains old_trains
    from built b full join public.platform_boards pb on pb.stop_id = b.stop_id
  ), changed as (
    select * from candidates
    where (old_trains is null and jsonb_array_length(new_trains) > 0)
       or (old_trains is not null and public.board_changed(old_trains, new_trains, v_now_s))
  ), up as (
    insert into public.platform_boards as pb (stop_id, station_id, trains, run_id, updated_at)
    select stop_id, station_id, new_trains, p_run_id, p_now from changed
    on conflict (stop_id) do update
      set trains = excluded.trains, run_id = excluded.run_id, updated_at = excluded.updated_at
      where pb.run_id < excluded.run_id                                            -- fencing: newer run wins
    returning 1
  )
  select count(*) into v_changed from up;

  -- 9. Heartbeat + per-feed health (fenced)
  v_feeds_ok := 8 - coalesce(array_length(v_bad, 1), 0);
  v_run_status := case when v_feeds_ok = 8 then 'ok' when v_feeds_ok > 0 then 'partial' else 'error' end;
  select jsonb_object_agg(f.key, case
           when f.key = any (v_unmapped) then 'unmapped_spike'
           when f.key = any (v_empty) then 'empty'
           when f.key = any (v_bad) then coalesce(f.value->>'reason', 'not_newer') end)
    into v_reasons from jsonb_each(p_feeds) f where f.key = any (v_bad);

  update public.worker_status ws set
    last_run_id = p_run_id, last_run_at = p_now, last_status = v_run_status,
    last_success_at = case when v_feeds_ok > 0 then p_now else ws.last_success_at end,
    last_error = case when v_reasons is null then null else v_reasons::text end,
    boards_changed = v_changed,
    feeds = (select jsonb_object_agg(f.key, jsonb_build_object(
               'ok',          not (f.key = any (v_bad)),
               'feed_ts',     case when f.key = any (v_bad) then ws.feeds->f.key->'feed_ts' else f.value->'feed_ts' end,
               'reason',      v_reasons->>f.key,
               'last_ok_at',  case when f.key = any (v_bad) then ws.feeds->f.key->'last_ok_at' else to_jsonb(p_now) end,
               'fail_streak', case when f.key = any (v_bad) then coalesce((ws.feeds->f.key->>'fail_streak')::int, 0) + 1 else 0 end))
             from jsonb_each(p_feeds) f)
  where ws.id = 1 and ws.last_run_id < p_run_id;

  -- 10. Finish the run log row
  update public.worker_runs set
    status = v_run_status, finished_at = clock_timestamp(),
    duration_ms = (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
    feeds_ok = v_feeds_ok, feeds_failed = 8 - v_feeds_ok,
    trains_in = v_in, trains_rejected = v_in - v_ok, boards_changed = v_changed,
    details = coalesce(p_meta, '{}') || jsonb_build_object('feeds_rejected', coalesce(v_reasons, '{}'))
  where id = p_run_id;

  return jsonb_build_object('run_id', p_run_id, 'status', v_run_status, 'boards_changed', v_changed,
                            'trains_in', v_in, 'trains_rejected', v_in - v_ok,
                            'feeds_rejected', coalesce(v_reasons, '{}'));
end $$;

-- ---------------------------------------------------------------- fail
-- Called by the worker when anything throws before or during commit. Boards are never touched.
create function public.fail_worker_run(p_run_id bigint, p_error text, p_meta jsonb default '{}', p_now timestamptz default now())
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.worker_runs set
    status = 'error', finished_at = clock_timestamp(), error = left(p_error, 500),
    duration_ms = (extract(epoch from clock_timestamp() - started_at) * 1000)::int,
    details = coalesce(p_meta, '{}')
  where id = p_run_id and status = 'running';
  update public.worker_status set
    last_run_id = p_run_id, last_run_at = p_now, last_status = 'error', last_error = left(p_error, 500)
  where id = 1 and last_run_id < p_run_id;
end $$;

-- ---------------------------------------------------------------- housekeeping (daily, SQL-only Cron job)
create function public.prune_worker_history() returns void
language sql security definer set search_path = '' as $$
  delete from public.worker_runs where started_at < now() - interval '3 days';
$$;

-- ---------------------------------------------------------------- privileges
revoke execute on function public.board_changed(jsonb, jsonb, bigint) from public, anon, authenticated;
revoke execute on function public.claim_worker_run(timestamptz) from public, anon, authenticated;
revoke execute on function public.commit_worker_run(bigint, jsonb, jsonb, jsonb, timestamptz) from public, anon, authenticated;
revoke execute on function public.fail_worker_run(bigint, text, jsonb, timestamptz) from public, anon, authenticated;
revoke execute on function public.prune_worker_history() from public, anon, authenticated;
grant execute on function public.claim_worker_run(timestamptz) to service_role;
grant execute on function public.commit_worker_run(bigint, jsonb, jsonb, jsonb, timestamptz) to service_role;
grant execute on function public.fail_worker_run(bigint, text, jsonb, timestamptz) to service_role;
