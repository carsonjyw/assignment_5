"use client";

// Connections for one station: a guide to its physical stops, numbered exactly as the map numbers them. Each row is
// one real stop with its own lines and how it relates to your stop, using only MTA's data:
//   - membership: MTA's station complexes (stops connected within fare control, or by stairs, escalators or elevators)
//   - transfer times: MTA's minimum transfer times between two stops (transfers.txt), never invented or measured walks
//   - a separate station: a transfer MTA lists between two different complexes (dotted on the map)
// MTA doesn't publish where passageways run, so the map's thin dashed lines are schematic. Pointing at a row (hover or
// focus) rings that stop's number on the map; choosing one makes it your stop: the map glides to it and its next trains
// open here. Choosing a number on the map does the same from the other side.
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useLive } from "@/app/providers";
import { lineIds, primaryStop, stopOrder, stopsOf, transferMinutes } from "@/lib/headway/mapLayout";
import { useMap } from "./map/MapContext";
import { RouteMark } from "./RouteMark";

// Panels are always light (globals.css), so these match the map's light-mode markers exactly.
const INK = "#0d0e10", CONNECTOR = "#9aa0a7";

/** A stop's number as the map draws it: dark with a white ring (your stop), or white with a soft halo. */
export function StopNumber({ n, selected = false, size = 24 }: { n: number; selected?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="flex-none">
      {selected ? (
        <>
          <circle cx="12" cy="12" r="11" fill="#fff" stroke={INK} strokeWidth="1.2" />
          <circle cx="12" cy="12" r="8.5" fill={INK} />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="11.5" fill="rgba(13,14,16,.12)" />
          <circle cx="12" cy="12" r="8" fill="#fff" stroke={INK} strokeWidth="2" />
        </>
      )}
      <text x="12" y="16" textAnchor="middle" fontSize="11" fontWeight="800" fill={selected ? "#fff" : INK}>{n}</text>
    </svg>
  );
}

/** The map's connectors, never solid (lines are): dashed between stops of one station, dotted to a separate station. */
export function LinkSymbol({ dotted = false }: { dotted?: boolean }) {
  return (
    <svg width="34" height="14" viewBox="0 0 34 14" aria-hidden="true" className="flex-none">
      <line x1="9" y1="7" x2="25" y2="7" stroke={CONNECTOR} strokeWidth={dotted ? 2.4 : 1.8} strokeLinecap={dotted ? "round" : "butt"} strokeDasharray={dotted ? "0 5" : "4.5 3.5"} />
      <circle cx="6" cy="7" r="4" fill="#fff" stroke={INK} strokeWidth="1.8" />
      <circle cx="28" cy="7" r="4" fill="#fff" stroke={INK} strokeWidth="1.8" />
    </svg>
  );
}

/** The station's stops, your stop, and the numbering the map uses (the station header's line order). */
function useConnections(stationId: number) {
  const { stationsById, complexes, walks, focus, selectedStop } = useMap();
  const { routes } = useLive();
  const station = stationsById.get(stationId);
  const complex = complexes.get(stationId);
  const stops = station ? stopsOf(station, complex) : [];
  const sel = focus === stationId && selectedStop != null && stops[selectedStop] ? selectedStop : primaryStop(stops);
  const order = stopOrder(stops, (r) => routes[r]?.sort_order ?? 99);
  return { station, complex, stops, sel, order, nearby: walks.filter((w) => w.a === stationId || w.b === stationId) };
}

/** Lines in MTA's order, part-time express variants folded in. */
function useLines() {
  const { routes } = useLive();
  return (r: string[]) => lineIds(r).sort((a, b) => (routes[a]?.sort_order ?? 99) - (routes[b]?.sort_order ?? 99));
}

export function useHasConnections(stationId: number) {
  const { complex, nearby } = useConnections(stationId);
  return !!complex || nearby.length > 0;
}

/** A one-line summary with the arrivals: each numbered stop and its lines. Opens the Connections tab. */
export function ConnectionsCard({ stationId, onOpen }: { stationId: number; onOpen: () => void }) {
  const { stationsById } = useMap();
  const { routes } = useLive();
  const { complex, stops, sel, order, nearby } = useConnections(stationId);
  const lines = useLines();
  if (!complex && !nearby.length) return null;
  const row = "press flex min-h-12 w-full items-center gap-3 border-t border-panel-rule px-3.5 py-2.5 text-left first:border-t-0 hover:bg-[var(--panel-rule)]";
  return (
    <section aria-label="Connections" className="overflow-hidden rounded-xl border border-panel-rule bg-panel text-panel-text">
      {complex && (
        <button type="button" onClick={onOpen} className={row}>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold">Connections <span className="font-semibold text-panel-muted">· {stops.length} stops in this station</span></span>
            <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1.5">
              {order.map((i, pos) => (
                <span key={i} className="flex items-center gap-1">
                  <StopNumber n={pos + 1} selected={i === sel} size={19} />
                  {lines(stops[i].r).map((r) => <RouteMark key={r} route={routes[r]} routeId={r} size="2xs" />)}
                </span>
              ))}
            </span>
          </span>
          <span aria-hidden="true" className="flex-none text-lg font-bold text-panel-muted">›</span>
        </button>
      )}
      {nearby.map((w) => {
        const otherId = w.a === stationId ? w.b : w.a;
        return (
          <button key={otherId} type="button" onClick={onOpen} className={row}>
            <LinkSymbol dotted />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold">{stationsById.get(otherId)?.name ?? "Nearby station"}</span>
              <span className="block text-[13px] text-panel-muted">Separate station · allow {transferMinutes(w.s)}</span>
            </span>
            <span aria-hidden="true" className="flex-none text-lg font-bold text-panel-muted">›</span>
          </button>
        );
      })}
    </section>
  );
}

