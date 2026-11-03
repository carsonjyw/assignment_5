"use client";

// Station + line search (typo-tolerant search_stations RPC). In Explore a result opens the station or
// line; with onPick (Plan) a result selects that station instead.
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { useLive } from "@/app/providers";
import type { Route } from "@/lib/headway/core";
import { RouteMark } from "./RouteMark";

export interface Hit { station_id: number; name: string; borough: string; routes: string[] }
const BOROUGH: Record<string, string> = { M: "Manhattan", Bk: "Brooklyn", Q: "Queens", Bx: "The Bronx", SI: "Staten Island" };

export function StationSearch({ label = "Find a station or line", placeholder = "Try “Union Sq”, “Jamaica”, or “L”", onPick, autoFocus = false }: {
  label?: string; placeholder?: string; onPick?: (hit: Hit) => void; autoFocus?: boolean;
}) {
  const { supabase, routes, routeList } = useLive();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searched, setSearched] = useState("");
  const inputId = useId();

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    let cancelled = false;
    const id = setTimeout(async () => {
      const { data } = await supabase.rpc("search_stations", { q: term, max_results: 8 });
      if (!cancelled) {
        setHits((data as Hit[]) ?? []);
        setSearched(term);
      }
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [q, supabase]);

  const term = q.trim().toLowerCase();
  const lineHits: Route[] = !onPick && term
    ? routeList.filter((r) => r.short_name.toLowerCase() === term || r.route_id.toLowerCase() === term || (term.length >= 3 && r.long_name.toLowerCase().includes(term)))
    : [];
  const showStations = term.length >= 2 && searched.toLowerCase() === term;
  const row = "flex min-h-12 w-full items-center justify-between gap-3 px-4 py-2 text-left hover:bg-bg-2";

  return (
    <div>
      <label htmlFor={inputId} className="label-caps text-muted">{label}</label>
      <input
        id={inputId} type="search" value={q} autoFocus={autoFocus} autoComplete="off" placeholder={placeholder}
        onChange={(e) => setQ(e.target.value)}
        className="mt-1.5 h-13 w-full rounded-xl border-2 border-rule bg-bg px-4 text-lg font-semibold text-text placeholder:font-medium placeholder:text-muted focus:border-text focus:outline-none"
      />
      {(lineHits.length > 0 || showStations) && (
        <ul className="mt-2 overflow-hidden rounded-xl border-2 border-rule" aria-label="Search results">
          {lineHits.map((r) => (
            <li key={`line-${r.route_id}`} className="enter border-b border-rule last:border-0">
              <Link href={`/line/${encodeURIComponent(r.route_id)}`} className={row}>
                <span className="flex items-center gap-3">
                  <RouteMark route={r} routeId={r.route_id} />
                  <span><span className="block font-extrabold">{r.short_name === "S" ? r.long_name : `${r.short_name} line`}</span>
                    <span className="text-sm text-muted">{r.short_name === "S" ? "Shuttle" : r.long_name}</span></span>
                </span>
              </Link>
            </li>
          ))}
          {showStations && hits.map((h) => {
            const body = (
              <>
                <span className="min-w-0"><span className="block truncate font-extrabold">{h.name}</span><span className="text-sm text-muted">{BOROUGH[h.borough] ?? h.borough}</span></span>
                <span className="flex max-w-[55%] flex-wrap justify-end gap-1">{h.routes.map((r) => <RouteMark key={r} route={routes[r]} routeId={r} size="xs" />)}</span>
              </>
            );
            return (
              <li key={h.station_id} className="enter border-b border-rule last:border-0">
                {onPick ? (
                  <button type="button" className={row} onClick={() => { onPick(h); setQ(""); setSearched(""); }}>{body}</button>
                ) : (
                  <Link href={`/station/${h.station_id}`} className={row}>{body}</Link>
                )}
              </li>
            );
          })}
          {showStations && hits.length === 0 && lineHits.length === 0 && (
            <li className="px-4 py-3 text-muted">No stations match “{q.trim()}”. Try part of the name, like “42”.</li>
          )}
        </ul>
      )}
    </div>
  );
}
