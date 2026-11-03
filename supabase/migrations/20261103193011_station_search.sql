-- Step 5: read-only helpers for the page. No table or RLS changes.

-- Typo-tolerant station search. Normalizes rider spellings ("42nd street", "avenue") to MTA's
-- abbreviations, then ranks prefix > substring > trigram word similarity (pg_trgm).
create function public.search_stations(q text, max_results int default 8)
returns table (station_id int, name text, borough text, routes text[], score real)
language plpgsql stable security invoker set search_path = '' as $$
declare
  n text := lower(btrim(coalesce(q, '')));
begin
  n := regexp_replace(n, '(\d+)(st|nd|rd|th)\M', '\1', 'g');
  n := regexp_replace(n, '\mstreet\M', 'st', 'g');
  n := regexp_replace(n, '\mavenue\M', 'av', 'g');
  n := regexp_replace(n, '\mave\M', 'av', 'g');
  n := regexp_replace(n, '\mroad\M', 'rd', 'g');
  n := regexp_replace(n, '\mboulevard\M', 'blvd', 'g');
  n := regexp_replace(n, '\msquare\M', 'sq', 'g');
  n := regexp_replace(n, '\mparkway\M', 'pkwy', 'g');
  n := regexp_replace(n, '\s+', ' ', 'g');
  if length(n) < 2 then
    return;
  end if;
  return query
    select s.station_id, s.name, s.borough, s.routes,
           greatest(
             case when s.search_text like n || '%' then 1.0
                  when s.search_text like '%' || n || '%' then 0.9
                  else 0 end,
             extensions.word_similarity(n, s.search_text))::real as score
    from public.stations s
    where s.search_text like '%' || n || '%'
       or extensions.word_similarity(n, s.search_text) > 0.4
    order by score desc, s.name
    limit least(greatest(coalesce(max_results, 8), 1), 20);
end $$;

-- Database clock for the page's countdown/freshness offset (the browser clock may be wrong).
create function public.server_now() returns timestamptz
language sql stable security invoker set search_path = '' as $$ select now() $$;

revoke execute on function public.search_stations(text, int) from public;
revoke execute on function public.server_now() from public;
grant execute on function public.search_stations(text, int) to anon, authenticated;
grant execute on function public.server_now() to anon, authenticated;