/** The interactive guide. `arrivals(lines)`: the next trains for one stop's lines, from the station's live boards. */
export function ConnectionsTab({ stationId, arrivals }: { stationId: number; arrivals?: (lines: string[]) => ReactNode }) {
  const { stationsById, setTransfer, chooseStop } = useMap();
  const { routes } = useLive();
  const { station, complex, stops, sel, order, nearby } = useConnections(stationId);
  const lines = useLines();
  const [hover, setHover] = useState<number | null>(null);

  // while this tab is open the map brings the stops close, and marks the one being pointed at here
  useEffect(() => {
    setTransfer({ id: stationId, hover });
    return () => setTransfer(null);
  }, [stationId, hover, setTransfer]);

  const secs = (a: number, b: number) => complex?.t.find(([x, y]) => (x === a && y === b) || (x === b && y === a))?.[2];
  const documented = (complex?.t.length ?? 0) > 0;
  const spoken = (ls: string[]) => ls.map((r) => routes[r]?.short_name ?? r).join(", ");

  return (
    <div className="space-y-2.5">
      {complex && station && (
        <section aria-labelledby="stops-heading" className="overflow-hidden rounded-xl border border-panel-rule bg-panel text-panel-text">
          <div className="px-3.5 pb-3 pt-3">
            <h2 id="stops-heading" className="text-[15px] font-extrabold">{stops.length} stops, one station</h2>
            <p className="mt-1 text-[13px] leading-snug text-panel-muted">
              MTA counts these as one station complex, so you change between them inside the station. Each number is one stop, marked with the same number on the map. Choose a stop to find it and see its next trains.
              {!documented && " MTA's feed lists no transfer times between these stops."}
            </p>
          </div>
          <ol>
            {order.map((i, pos) => {
              const stop = stops[i], yours = i === sel, ls = lines(stop.r);
              const time = yours ? undefined : secs(sel, i);
              const relation = yours ? "Your stop" : time != null ? `Transfer, allow ${transferMinutes(time)}` : "No transfer time listed";
              const named = stop.n !== station.name;
              return (
                <li key={i} className="border-t border-panel-rule">
                  <button type="button" aria-pressed={yours} onClick={() => chooseStop(stationId, i)}
                    aria-label={`Stop ${pos + 1}: ${spoken(ls)} trains${named ? `, ${stop.n}` : ""}. ${relation}.`}
                    onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                    className={`press flex min-h-[52px] w-full items-center gap-3 px-3.5 py-2 text-left hover:bg-[var(--panel-rule)] ${yours ? "bg-[var(--panel-rule)]" : ""}`}>
                    <StopNumber n={pos + 1} selected={yours} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap gap-1">{ls.map((r) => <RouteMark key={r} route={routes[r]} routeId={r} size="sm" />)}</span>
                      {named && <span className="mt-1 block truncate text-[13px] font-semibold">{stop.n}</span>}
                    </span>
                    <span className="flex-none text-right text-[12.5px] font-bold leading-tight">
                      {yours ? "Your stop" : time != null
                        ? <>Transfer<span className="block font-semibold text-panel-muted">allow {transferMinutes(time)}</span></>
                        : <span className="font-semibold text-panel-muted">No time listed</span>}
                    </span>
                  </button>
                  {yours && arrivals && (
                    <div className="px-3.5 pb-2.5">
                      <p className="label-caps text-panel-muted">Next trains at stop {pos + 1}</p>
                      {arrivals(ls)}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {nearby.length > 0 && (
        <section aria-labelledby="nearby-heading" className="overflow-hidden rounded-xl border border-panel-rule bg-panel text-panel-text">
          <div className="px-3.5 pb-3 pt-3">
            <h2 id="nearby-heading" className="flex items-center gap-2.5 text-sm font-extrabold"><LinkSymbol dotted /> Separate station nearby</h2>
            <p className="mt-1.5 text-[13px] leading-snug text-panel-muted">MTA lists a transfer to this station. Its data doesn&apos;t say whether it&apos;s inside or outside the fare gates.</p>
          </div>
          <ul>
            {nearby.map((w) => {
              const otherId = w.a === stationId ? w.b : w.a;
              return (
                <li key={otherId} className="border-t border-panel-rule">
                  <Link href={`/station/${otherId}`} className="press flex min-h-12 items-center gap-3 px-3.5 py-2 hover:bg-[var(--panel-rule)]">
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap gap-1">{lines(w.a === stationId ? w.br : w.ar).map((r) => <RouteMark key={r} route={routes[r]} routeId={r} size="xs" />)}</span>
                      <span className="mt-1 block truncate text-[13px] font-semibold">{stationsById.get(otherId)?.name ?? "Nearby station"}</span>
                    </span>
                    <span className="flex-none text-[13px] font-bold">Allow {transferMinutes(w.s)}</span>
                    <span aria-hidden="true" className="flex-none text-lg font-bold text-panel-muted">›</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <p className="px-1 text-xs leading-relaxed text-muted">
        Times are MTA&apos;s minimum transfer times between stops, not measured walks. On the map, a thin dashed line joins stops MTA lists a transfer between (dotted to a separate station). It shows which stops connect, not where the passageways run. Solid coloured lines are trains, including the grey S.
      </p>
    </div>
  );
}
