"use client";

// Rail panels for Explore (home), Line, and Saved.
import { useAuth, useClerk } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useLive } from "@/app/providers";
import { cardRows, feedsFor, formatEta, groupStation, trainStatusText, type Platform, type Station, type Train } from "@/lib/headway/core";
import { useStations } from "@/lib/headway/useStations";
import { useMap } from "./map/MapContext";
import { RouteMark } from "./RouteMark";
import { StationSearch } from "./StationSearch";
import { Skeleton } from "./StationView";
import { useFreshness } from "./Status";

// ------------------------------------------------------------------------------------- Explore
export function ExplorePanel() {
  const { routeList } = useLive();
  const { setRoute, setFocus, setJourney } = useMap();
  useEffect(() => {
    setFocus(null);
    setJourney(null);
  }, [setFocus, setJourney]);
  // Lines grouped the way they share track: by trunk colour (MTA GTFS route_color)
  const trunks = useMemo(() => {
    const m = new Map<string, typeof routeList>();
    // shuttles share the L's grey but are their own services
    for (const r of routeList) {
      const key = r.short_name === "S" ? "shuttle" : r.color;
      m.set(key, [...(m.get(key) ?? []), r]);
    }
    return [...m.values()];
  }, [routeList]);
  return (
    <div className="space-y-6 px-5 pb-6 pt-5">
      <div>
        <h1 className="sign-type text-[28px] leading-[1.08]">Every subway station, live.</h1>
        <p className="mt-1.5 text-[15px] text-muted">Search, or tap a station on the map, for its next trains in both directions.</p>
      </div>
      <StationSearch />
      <section aria-labelledby="lines">
        <h2 id="lines" className="label-caps text-muted">Lines</h2>
        <ul className="mt-2 divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-panel">
          {trunks.map((group) => (
            <li key={group[0].short_name === "S" ? "shuttle" : group[0].color} className="flex items-center gap-1 px-2 py-1.5">
              <span aria-hidden="true" className="mr-1.5 h-7 w-1 flex-none rounded-full" style={{ background: `#${group[0].color}` }} />
              {group.map((r) => (
                <Link key={r.route_id} href={`/line/${encodeURIComponent(r.route_id)}`} onMouseEnter={() => setRoute(r.route_id)} onMouseLeave={() => setRoute(null)}
                  onFocus={() => setRoute(r.route_id)} onBlur={() => setRoute(null)}
                  className="press grid h-11 w-11 place-items-center rounded-lg hover:bg-bg-2"
                  aria-label={r.short_name === "S" ? r.long_name : `${r.short_name} line, ${r.long_name}`} title={r.long_name}>
                  <RouteMark route={r} routeId={r.route_id} size="md" />
                </Link>
              ))}
              <span className="ml-auto hidden truncate pl-2 text-right text-xs font-medium text-panel-muted sm:block">{trunkName(group)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs leading-relaxed text-muted">Hover or focus a line to see it on the map. Marks with a white inner ring are express services (6X, 7X, FX).</p>
      </section>
    </div>
  );
}

/** A short trunk caption from the routes' own long names (e.g. "8 Avenue", "Lexington Avenue"). */
function trunkName(group: { long_name: string; short_name: string }[]) {
  if (group.every((r) => r.short_name === "S")) return "Shuttles";
  return group[0].long_name.replace(/ (Local|Express|Shuttle)$/, "");
}

// ------------------------------------------------------------------------------------- Line
interface Stop { seq: number; stations: { station_id: number; name: string; routes: string[] } | null }

export function LinePanel({ routeId }: { routeId: string }) {
  const { supabase, routes } = useLive();
  const { setRoute, setFocus, setJourney } = useMap();
  const [stops, setStops] = useState<Stop[] | null>(null);
  const route = routes[routeId];

  useEffect(() => {
    setRoute(routeId);
    setFocus(null);
    setJourney(null);
    return () => setRoute(null);
  }, [routeId, setRoute, setFocus, setJourney]);
  useEffect(() => {
    let cancelled = false;
    supabase.from("route_stops").select("seq, stations(station_id, name, routes)").eq("route_id", routeId).order("seq")
      .then(({ data }) => { if (!cancelled) setStops((data as unknown as Stop[]) ?? []); });
    return () => { cancelled = true; };
  }, [supabase, routeId]);

  return (
    <article className="slide-in">
      <header className="sign-band flex items-center gap-4 px-5 py-5">
        <RouteMark route={route} routeId={routeId} size="lg" />
        <div>
          <Link href="/" className="label-caps text-sign-muted hover:text-sign-text">← Explore</Link>
          <h1 className="sign-type text-[28px] leading-tight">{route ? (route.short_name === "S" ? route.long_name : `${route.short_name} line`) : "Line"}</h1>
          <p className="text-sm text-sign-muted">{route && route.short_name !== "S" ? route.long_name : "Shuttle"}{stops ? ` · ${stops.length} stations` : ""}</p>
        </div>
      </header>
      {!stops ? <div className="p-3"><Skeleton rows={5} /></div> : (
        <ol className="relative px-5 py-3">
          <span aria-hidden="true" className="absolute bottom-6 left-[29px] top-6 w-1.5 rounded" style={{ background: `#${route?.color ?? "808183"}` }} />
          {stops.map((s) => s.stations && (
            <li key={s.stations.station_id}>
              <Link href={`/station/${s.stations.station_id}?line=${encodeURIComponent(routeId)}`}
                onMouseEnter={() => setFocus(s.stations!.station_id)} onMouseLeave={() => setFocus(null)}
                className="press relative flex min-h-12 items-center gap-4 rounded-lg py-1.5 pr-2 hover:bg-bg-2">
                <span aria-hidden="true" className="z-10 ml-[3px] h-4 w-4 flex-none rounded-full border-[3px] bg-bg" style={{ borderColor: "var(--text)" }} />
                <span className="flex-1 font-bold">{s.stations.name}</span>
                <span className="flex max-w-[45%] flex-wrap justify-end gap-1">
                  {s.stations.routes.filter((r) => r !== routeId).map((r) => <RouteMark key={r} route={routes[r]} routeId={r} size="xs" />)}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

// ------------------------------------------------------------------------------------- Saved
export function SavedPanel() {
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const { supabase } = useLive();
  const { setFocus, setJourney } = useMap();
  const [ids, setIds] = useState<number[] | null>(null);

  useEffect(() => {
    setFocus(null);
    setJourney(null);
  }, [setFocus, setJourney]);
  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    // RLS returns only this user's rows; order = order saved (no manual reordering in v1)
    supabase.from("follows").select("station_id").order("created_at").then(({ data }) => {
      if (!cancelled) setIds(((data as { station_id: number }[]) ?? []).map((r) => r.station_id));
    });
    return () => { cancelled = true; };
  }, [supabase, isSignedIn]);
  const data = useStations(isSignedIn ? ids ?? [] : []);

  return (
    <div className="p-5">
      <h1 className="sign-type text-[30px] leading-tight">Saved</h1>
      {!isLoaded ? <div className="mt-4"><Skeleton rows={2} /></div> : !isSignedIn ? (
        <div className="mt-4 rounded-xl bg-sign p-5 text-sign-text">
          <p className="text-lg font-extrabold">Sign in to save stations</p>
          <p className="mt-1 text-sm text-sign-muted">Saved stations show their next trains here, live. Exploring and planning work without an account.</p>
          <button type="button" onClick={() => clerk.openSignIn({ forceRedirectUrl: "/saved" })}
            className="press mt-4 min-h-11 rounded-full bg-sign-text px-5 font-bold text-sign">Sign in</button>
        </div>
      ) : ids === null ? <div className="mt-4"><Skeleton rows={2} /></div> : ids.length === 0 ? (
        <div className="mt-4 rounded-xl border-2 border-dashed border-rule p-5">
          <p className="font-extrabold">No saved stations yet</p>
          <p className="mt-1 text-sm text-muted">Open any station and tap ☆ Save. It will appear here with live arrivals.</p>
          <Link href="/" className="press mt-3 inline-block font-bold underline">Find a station</Link>
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {ids.map((id, i) => (
            <li key={id} className="enter" style={{ animationDelay: `${i * 50}ms` }}>
              <SavedCard station={data.stations[id]} platforms={data.platforms.filter((p) => p.station_id === id)} boards={data.boards} loaded={data.loaded} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SavedCard({ station, platforms, boards, loaded }: { station?: Station; platforms: Platform[]; boards: Record<string, Train[]>; loaded: boolean }) {
  const { routes, nowMs } = useLive();
  const { setFocus } = useMap();
  const groups = useMemo(() => groupStation(platforms, boards, routes, nowMs), [platforms, boards, routes, nowMs]);
  const { rows, totalDirections } = cardRows(groups);
  const fresh = useFreshness(loaded && !!station, feedsFor(station?.routes ?? [], routes));
  if (!station || fresh.kind === "loading") return <Skeleton rows={2} />;
  return (
    <Link href={`/station/${station.station_id}`} onMouseEnter={() => setFocus(station.station_id)} onMouseLeave={() => setFocus(null)}
      className="press block overflow-hidden rounded-xl border-2 border-transparent hover:border-text">
      <div className="bg-sign px-4 py-3 text-sign-text">
        <h2 className="sign-type truncate text-xl">{station.name}</h2>
        <div className="mt-1.5 flex flex-wrap gap-1">{station.routes.map((r) => <RouteMark key={r} route={routes[r]} routeId={r} size="xs" />)}</div>
      </div>
      <div className="bg-panel px-4 pb-2 text-panel-text">
        {fresh.kind === "down" ? <p className="py-3 text-sm font-semibold text-down">Live times aren&apos;t available right now.</p> : (
          <ul>
            {rows.map((r) => (
              <li key={r.stopId} className="border-b border-panel-rule py-2 last:border-0">
                <p className="label-caps text-panel-muted">{r.heading}</p>
                <div className="mt-0.5 flex items-center gap-2.5">
                  <RouteMark route={routes[r.first.route_id]} routeId={r.first.route_id} muted={!r.first.live} />
                  <span className="tabular text-[26px] font-black leading-none">{formatEta(r.first.eta, nowMs)}</span>
                  <span className={`label-caps ${r.first.live ? "text-live" : "text-panel-muted"}`}>{trainStatusText(r.first)}</span>
                  {r.then.length > 0 && <span className="ml-auto text-sm font-semibold text-panel-muted">then {r.then.map((t) => formatEta(t.eta, nowMs).replace(" min", "")).join(", ")}</span>}
                </div>
              </li>
            ))}
            {loaded && rows.length === 0 && <li className="py-3 text-sm text-panel-muted">No trains listed right now</li>}
          </ul>
        )}
        {totalDirections > rows.length && <p className="pb-1 text-sm font-bold underline underline-offset-4">See all {totalDirections} platforms</p>}
      </div>
    </Link>
  );
}
