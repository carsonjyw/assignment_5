-- Headway schema: 8 tables (see docs/step3/DATA_FLOW.md §2).
-- Static reference: routes, stations, platforms, route_stops (public read)
-- Live data: platform_boards (public read, Realtime)
-- Worker health: worker_status (public read, Realtime), worker_runs (private log + lease)
-- User-owned: follows (RLS on Clerk user id)

-- ---------------------------------------------------------------- static reference
create table public.routes (
  route_id   text primary key,
  short_name text not null,
  long_name  text not null,
  color      text not null,
  text_color text not null,
  feed       text not null check (feed in ('gtfs','gtfs-ace','gtfs-bdfm','gtfs-g','gtfs-jz','gtfs-l','gtfs-nqrw','gtfs-si')),
  sort_order int  not null
);

create table public.stations (
  station_id  int primary key,            -- MTA Complex ID
  name        text not null,
  borough     text not null,
  routes      text[] not null default '{}',
  lat         double precision not null,
  lon         double precision not null,
  search_text text not null
);

create table public.platforms (
  stop_id         text primary key,       -- e.g. 127S, exactly as in GTFS-Realtime
  parent_stop_id  text not null,
  station_id      int  not null references public.stations,
  direction       char(1) not null check (direction in ('N','S')),
  direction_label text not null,
  line_name       text not null,
  unique (parent_stop_id, direction)
);
create index platforms_station_id_idx on public.platforms (station_id);

create table public.route_stops (
  route_id   text not null references public.routes,
  station_id int  not null references public.stations,
  seq        int  not null,
  primary key (route_id, station_id)
);
create index route_stops_station_id_idx on public.route_stops (station_id);

-- ---------------------------------------------------------------- live data
create table public.platform_boards (
  stop_id    text primary key references public.platforms,
  station_id int  not null references public.stations,
  trains     jsonb not null default '[]' check (jsonb_typeof(trains) = 'array'),
  run_id     bigint not null,            -- fencing token: the worker run that last wrote this row
  updated_at timestamptz not null default now()
);
create index platform_boards_station_id_idx on public.platform_boards (station_id);

-- ---------------------------------------------------------------- worker health
create table public.worker_status (
  id              smallint primary key default 1 check (id = 1),
  last_run_id     bigint not null default 0,
  last_run_at     timestamptz,
  last_success_at timestamptz,
  last_status     text check (last_status in ('ok','partial','error')),
  last_error      text,
  feeds           jsonb not null default '{}',
  boards_changed  int
);
insert into public.worker_status (id) values (1);

create table public.worker_runs (
  id               bigint generated always as identity primary key,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  lease_expires_at timestamptz not null,
  status           text not null check (status in ('running','ok','partial','error','superseded')),
  feeds_ok         int,
  feeds_failed     int,
  trains_in        int,
  trains_rejected  int,
  boards_changed   int,
  duration_ms      int,
  details          jsonb,               -- per-feed reasons and worker timings
  error            text
);
create index worker_runs_started_at_idx on public.worker_runs (started_at desc);
-- At most one running run: the constraint-level guarantee behind claim_worker_run()
create unique index worker_runs_one_running on public.worker_runs ((true)) where status = 'running';

-- ---------------------------------------------------------------- user-owned
create table public.follows (
  user_id    text not null default (auth.jwt()->>'sub'),
  station_id int  not null references public.stations on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, station_id)
);

create function public.enforce_follow_limit() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.follows where user_id = new.user_id) >= 12 then
    raise exception 'follow_limit: at most 12 followed stations';
  end if;
  return new;
end $$;
create trigger follows_limit before insert on public.follows
  for each row execute function public.enforce_follow_limit();

-- ---------------------------------------------------------------- RLS + grants
alter table public.routes          enable row level security;
alter table public.stations        enable row level security;
alter table public.platforms       enable row level security;
alter table public.route_stops     enable row level security;
alter table public.platform_boards enable row level security;
alter table public.worker_status   enable row level security;
alter table public.worker_runs     enable row level security;
alter table public.follows         enable row level security;

-- Supabase grants broad default privileges on public tables; narrow them explicitly.
revoke all on public.routes, public.stations, public.platforms, public.route_stops,
              public.platform_boards, public.worker_status, public.worker_runs, public.follows
  from anon, authenticated;
grant select on public.routes, public.stations, public.platforms, public.route_stops,
                public.platform_boards, public.worker_status
  to anon, authenticated;
grant select, insert, delete on public.follows to authenticated;

create policy "Public read" on public.routes          for select to anon, authenticated using (true);
create policy "Public read" on public.stations        for select to anon, authenticated using (true);
create policy "Public read" on public.platforms       for select to anon, authenticated using (true);
create policy "Public read" on public.route_stops     for select to anon, authenticated using (true);
create policy "Public read" on public.platform_boards for select to anon, authenticated using (true);
create policy "Public read" on public.worker_status   for select to anon, authenticated using (true);
-- worker_runs: no policies at all. Only the worker's SQL functions (service_role) touch it.

create policy "Users read own follows" on public.follows for select to authenticated
  using ((select auth.jwt()->>'sub') is not null and user_id = (select auth.jwt()->>'sub'));
create policy "Users add own follows" on public.follows for insert to authenticated
  with check ((select auth.jwt()->>'sub') is not null and user_id = (select auth.jwt()->>'sub'));
create policy "Users remove own follows" on public.follows for delete to authenticated
  using ((select auth.jwt()->>'sub') is not null and user_id = (select auth.jwt()->>'sub'));

-- Step 2 advisor finding: the RLS auto-enable event-trigger function must not be callable over the API.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'rls_auto_enable' and pronamespace = 'public'::regnamespace) then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
revoke execute on function public.enforce_follow_limit() from public, anon, authenticated;

-- ---------------------------------------------------------------- search + Realtime
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_trgm') then
    execute 'create index stations_search_trgm_idx on public.stations using gin (search_text extensions.gin_trgm_ops)';
  end if;
end $$;

alter publication supabase_realtime add table public.platform_boards, public.worker_status;
