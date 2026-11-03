-- Performance advisor fixes for follows (same rules, cheaper evaluation):
-- wrap auth.jwt() itself in a sub-select so Postgres evaluates it once per statement, not per row,
-- and index the station_id foreign key.
drop policy "Users read own follows" on public.follows;
drop policy "Users add own follows" on public.follows;
drop policy "Users remove own follows" on public.follows;

create policy "Users read own follows" on public.follows for select to authenticated
  using (((select auth.jwt()) ->> 'sub') is not null and user_id = ((select auth.jwt()) ->> 'sub'));
create policy "Users add own follows" on public.follows for insert to authenticated
  with check (((select auth.jwt()) ->> 'sub') is not null and user_id = ((select auth.jwt()) ->> 'sub'));
create policy "Users remove own follows" on public.follows for delete to authenticated
  using (((select auth.jwt()) ->> 'sub') is not null and user_id = ((select auth.jwt()) ->> 'sub'));

create index follows_station_id_idx on public.follows (station_id);
