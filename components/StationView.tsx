"use client";

// Station panel: a compact station sign (name, lines, one primary action), a single-row line filter,
// then every platform grouped by line with both directions. Arrivals start high on the screen; system
// freshness lives in the header, so boards only add a warning when one of their own feeds is delayed.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useLive } from "@/app/providers";
import { feedsFor, groupStation, visibleTrains, type DirectionBoard, type LineGroup } from "@/lib/headway/core";
import { useStations } from "@/lib/headway/useStations";
import { ConnectionsCard, ConnectionsTab, useHasConnections } from "./Connections";
import { FollowButton } from "./FollowButton";
import { useMap } from "./map/MapContext";
import { RouteMark } from "./RouteMark";
import { useFreshness } from "./Status";
import { TrainRow } from "./TrainRow";

const BOROUGH: Record<string, string> = { M: "Manhattan", Bk: "Brooklyn", Q: "Queens", Bx: "The Bronx", SI: "Staten Island" };

/** Long names stay prominent without taking over the panel. */
export const nameSize = (name: string) =>
  name.length > 26 ? "text-[21px] md:text-[22px]" : name.length > 17 ? "text-[23px] md:text-[25px]" : "text-[26px] md:text-[30px]";

export function StationView({ stationId, initialRoute }: { stationId: number; initialRoute?: string | null }) {
  const { routes, nowMs } = useLive();
  const { setFocus, setRoute, setJourney, setExplore, stationsById } = useMap();
  const [tab, setTab] = useState<"arrivals" | "details" | "connections">("arrivals");
  const hasConnections = useHasConnections(stationId);
  const stopCount = stationsById.get(stationId)?.nodes.length ?? 0;
  const ids = useMemo(() => [stationId], [stationId]);
  const data = useStations(ids);
  const station = data.stations[stationId];
  const [filter, setFilter] = useState<string | null>(initialRoute ?? null);

  // Map follows the panel: focus this station, highlight the chosen line, clear any journey
  useEffect(() => {
    setFocus(stationId);
    setJourney(null);
    return () => setFocus(null);
  }, [stationId, setFocus, setJourney]);
  useEffect(() => {
    setRoute(filter);
    return () => setRoute(null);
  }, [filter, setRoute]);
  // the map's station sign can open Connections ("Explore connections")
  useEffect(() => {
    setExplore(() => setTab("connections"));
    return () => setExplore(null);
  }, [setExplore]);

  const groups = useMemo(() => groupStation(data.platforms, data.boards, routes, nowMs), [data.platforms, data.boards, routes, nowMs]);
  const stationRoutes = useMemo(
    () => [...(station?.routes ?? [])].sort((a, b) => (routes[a]?.sort_order ?? 99) - (routes[b]?.sort_order ?? 99)),
    [station, routes],
  );
  const fresh = useFreshness(data.loaded && !!station, feedsFor(stationRoutes, routes));

  if (data.loaded && !station) {
    return (
      <div className="p-6">
        <p className="text-lg font-bold">We couldn&apos;t find that station.</p>
        <Link href="/" className="mt-3 inline-block font-semibold underline">Search for a station</Link>
      </div>
    );
  }
  const shownGroups = filter ? groups.filter((g) => g.routes.includes(filter) || g.directions.some((d) => d.trains.some((t) => t.route_id === filter))) : groups;
  const name = station?.name ?? "";

  return (
    <article className="slide-in">
      <header className="sign-band px-4 pb-3 pt-3.5 text-sign-text md:px-5 md:pb-3.5 md:pt-4">
        <div className="flex items-center justify-between gap-3">
          <Link href="/" className="label-caps -ml-1 rounded px-1 py-1 text-sign-muted hover:text-sign-text">← Explore</Link>
          {station && <FollowButton stationId={stationId} stationName={station.name} line={filter} />}
        </div>
        <h1 className={`sign-type mt-1.5 leading-[1.06] ${station ? nameSize(name) : "text-[30px]"}`}>{station ? name : "Loading…"}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="flex flex-wrap gap-1">{stationRoutes.map((r) => <RouteMark key={r} route={routes[r]} routeId={r} size={stationRoutes.length > 8 ? "xs" : "sm"} />)}</span>
          {station && <span className="text-[13px] font-medium text-sign-muted">
            {BOROUGH[station.borough] ?? station.borough}{stopCount > 1 ? ` · ${stopCount} connected stops` : ""}
          </span>}
        </div>
        <div role="tablist" aria-label="Station sections" className="mt-3 flex gap-0.5 rounded-lg bg-white/12 p-0.5">
          {(hasConnections ? ["arrivals", "details", "connections"] as const : ["arrivals", "details"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={`press min-h-9 flex-1 rounded-md px-2 text-[13px] font-bold capitalize ${tab === t ? "bg-sign-text text-sign" : "text-sign-muted hover:text-sign-text"}`}>
              {t}
            </button>
          ))}
        </div>
      </header>

      {tab === "arrivals" && stationRoutes.length > 1 && (
        <nav aria-label="Show one line" className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-rule bg-bg/95 px-3 py-1 backdrop-blur [mask-image:linear-gradient(to_right,#000_88%,transparent)] [scrollbar-width:none]">
          <Filter active={!filter} onClick={() => setFilter(null)} label="Show all lines"><span className="px-1.5 text-[13px] font-bold">All</span></Filter>
          {stationRoutes.map((r) => (
            <Filter key={r} active={filter === r} onClick={() => setFilter(filter === r ? null : r)} label={`Show only ${routes[r]?.short_name ?? r} trains`}>
              <RouteMark route={routes[r]} routeId={r} size="sm" />
            </Filter>
          ))}
        </nav>
      )}

      {tab === "connections" && (
        <div className="p-3">
          {/* a chosen stop's next trains: the same live boards as Arrivals, only for that stop's lines */}
          <ConnectionsTab stationId={stationId} arrivals={(lines) => {
            if (fresh.kind === "loading") return null;
            if (fresh.kind === "down") return <p className="py-2 text-sm font-semibold text-down">Live times aren&apos;t available right now.</p>;
            const boards = groups.filter((g) => g.routes.some((r) => lines.includes(r))).flatMap((g) => g.directions);
            return (
              <>
                {fresh.kind === "stale" && <p className="mt-1 text-[13px] font-semibold text-warn">◷ These times may be out of date.</p>}
                {boards.length ? boards.map((d) => <Direction key={d.stopId} board={d} filter={null} />)
                  : <p className="py-2 text-sm text-panel-muted">No trains listed here right now.</p>}
              </>
            );
          }} />
        </div>
      )}
      {tab === "details" && station && (
        <div className="space-y-2.5 p-3">
          <section aria-label="Plan a trip" className="rounded-xl border border-panel-rule bg-panel p-3.5 text-panel-text">
            <h2 className="text-sm font-extrabold">Plan a trip</h2>
            <div className="mt-2 flex gap-2">
              <Link href={`/plan?from=${stationId}`} className="press flex-1 rounded-lg bg-sign py-2.5 text-center text-sm font-bold text-sign-text">From here</Link>
              <Link href={`/plan?to=${stationId}`} className="press flex-1 rounded-lg border-2 border-panel-text py-2 text-center text-sm font-bold">To here</Link>
            </div>
          </section>
          <section aria-label="Lines at this station" className="overflow-hidden rounded-xl border border-panel-rule bg-panel text-panel-text">
            <h2 className="px-3.5 pb-2 pt-3 text-sm font-extrabold">Lines at this station</h2>
            <ul>
              {stationRoutes.map((r) => (
                <li key={r} className="border-t border-panel-rule">
                  <Link href={`/line/${encodeURIComponent(r)}`} className="press flex min-h-11 items-center gap-3 px-3.5 py-1.5 text-sm font-semibold hover:bg-[var(--panel-rule)]">
                    <RouteMark route={routes[r]} routeId={r} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{routes[r]?.long_name ?? r}</span>
                    <span aria-hidden="true" className="text-lg font-bold text-panel-muted">›</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <p className="px-1 text-sm text-muted">{BOROUGH[station.borough] ?? station.borough} · {data.platforms.length} platforms</p>
        </div>
      )}
      {tab === "arrivals" && <div className="space-y-2.5 p-3">
        {fresh.kind === "down" ? (
          <>
            <div role="alert" className="rounded-xl border-2 border-down bg-down-bg p-4 text-down">
              <p className="font-extrabold">Live times aren&apos;t available right now.</p>
              <p className="mt-1 text-sm font-medium">MTA&apos;s data isn&apos;t coming through for these lines. This page keeps trying and updates by itself.</p>
            </div>
            <ConnectionsCard stationId={stationId} onOpen={() => setTab("connections")} />
          </>
        ) : fresh.kind === "loading" ? (
          <Skeleton />
        ) : (
          <>
            {fresh.kind === "stale" && (
              <p role="status" className="rounded-lg bg-warn-bg px-3 py-2 text-sm font-semibold text-warn">◷ Times below may be out of date. We&apos;re waiting for fresh data.</p>
            )}
            {/* arrivals first: connections follow the first board, so they're nearby but secondary */}
            {shownGroups.slice(0, 1).map((g) => <GroupBoard key={g.key} group={g} filter={filter} badFeeds={fresh.badFeeds} stale={fresh.kind === "stale"} />)}
            <ConnectionsCard stationId={stationId} onOpen={() => setTab("connections")} />
            {shownGroups.slice(1).map((g) => <GroupBoard key={g.key} group={g} filter={filter} badFeeds={fresh.badFeeds} stale={fresh.kind === "stale"} />)}
          </>
        )}
        {fresh.kind !== "loading" && fresh.kind !== "down" && shownGroups.length === 0 && (
          <p className="p-2 text-muted">No {routes[filter ?? ""]?.short_name ?? ""} trains are listed here right now.</p>
        )}
      </div>}
    </article>
  );
}

function GroupBoard({ group, filter, badFeeds, stale }: { group: LineGroup; filter: string | null; badFeeds: string[]; stale: boolean }) {
  const { routes } = useLive();
  const delayed = group.feeds.filter((f) => badFeeds.includes(f));
  return (
    <section aria-label={`${group.routes.map((r) => routes[r]?.short_name ?? r).join(" ")} ${group.lineName}`}
      className={`overflow-hidden rounded-xl bg-panel text-panel-text shadow-[0_1px_0_var(--panel-rule),0_1px_3px_rgba(0,0,0,.06)] ${stale ? "outline-2 outline-dashed outline-warn" : "border border-panel-rule"}`}>
      <div className="flex items-center gap-1.5 border-b border-panel-rule px-3.5 py-2">
        {group.routes.map((r) => <RouteMark key={r} route={routes[r]} routeId={r} size="xs" />)}
        <h2 className="label-caps ml-1 truncate text-panel-muted">{group.lineName}</h2>
      </div>
      {delayed.length > 0 && (
        <p className="mx-3.5 mt-2 rounded-lg bg-warn-bg px-3 py-1.5 text-sm font-semibold text-warn">
          ▲ Live data for {group.routes.map((r) => routes[r]?.short_name ?? r).join(", ")} is delayed. Times may be out of date.
        </p>
      )}
      <div className="px-3.5 pb-1.5">
        {group.directions.map((d) => <Direction key={d.stopId} board={d} filter={filter} />)}
      </div>
    </section>
  );
}

function Direction({ board, filter }: { board: DirectionBoard; filter: string | null }) {
  const { routes, nowMs } = useLive();
  const [expanded, setExpanded] = useState(false);
  const { shown, hidden } = visibleTrains(board.trains, filter, expanded);
  return (
    <div className="pt-2">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[14px] font-extrabold">
          <span aria-hidden="true" className="text-panel-muted">{board.direction === "N" ? "↑" : "↓"}</span>{board.heading}
        </h3>
        {(hidden > 0 || expanded) && (
          <button type="button" onClick={() => setExpanded(!expanded)} className="press min-h-8 flex-none rounded px-1 text-[13px] font-bold underline underline-offset-4">
            {expanded ? "Show fewer" : `Show ${hidden} more`}
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="border-t border-panel-rule py-2.5 text-sm text-panel-muted">No trains listed in the next 90 minutes</p>
      ) : (
        <ul>{shown.map((t) => <TrainRow key={t.trip_id} train={t} route={routes[t.route_id]} nowMs={nowMs} />)}</ul>
      )}
    </div>
  );
}

function Filter({ active, onClick, children, label }: { active: boolean; onClick: () => void; children: React.ReactNode; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} aria-label={label} title={label}
      className={`press relative flex min-h-11 min-w-11 flex-none items-center justify-center rounded-lg px-1 ${active ? "bg-bg-2" : "hover:bg-bg-2"}`}>
      {children}
      {/* selected: an underline bar, not colour alone */}
      <span aria-hidden="true" className={`absolute inset-x-2 bottom-0.5 h-[3px] rounded-full bg-text transition-opacity ${active ? "opacity-100" : "opacity-0"}`} />
    </button>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="rounded-xl bg-panel p-4" aria-hidden="true">
      <div className="h-3 w-28 rounded bg-panel-rule" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="mt-4 flex items-center gap-3">
          <div className="h-10 w-10 rounded-[10px] bg-panel-rule" />
          <div className="h-4 flex-1 rounded bg-panel-rule" />
          <div className="h-7 w-14 rounded bg-panel-rule" />
        </div>
      ))}
    </div>
  );
}
