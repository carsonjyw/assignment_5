"use client";

// Interactive network map in one projection (public/data/map.json + basemap.json):
//   1. geography: land, water (everything that isn't land), parks, area labels (NYC Open Data, Census),
//      and, once zoomed in, the real street grid (NYC Street Centerline, loaded tile by tile)
//   2. network: one segment per pair of adjacent stations from MTA GTFS, routes bundled side by side by
//      trunk colour, and a plain white marker on every real stop. By default: no route badges, no transfer lines.
//   3. selection: highlighted line, planned journey, and the selected station: its selected stop (dark, ringed),
//      its other stops (a soft halo), each numbered once close enough to read (a number set just off its stop, with a
//      leader, where stops crowd together), dashed hairline schematic connectors between them (clearer while its
//      Connections tab is open), and a compact station sign anchored to the selected stop.
// Pointing at a stop (mouse, or [ and ] on the keyboard) shows a small tooltip with its lines; a tap or click opens
// the station at that stop (or picks it in Plan). Pan: drag / arrow keys. Zoom: wheel, pinch, +/- buttons or keys.
// Nothing is drawn that isn't in the data: no schematic redraw, no invented track, no invented hub or passage.
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLive } from "@/app/providers";
import {
  balanceRows, lineIds, lineWidth, markRows, offsetLine, overlapArea, placeCallout, placeLabels, placeNumbers, points, primaryStop, stopFor, stopOrder, stopsOf,
  transferMinutes, visibleTiles, wrapName, zoomBucket, type Box, type LabelCandidate, type PlacedLabel, type Side,
} from "@/lib/headway/mapLayout";
import type { Journey } from "@/lib/headway/planner";
import { inkFor, RouteMark } from "../RouteMark";
import type { Route } from "@/lib/headway/core";
import { useMap, type BaseData, type MapData, type MapStation, type MapStop } from "./MapContext";

interface View { k: number; x: number; y: number; auto?: { w: number; h: number } } // screen = world * k + (x, y); auto = untouched overview
const MIN_K = 0.45, MAX_K = 24;
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));
// Default framing: Manhattan, the Bronx line to 149 St, western Queens and Brooklyn to Prospect Park
const HOME = { lon0: -74.035, lon1: -73.87, lat0: 40.66, lat1: 40.83 };

// Street grid: context only, so a failed download simply leaves it out
const STREET_K = 4; // blocks are big enough to read from here
const STREET_NAMES_K = 9;
const CONNECT_K = 4; // stops are far enough apart to tell: bold per-stop markers, and the selected station's connectors
const NUMBER_K = 6; // the selected complex's stops carry their numbers from here in
const NUMBER_R = 8; // a stop number's radius, px (larger when the stop markers are)
const CLOSE_LABEL_K = 8; // large, wrapped station labels from here in
const MERGE_PX = 12; // stops closer than this on screen draw as one marker, so they're pointed at together
interface StreetIndex { size: number; tiles: string[] }
interface StreetTile { d: string; n: [string, number, number, number][] }
let streetIndex: Promise<StreetIndex | null> | null = null;
const loadStreetIndex = () => (streetIndex ??= fetch("/data/streets/index.json").then((r) => (r.ok ? r.json() : null)).catch(() => null));
const tileCache = new Map<string, Promise<StreetTile | null>>();
function loadTile(key: string) {
  let p = tileCache.get(key);
  if (!p) {
    p = fetch(`/data/streets/${key}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<StreetTile | null>;
    tileCache.set(key, p);
  }
  return p;
}

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const byOrder = (routes: Record<string, Route>) => (a: string, b: string) => (routes[a]?.sort_order ?? 99) - (routes[b]?.sort_order ?? 99);

// A short map (the phone strip) has room for the station sign on one side only: below your stop when the station's
// other stops lie north of it, above when they lie south.
const SHORT_MAP = 360;
const othersNorth = (stops: { x: number; y: number }[], p: { x: number; y: number }) => stops.reduce((a, q) => a + (q === p ? 0 : q.y - p.y), 0) < 0;

// ------------------------------------------------------------------ derived network structures
interface HitStop { id: number; i: number; x: number; y: number; major: boolean }
interface Network {
  hop: Map<string, number[]>; // "route|a|b" → segment indices
  nodeBundle: Map<string, number>; // "x,y" of a station node → most lines meeting there
  interchange: Set<number>; // complexes served by 2+ trunk colours or spread over 2+ stations
  routeIndex: Map<string, number>;
  stops: Map<number, MapStop[]>; // each station's physical stops
  hits: HitStop[]; // every stop, for pointing and tapping
}

function buildNetwork(data: MapData): Network {
  const hop = new Map<string, number[]>();
  for (const [r, a, b, segs] of data.hops) hop.set(`${r}|${a}|${b}`, segs);
  const nodeBundle = new Map<string, number>();
  for (const s of data.segs) {
    const n = s.c.length;
    for (const k of [`${s.d[0]},${s.d[1]}`, `${s.d[s.d.length - 2]},${s.d[s.d.length - 1]}`]) nodeBundle.set(k, Math.max(n, nodeBundle.get(k) ?? 0));
  }
  const routeIndex = new Map(data.routes.map((r, i) => [r, i]));
  const colourOf = (r: string) => {
    const i = routeIndex.get(r);
    return i == null ? null : data.segs.find((s) => s.r.includes(i))?.c[0] ?? null;
  };
  const trunks = new Map<string, number | null>();
  const interchange = new Set<number>();
  const complexById = new Map(data.complexes.map((c) => [c.id, c]));
  const stops = new Map<number, MapStop[]>();
  const hits: HitStop[] = [];
  for (const st of data.stations) {
    const cs = new Set(st.routes.map((r) => (trunks.has(r) ? trunks.get(r)! : (trunks.set(r, colourOf(r)), trunks.get(r)!))));
    if (st.nodes.length > 1 || cs.size > 1) interchange.add(st.id);
    const list = stopsOf(st, complexById.get(st.id));
    stops.set(st.id, list);
    const major = st.nodes.length > 1 || st.routes.length >= 6;
    list.forEach((p, i) => hits.push({ id: st.id, i, x: p.x, y: p.y, major }));
  }
  return { hop, nodeBundle, interchange, routeIndex, stops, hits };
}

/** A stop marker's radius in screen px at zoom bucket kb (world radius = this / kb). */
function markerRadius(net: Network, kb: number, ix: boolean, x: number, y: number) {
  const w = lineWidth(kb);
  const bundle = net.nodeBundle.get(`${x},${y}`) ?? 1;
  // close up: every stop is the same bold marker
  if (kb >= CONNECT_K) return Math.max(w * 1.05, (bundle * w * 1.1) / 2 + 1.6);
  return ix ? Math.max(3.6, (bundle * w * 1.1) / 2 + 1.6) : Math.max(1.8, w * 0.62 + (bundle - 1) * w * 0.55);
}

/** Segment geometry for one leg, in travel order (falls back to a straight line if the hop isn't drawn). */
function legPath(data: MapData, net: Network, route: string, stations: number[], byId: Map<number, MapStation>): number[] {
  const ri = net.routeIndex.get(route);
  const out: number[] = [];
  const push = (pts: number[]) => {
    if (out.length) {
      const [ex, ey] = [out[out.length - 2], out[out.length - 1]];
      const d0 = Math.hypot(pts[0] - ex, pts[1] - ey), d1 = Math.hypot(pts[pts.length - 2] - ex, pts[pts.length - 1] - ey);
      if (d1 < d0) pts = reverse(pts);
    }
    out.push(...pts);
  };
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i], b = stations[i + 1];
    const segs = ri == null ? undefined : net.hop.get(`${ri}|${Math.min(a, b)}|${Math.max(a, b)}`);
    if (segs?.length) {
      // order the hop's segments from a towards b
      const rest = segs.map((j) => data.segs[j].d);
      const start = byId.get(a);
      let cur: [number, number] = out.length ? [out[out.length - 2], out[out.length - 1]] : start ? [start.x, start.y] : [rest[0][0], rest[0][1]];
      while (rest.length) {
        let best = 0, bestD = Infinity;
        rest.forEach((d, j) => {
          const dd = Math.min(Math.hypot(d[0] - cur[0], d[1] - cur[1]), Math.hypot(d[d.length - 2] - cur[0], d[d.length - 1] - cur[1]));
          if (dd < bestD) { bestD = dd; best = j; }
        });
        let d = rest.splice(best, 1)[0];
        if (Math.hypot(d[d.length - 2] - cur[0], d[d.length - 1] - cur[1]) < Math.hypot(d[0] - cur[0], d[1] - cur[1])) d = reverse(d);
        push(d);
        cur = [d[d.length - 2], d[d.length - 1]];
      }
    } else {
      const p = byId.get(a), q = byId.get(b);
      if (p && q) push([p.x, p.y, q.x, q.y]);
    }
  }
  return out;
}
function reverse(d: number[]) {
  const r: number[] = [];
  for (let i = d.length - 2; i >= 0; i -= 2) r.push(d[i], d[i + 1]);
  return r;
}

// The shuttles' line colour is a neutral grey: on its own, a shuttle's track (like the 42 St Shuttle's, Times Sq to Grand
// Central) is easy to misread as a transfer between stations. So its longest stretch of track that carries no other line
// is marked with the route, at a point along it clear of stops and of station names (names come first: no room, no
// mark). A shuttle bundled beside another line (the Rockaway Park Shuttle beside the A) reads as a line already.
const SHUTTLES = new Set(["GS", "FS", "H"]);
interface TrackMark { at: { x: number; y: number; clear: number }[]; len: number; route: string; color: string } // at: best first
function shuttleMarks(data: MapData): TrackMark[] {
  const nodes = data.stations.flatMap((s) => (s.nodes.length ? s.nodes : [[s.x, s.y] as [number, number]]));
  const length = (d: number[]) => {
    let l = 0;
    for (let i = 2; i < d.length; i += 2) l += Math.hypot(d[i] - d[i - 2], d[i + 1] - d[i - 1]);
    return l;
  };
  const along = (d: number[], at: number) => {
    for (let i = 2; i < d.length; i += 2) {
      const l = Math.hypot(d[i] - d[i - 2], d[i + 1] - d[i - 1]);
      if (at <= l || i === d.length - 2) {
        const f = l ? Math.min(1, at / l) : 0;
        return { x: d[i - 2] + (d[i] - d[i - 2]) * f, y: d[i - 1] + (d[i + 1] - d[i - 1]) * f };
      }
      at -= l;
    }
    return { x: d[0], y: d[1] };
  };
  const out: TrackMark[] = [];
  data.routes.forEach((route, ri) => {
    if (!SHUTTLES.has(route)) return;
    let best: { d: number[]; len: number; color: string } | null = null;
    for (const s of data.segs) {
      if (s.r.length !== 1 || s.r[0] !== ri) continue;
      const len = length(s.d);
      if (!best || len > best.len) best = { d: s.d, len, color: data.colors[s.c[0]] };
    }
    if (!best) return;
    const at: TrackMark["at"] = [];
    for (let f = 0.15; f <= 0.851; f += 0.05) {
      const p = along(best.d, f * best.len);
      at.push({ ...p, clear: Math.min(...nodes.map(([x, y]) => Math.hypot(x - p.x, y - p.y))) });
    }
    out.push({ at: at.sort((a, b) => b.clear - a.clear), len: best.len, route, color: best.color });
  });
  return out;
}
const TRACK_MARK_PX = 15;
/** From street zoom, where the track is long enough on screen to carry it: the first spot along it that's clear of every
 *  stop marker and every placed label (label boxes are in px at kb). */
function trackMarkAt(m: TrackMark, k: number, kb: number, labels: PlacedLabel[]) {
  if (m.len * k < TRACK_MARK_PX * 4.5) return null;
  const h = TRACK_MARK_PX / 2 + 2;
  return m.at.find((p) => p.clear * k >= TRACK_MARK_PX && !labels.some((l) => overlapArea(l.box, [p.x * kb - h, p.y * kb - h, p.x * kb + h, p.y * kb + h]) > 0)) ?? null;
}

// ------------------------------------------------------------------ layers (memoised: pan never re-renders them)
const BaseLayer = memo(function BaseLayer({ base }: { base: BaseData }) {
  return (
    <g aria-hidden="true">
      {base.land.map((l, i) => (
        <path key={i} d={l.d} fill={l.k === "region" ? "var(--land-2)" : "var(--land)"} stroke="var(--shore)" strokeWidth={0.75} vectorEffect="non-scaling-stroke" />
      ))}
      {base.parks.map((p, i) => <path key={`p${i}`} d={p.d} fill="var(--park)" />)}
    </g>
  );
});

// World-unit stroke (not non-scaling): these paths are large, and this keeps panning smooth
const StreetLayer = memo(function StreetLayer({ d, width }: { d: string; width: number }) {
  return <path d={d} fill="none" stroke="var(--street)" strokeWidth={width} strokeLinecap="round" aria-hidden="true" />;
});

const NetworkLayer = memo(function NetworkLayer({ data, kb, dim }: { data: MapData; kb: number; dim: boolean }) {
  const w = lineWidth(kb);
  const gap = (w * 1.1) / kb; // world units between bundled lines
  return (
    <g aria-hidden="true" style={{ transition: "opacity 250ms" }}>
      {data.segs.flatMap((s, i) => s.c.map((c, j) => (
        <polyline key={`${i}-${c}`} points={points(offsetLine(s.d, (j - (s.c.length - 1) / 2) * gap))} fill="none"
          stroke={dim ? "var(--line-dim)" : `#${data.colors[c]}`} strokeWidth={w} vectorEffect="non-scaling-stroke"
          strokeLinecap="round" strokeLinejoin="round" />
      )))}
    </g>
  );
});

const RouteLayer = memo(function RouteLayer({ data, kb, routeIdx, color }: { data: MapData; kb: number; routeIdx: number; color: string }) {
  const w = lineWidth(kb) * 1.7;
  const segs = data.segs.filter((s) => s.r.includes(routeIdx));
  return (
    <g aria-hidden="true" className="enter">
      {segs.map((s, i) => <polyline key={`c${i}`} points={points(s.d)} fill="none" stroke="var(--casing)" strokeWidth={w + 4} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />)}
      {segs.map((s, i) => <polyline key={`l${i}`} points={points(s.d)} fill="none" stroke={color} strokeWidth={w} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />)}
    </g>
  );
});

const JourneyLayer = memo(function JourneyLayer({ legs, kb, colors }: { legs: number[][]; kb: number; colors: string[] }) {
  const w = lineWidth(kb) * 1.9;
  return (
    <g aria-hidden="true">
      {legs.map((d, i) => <polyline key={`c${i}`} points={points(d)} fill="none" stroke="var(--casing)" strokeWidth={w + 5} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />)}
      {legs.map((d, i) => (
        // world-unit width here (not non-scaling-stroke): Chrome mis-scales pathLength dashes on non-scaling strokes
        <path key={`l${i}-${d.length}`} d={"M" + points(d).replaceAll(" ", "L")} pathLength={1} fill="none" stroke={colors[i]} strokeWidth={w / kb}
          strokeLinecap="round" strokeLinejoin="round" className="map-draw" style={{ animationDelay: `${i * 380}ms` }} />
      ))}
    </g>
  );
});

/** A group drawn in screen px around a world point. Small marks with text are drawn this way: a world-unit font size
 *  (under 1 unit when zoomed in) or an em-based offset puts the text off its mark in some browsers. */
const atPx = (x: number, y: number, k: number) => `translate(${x} ${y}) scale(${1 / k})`;

/** HEADWAY's own route mark (RouteMark's rounded square), drawn on a shuttle's track: "this grey line is the S". */
function TrackMarks({ marks, k, kb, labels, label }: { marks: TrackMark[]; k: number; kb: number; labels: PlacedLabel[]; label: (route: string) => string }) {
  const s = TRACK_MARK_PX;
  return (
    <g aria-hidden="true" className="pointer-events-none">
      {marks.map((m) => {
        const p = trackMarkAt(m, k, kb, labels);
        return p && (
          <g key={m.route} transform={atPx(p.x, p.y, k)}>
            <rect x={-s / 2} y={-s / 2} width={s} height={s} rx={3.5} fill={`#${m.color}`} stroke="var(--land)" strokeWidth={1.5} />
            <text y={3.4} textAnchor="middle" fontSize={9.5} fontWeight={800} fill={inkFor(m.color)}>{label(m.route)}</text>
          </g>
        );
      })}
    </g>
  );
}

// Every real stop: white with a thin dark outline. A stop that's part of a multi-stop station complex (a transfer
// hub) gets a thin inner ring, once markers are big enough to carry one. While a station is selected, every other
// station steps back. No badges, no transfer lines: the default map stays quiet.
const StationLayer = memo(function StationLayer({ data, net, kb, active, focusIds }: {
  data: MapData; net: Network; kb: number; active: Set<number> | null; focusIds: Set<number> | null;
}) {
  const showLocal = kb >= 1.5;
  const ring = kb >= CONNECT_K ? 2 : 1.4;
  return (
    <g aria-hidden="true">
      {data.stations.map((s) => {
        const ix = net.interchange.has(s.id);
        // zoomed out: only major interchanges (multi-station complexes, 6+ routes) keep a symbol
        const major = s.nodes.length > 1 || s.routes.length >= 6;
        if (!showLocal && !(major || active?.has(s.id))) return null;
        const faded = active != null && !active.has(s.id);
        const quiet = focusIds != null && !focusIds.has(s.id);
        const hub = s.nodes.length > 1;
        const nodes = s.nodes.length ? s.nodes : [[s.x, s.y] as [number, number]];
        return (
          // quieter, but still opaque: a see-through marker would pick up the colour of the line under it
          <g key={s.id} opacity={faded ? 0.4 : 1}>
            {nodes.map((n, i) => {
              const r = markerRadius(net, kb, ix, n[0], n[1]);
              const fill = quiet ? "var(--station-fill-quiet)" : "var(--station-fill)", ink = quiet ? "var(--station-ring-quiet)" : "var(--station-ring)";
              return (
                <g key={i}>
                  <circle cx={n[0]} cy={n[1]} r={r / kb} fill={fill} stroke={ink} strokeWidth={ix || kb >= CONNECT_K ? ring : 1.2} vectorEffect="non-scaling-stroke" />
                  {hub && r >= 4.5 && <circle cx={n[0]} cy={n[1]} r={(r * 0.42) / kb} fill="none" stroke={ink} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />}
                </g>
              );
            })}
          </g>
        );
      })}
    </g>
  );
});

// ------------------------------------------------------------------ selection: real stops only, never a centre point
interface Mark { x: number; y: number; r: number } // world position, radius in px at zoom bucket kb
/** A highlighted stop of the selected station (or a journey end). Once close enough to read, a numbered one (`label`,
 *  `r` in px at the current zoom) sits on its stop's own marker, or, when other stops are too close to tell apart, just
 *  off it at (x, y), with a leader to its stop's own marker at `stop` (the real position: stops never move). */
interface Disc extends Mark { key: string; sel: boolean; label: string | null; stop?: Mark; i?: number }
/** A ring around what's being pointed at (a stop or its number): world position, radius in px at the current zoom. */
interface Ring { x: number; y: number; px: number }
type Seg = [number, number, number, number];

/** A stop's number, matching Connections: dark with a white ring for your stop, white with a soft halo for the others. */
function NumberedDisc({ d, k }: { d: Disc; k: number }) {
  const R = d.r; // px
  return d.sel ? (
    <g transform={atPx(d.x, d.y, k)}>
      <circle r={R + 3} fill="var(--stop-sel-ring)" stroke="var(--stop-sel-edge)" strokeWidth={1.2} />
      <circle r={R} fill="var(--stop-sel-fill)" />
      <text y={3.8} textAnchor="middle" fontSize={10.5} fontWeight={800} fill="var(--stop-sel-ring)">{d.label}</text>
    </g>
  ) : (
    <g transform={atPx(d.x, d.y, k)} className="map-fade">
      <circle r={R + 3.5} fill="var(--stop-halo)" />
      <circle r={R} fill="var(--station-fill)" stroke="var(--station-ring)" strokeWidth={2} />
      <text y={3.8} textAnchor="middle" fontSize={10.5} fontWeight={800} fill="var(--stop-sel-fill)">{d.label}</text>
    </g>
  );
}

/** A stop's own marker at its real position: dark and ringed for your stop, white with a soft halo for the others. */
function StopDot({ m, sel, k, kb }: { m: Mark; sel: boolean; k: number; kb: number }) {
  return sel ? (
    <g>
      <circle cx={m.x} cy={m.y} r={(m.r + 3.2) / kb} fill="var(--stop-sel-ring)" stroke="var(--stop-sel-edge)" strokeWidth={1.2 / k} />
      <circle cx={m.x} cy={m.y} r={m.r / kb} fill="var(--stop-sel-fill)" />
    </g>
  ) : (
    <g className="map-fade">
      <circle cx={m.x} cy={m.y} r={(m.r + 3.5) / kb} fill="var(--stop-halo)" />
      <circle cx={m.x} cy={m.y} r={m.r / kb} fill="var(--station-fill)" stroke="var(--station-ring)" strokeWidth={2 / k} />
    </g>
  );
}

/** From the edge of a stop's own marker to the edge of its number. */
function leaderOf(d: Disc, k: number, kb: number): Seg {
  const s = d.stop!, dx = d.x - s.x, dy = d.y - s.y, l = Math.hypot(dx, dy) || 1;
  const a = (s.r + 3.5) / kb / l, b = (d.r + 2) / k / l;
  return [s.x + dx * a, s.y + dy * a, d.x - dx * b, d.y - dy * b];
}

function Highlights({ k, kb, discs, rings, hot, links, walks, focusLink, strong, ping }: {
  k: number; kb: number; discs: Disc[]; rings: Ring[]; hot: string | null; links: Seg[]; walks: Seg[]; focusLink: Seg | null; strong: boolean; ping: string | null;
}) {
  const path = (segs: Seg[]) => segs.map(([a, b, c, d]) => `M${a},${b}L${c},${d}`).join("");
  const dashed = path(links), dotted = path(walks);
  const dashes = `${4.5 / k} ${3.5 / k}`, dots = `0 ${5 / k}`; // round caps on zero-length dashes draw dots, evenly spaced
  // Schematic transfers, the quietest thing in the selection: hairline neutrals, never solid, so they never read as track
  // (every line is solid and coloured, including the shuttle's grey). Dashed within one station, dotted to a separate
  // one. Barely there while a station is selected, clearer while its Connections tab is open; the listed transfer from
  // your stop to the one being pointed at is drawn on top, a little firmer.
  const ink = strong ? "var(--connector)" : "var(--connector-soft)";
  const sels = discs.filter((d) => d.sel); // your stop, or a planned journey's two ends
  return (
    <g aria-hidden="true" className="pointer-events-none">
      <g fill="none" stroke={ink} strokeLinejoin="round" className="map-fade">
        {dashed && <path d={dashed} strokeWidth={(strong ? 1.75 : 1.5) / k} strokeDasharray={dashes} />}
        {dotted && <path d={dotted} strokeWidth={2.25 / k} strokeDasharray={dots} strokeLinecap="round" />}
        {focusLink && <path d={path([focusLink])} stroke="var(--connector-focus)" strokeWidth={2 / k} strokeDasharray={dashes} />}
      </g>
      {/* numbers set off their stops: a short leader to the stop's own marker, then the marker, then the number */}
      {discs.filter((d) => d.stop).map((d) => {
        const [a, b, c, e] = leaderOf(d, k, kb);
        return <line key={`l${d.key}`} x1={a} y1={b} x2={c} y2={e} stroke={hot === d.key ? "var(--stop-hover)" : "var(--leader)"} strokeWidth={(hot === d.key ? 2 : 1.25) / k} strokeLinecap="round" />;
      })}
      {discs.filter((d) => d.stop).sort((a, b) => +a.sel - +b.sel).map((d) => <StopDot key={`d${d.key}`} m={d.stop!} sel={d.sel} k={k} kb={kb} />)}
      {discs.filter((d) => !d.sel).map((d) => d.label ? <NumberedDisc key={d.key} d={d} k={k} /> : (
        <g key={d.key} className="map-fade">
          <circle cx={d.x} cy={d.y} r={(d.r + 3.5) / kb} fill="var(--stop-halo)" />
          <circle cx={d.x} cy={d.y} r={d.r / kb} fill="var(--station-fill)" stroke="var(--station-ring)" strokeWidth={2 / k} />
        </g>
      ))}
      {rings.map((m, i) => <circle key={`h${i}`} cx={m.x} cy={m.y} r={(Math.max(m.px, 7.5) + 5) / k} fill="none" stroke="var(--stop-hover)" strokeWidth={2.5 / k} />)}
      {sels.map((d) => {
        const at = d.stop ?? d; // the ping marks the stop itself
        return (
          <g key={d.key}>
            {d.label ? <NumberedDisc d={d} k={k} /> : <StopDot m={d} sel k={k} kb={kb} />}
            {ping === d.key && (
              <circle cx={at.x} cy={at.y} r={d.label && !d.stop ? (d.r + 10) / k : (Math.max(at.r, 7.5) + 10) / kb} fill="none" stroke="var(--stop-sel-fill)" strokeWidth={2 / k} className="map-ping" />
            )}
          </g>
        );
      })}
    </g>
  );
}

// ------------------------------------------------------------------ callouts: the station sign, the tooltip, route badges
// reach: further-off distances the callout may stand at (pointer extended) when every spot beside its anchor is blocked
interface CalloutItem { key: string; kind: "sign" | "tip"; x: number; y: number; gap: number; order: Side[]; hard?: Box[]; reach?: number[]; body: ReactNode }

/** The sign and tooltip: HTML over the map, placed after layout by placeCallout, inside the map, clear of controls and stops, over as few labels as possible. */
function Callouts({ items, bounds, hard, labels }: { items: CalloutItem[]; bounds: Box; hard: Box[]; labels: { key: string; box: Box }[] }) {
  const root = useRef<HTMLDivElement>(null);
  const sides = useRef(new Map<string, Side>());
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    // covering a station's name costs far more than covering a neighbourhood or street name
    const soft = labels.map((l) => ({ box: l.box, weight: l.key.startsWith("s") ? 10 : 1 }));
    const placed: Box[] = [], cover: Box[] = [];
    for (const it of items) {
      const node = el.querySelector<HTMLElement>(`[data-callout="${it.key}"]`);
      if (!node) continue;
      const w = node.offsetWidth, h = node.offsetHeight;
      const c = placeCallout({ x: it.x, y: it.y, w, h, gap: it.gap, bounds, hard: [...hard, ...(it.hard ?? []), ...placed], soft, order: it.order, prev: sides.current.get(it.key), reach: it.reach });
      sides.current.set(it.key, c.side);
      const x = Math.round(c.x), y = Math.round(c.y);
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      node.style.setProperty("--tip", `${Math.round(c.tip)}px`);
      node.style.setProperty("--reach", `${c.reach}px`);
      node.dataset.side = c.side;
      placed.push([x - 3, y - 3, x + w + 3, y + h + 3]);
      if (it.kind === "sign") cover.push([x, y, x + w, y + h]);
    }
    for (const key of [...sides.current.keys()]) if (!items.some((it) => it.key === key)) sides.current.delete(key);
    // a label under the sign would only peek out around its edges: hide it while the sign is there
    const hidden = new Set(labels.filter((l) => cover.some((c) => overlapArea(c, l.box) > 0)).map((l) => l.key));
    el.parentElement?.querySelectorAll<SVGElement>("[data-label]").forEach((t) => {
      const hide = hidden.has(t.dataset.label ?? "");
      if ((t.style.opacity === "0") !== hide) t.style.opacity = hide ? "0" : "";
    });
  });
  return (
    <div ref={root} aria-hidden="true" className="pointer-events-none absolute inset-0">
      {items.map((it) => (
        <div key={it.key} data-callout={it.key} className={`callout callout-${it.kind}`}>
          <span className="callout-notch" />
          {it.reach && <span className="callout-reach" />}
          {it.body}
        </div>
      ))}
    </div>
  );
}

function Marks({ lines, size, gap = 3 }: { lines: string[]; size: "xs" | "2xs" | "3xs"; gap?: number }) {
  const { routes } = useLive();
  return <span className="flex flex-wrap" style={{ gap }}>{lines.map((r) => <RouteMark key={r} route={routes[r]} routeId={r} size={size} />)}</span>;
}

/** A stop's number on the sign: the same marks as on the map (your stop dark and ringed). */
function SignNum({ n, sel = false }: { n: number; sel?: boolean }) {
  return <span className={sel ? "sign-num sign-num-sel" : "sign-num"} aria-hidden="true">{n}</span>;
}

/** The selected station, as a compact annotation: its name, this stop's lines, then the lines a transfer away (smaller,
 *  in balanced rows when there are many), MTA's listed transfer to a separate station, and how many stops the complex
 *  has, with a way into Connections, which shows where each line stops. Once the map numbers the stops, the sign
 *  numbers them too: each number is one stop, beside its own lines ("⑤ 7": the 7 is at stop 5 on the map). */
function SignBody({ name, stop, here, others, nums, walks, count, explore }: {
  name: string; stop: string; here: string[]; others: string[]; nums: { here: number; others: { n: number; lines: string[] }[] } | null;
  walks: { name: string; secs: number }[]; count: number; explore: (() => void) | null;
}) {
  return (
    <>
      <p className="callout-title text-[14px] leading-[17px]">{name}</p>
      {stop !== name && <p className="text-[11px] font-semibold leading-[13px] text-sign-muted">{stop}</p>}
      {others.length ? (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] items-center gap-x-1.5 gap-y-1">
          <dt className="sign-dt">This stop</dt>
          <dd className="flex items-center gap-[3px]">{nums && <SignNum n={nums.here} sel />}<Marks lines={here} size="2xs" gap={2} /></dd>
          <dt className="sign-dt self-start pt-[3px]">Transfer</dt>
          <dd className="flex flex-col gap-[3px]">
            {nums
              ? balanceRows(nums.others, (g) => g.lines.length + 1, 8).map((row) => (
                <span key={row[0].n} className="flex flex-wrap items-center gap-x-[7px] gap-y-[2px]">
                  {row.map((g) => <span key={g.n} className="flex items-center gap-[3px]"><SignNum n={g.n} /><Marks lines={g.lines} size="3xs" gap={2} /></span>)}
                </span>
              ))
              : markRows(others).map((row) => <Marks key={row[0]} lines={row} size="3xs" gap={2} />)}
          </dd>
        </dl>
      ) : (
        <div className="mt-1.5"><Marks lines={here} size="2xs" gap={2} /></div>
      )}
      {walks.map((w) => (
        <p key={w.name} className="mt-1.5 border-t border-white/15 pt-1 text-[10.5px] font-semibold leading-[13px] text-sign-muted">
          Transfer to {w.name} · allow {transferMinutes(w.secs)}
        </p>
      ))}
      {count > 1 && (
        <div className="mt-1.5 border-t border-white/15 pt-1 text-[10.5px] font-semibold leading-[13px] text-sign-muted">
          <p>{count} connected stops {nums ? "numbered" : "highlighted"} on the map</p>
          {/* for pointer users: the panel's own Connections tab is the keyboard route */}
          {explore && <button type="button" tabIndex={-1} onClick={explore} className="sign-explore mt-0.5 block">Explore connections ›</button>}
        </div>
      )}
    </>
  );
}

function TipBody({ title, lines, foot, num }: { title: string; lines: string[]; foot: string | null; num?: string | null }) {
  return (
    <>
      <p className="callout-title flex items-center gap-1.5 text-[13px]">
        {num && <span className="tip-num" aria-hidden="true">{num}</span>}
        {title}
      </p>
      <div className="mt-[5px]"><Marks lines={lines} size="xs" /></div>
      {foot && <p className="mt-[5px] text-[11px] font-semibold leading-[14px] text-[var(--tip-muted)]">{foot}</p>}
    </>
  );
}

// ------------------------------------------------------------------ the map
// key: reached with [ and ], so it stands for the whole station. exact: this one stop (its number, or a numbered
// station's own marker), not every stop drawn at the same spot
type Hover = { id: number; i: number; key?: boolean; exact?: boolean };

export function SubwayMap() {
  const { data, base, stationsById, complexes, walks, transfer, route, focus, selectedStop, chooseStop, journey, pick, explore } = useMap();
  const { routes } = useLive();
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View | null>(null);
  const viewRef = useRef<View | null>(null);
  const anim = useRef<number | null>(null);
  const flight = useRef<object | null>(null); // the current fly-to; any gesture clears it
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const moved = useRef(false);
  const pointerType = useRef("mouse");
  const [hover, setHover] = useState<Hover | null>(null);
  const [keyHint, setKeyHint] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    };
    queueMicrotask(measure); // don't wait for the first observer frame (it never comes in a background tab)
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback((pts: { x: number; y: number }[], pad = 48, maxK = 6, right = 0): View => {
    // `right`: extra space kept clear on the right (zoom controls, labels that extend to the right)
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const w = size.w - right;
    const k = clampK(Math.min((w - pad * 2) / Math.max(x1 - x0, 1), (size.h - pad * 2) / Math.max(y1 - y0, 1), maxK));
    return { k, x: w / 2 - ((x0 + x1) / 2) * k, y: size.h / 2 - ((y0 + y1) / 2) * k };
  }, [size]);

  const home = useCallback((d: MapData) => {
    const p = (lon: number, lat: number) => ({ x: (lon * d.proj.kx - d.proj.minx) * d.proj.s, y: (d.proj.maxy - lat) * d.proj.s });
    return fit([p(HOME.lon0, HOME.lat1), p(HOME.lon1, HOME.lat0)], 12, 4);
  }, [fit]);

  const stopFlight = () => {
    if (anim.current) cancelAnimationFrame(anim.current);
    anim.current = null;
    flight.current = null;
  };
  const animateTo = useCallback((target: View) => {
    if (anim.current) cancelAnimationFrame(anim.current);
    const start = viewRef.current;
    if (!start || reducedMotion() || document.visibilityState === "hidden") { // no frames arrive in a hidden tab
      setView(target);
      return;
    }
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / 460);
      const e = 1 - Math.pow(1 - p, 3);
      // interpolate zoom geometrically so flying in and out feels even
      const k = start.k * Math.pow(target.k / start.k, e);
      const cx = (size.w / 2 - start.x) / start.k + ((size.w / 2 - target.x) / target.k - (size.w / 2 - start.x) / start.k) * e;
      const cy = (size.h / 2 - start.y) / start.k + ((size.h / 2 - target.y) / target.k - (size.h / 2 - start.y) / start.k) * e;
      setView({ k, x: size.w / 2 - cx * k, y: size.h / 2 - cy * k });
      if (p < 1) anim.current = requestAnimationFrame(step);
      else { anim.current = null; flight.current = null; }
    };
    anim.current = requestAnimationFrame(step);
    // if frames are throttled (background pane), land on the target anyway
    const token = {};
    flight.current = token;
    setTimeout(() => {
      if (flight.current === token && anim.current != null) {
        cancelAnimationFrame(anim.current);
        anim.current = null;
        setView(target);
      }
    }, 900);
  }, [size]);

  // overview: set during render as soon as the size is known, and re-fitted on resize until the rider moves the map
  if (data && size.w >= 50 && (!view || (view.auto && (view.auto.w !== size.w || view.auto.h !== size.h)))) {
    setView({ ...home(data), auto: { w: size.w, h: size.h } });
  }
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const net = useMemo(() => (data ? buildNetwork(data) : null), [data]);
  const trackMarks = useMemo(() => (data ? shuttleMarks(data) : []), [data]);
  const hasView = view != null;

  /** A view at zoom k centred on stop p (narrow maps keep it clear of the zoom controls). `short`: a multi-stop station on
   *  a short map, which has room for the sign on one side only, the side away from the other stops: so your stop sits
   *  high when the others lie north of it (sign below) and low when they lie south (sign above). */
  const frameStop = useCallback((p: { x: number; y: number }, k: number, short: { x: number; y: number }[] | null): View => {
    const cx = size.w < 600 ? (size.w - 60) / 2 : size.w / 2;
    const cy = short ? size.h * (othersNorth(short, p) ? 0.34 : 0.68) : size.h / 2;
    return { k, x: cx - p.x * k, y: cy - p.y * k };
  }, [size]);

  // ---- react to selections (station focus, line, journey)
  const journeyStations = useMemo(() => journey?.legs.flatMap((l) => l.stations) ?? [], [journey]);
  useEffect(() => {
    if (!data || !viewRef.current) return;
    if (journeyStations.length) {
      animateTo(fit(journeyStations.map((id) => stationsById.get(id)!).filter(Boolean), 48, 9, 150));
    } else if (focus != null && stationsById.get(focus)) {
      // centre on the selected stop (never a made-up centre point); a station page opens a multi-stop complex close
      // enough to number its stops (a little further out on a short map), and choosing another of its stops (map or
      // Connections) glides there
      const s = stationsById.get(focus)!, stops = net?.stops.get(focus);
      const p = (stops && selectedStop != null ? stops[selectedStop] : undefined) ?? s;
      const complex = !!stops && stops.length > 1 && !!explore;
      const short = complex && size.h < SHORT_MAP;
      animateTo(frameStop(p, Math.max(viewRef.current.k, complex ? (short ? 8 : 10) : 5), short ? stops! : null));
    } else if (route) {
      const pts = data.stations.filter((s) => s.routes.includes(route));
      if (pts.length) animateTo(fit(pts, 40, 7, 56));
    }
  }, [focus, selectedStop, explore, net, route, journeyStations, data, stationsById, fit, frameStop, animateTo, size, hasView]);

  // Opening a station's Connections section brings its stops close enough to tell apart. A short map (the phone strip)
  // keeps the station page's framing instead (zoom 8, your stop placed so the sign has a side of its own): fitted closer,
  // the stops would leave the sign nowhere to go but over their numbers.
  const exploring = transfer?.id ?? null;
  const selectedRef = useRef(selectedStop);
  useEffect(() => {
    selectedRef.current = selectedStop;
  }, [selectedStop]);
  useEffect(() => {
    if (exploring == null || !viewRef.current) return;
    const stops = net?.stops.get(exploring);
    if (size.h < SHORT_MAP && stops && stops.length > 1) {
      animateTo(frameStop(stops[selectedRef.current ?? -1] ?? stops[primaryStop(stops)], 8, stops));
      return;
    }
    const pts = [
      ...(complexes.get(exploring)?.stops ?? []),
      ...walks.filter((t) => t.a === exploring || t.b === exploring).flatMap((t) => [{ x: t.ax, y: t.ay }, { x: t.bx, y: t.by }]),
    ];
    if (pts.length) animateTo(fit(pts, 72, 16, 110));
  }, [exploring, complexes, walks, net, size, fit, frameStop, animateTo]);

  // ---- gestures
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView((v) => {
      if (!v) return v;
      const k = clampK(v.k * factor);
      const f = k / v.k;
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopFlight();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const v = view ?? { k: 1, x: 0, y: 0 };
  const kb = zoomBucket(v.k);

  // ---- street grid: fetch only the tiles in view, only once zoomed in
  const [streetIdx, setStreetIdx] = useState<(StreetIndex & { set: Set<string> }) | null>(null);
  const [tiles, setTiles] = useState<Record<string, StreetTile>>({});
  const wantStreets = v.k >= STREET_K;
  useEffect(() => {
    if (!wantStreets || streetIdx) return;
    void loadStreetIndex().then((i) => {
      if (i) setStreetIdx({ ...i, set: new Set(i.tiles) });
    });
  }, [wantStreets, streetIdx]);
  const visibleKey = wantStreets && streetIdx ? visibleTiles(v, size.w, size.h, streetIdx.size, streetIdx.set).join(",") : "";
  useEffect(() => {
    for (const key of visibleKey ? visibleKey.split(",") : []) {
      void loadTile(key).then((t) => {
        if (t) setTiles((p) => (p[key] ? p : { ...p, [key]: t }));
      });
    }
  }, [visibleKey]);
  const streetNames = useMemo(() => {
    if (kb < STREET_NAMES_K || !visibleKey) return [];
    return visibleKey.split(",").flatMap((key) => (tiles[key]?.n ?? []).map((n, i) => ({ key: `bs${key}-${i}`, t: n[0], x: n[1], y: n[2], r: n[3] })));
  }, [kb, visibleKey, tiles]);

  // ---- what's selected
  const routeIdx = route && net ? net.routeIndex.get(route) ?? null : null;
  const legs = useMemo(
    () => (journey && data && net ? journey.legs.map((l) => legPath(data, net, l.route, l.stations, stationsById)) : []),
    [journey, data, net, stationsById],
  );
  const active = useMemo(() => {
    if (journey) return new Set(journeyStations);
    if (route && data) return new Set(data.stations.filter((s) => s.routes.includes(route)).map((s) => s.id));
    return null;
  }, [journey, journeyStations, route, data]);
  // the selected station gets a sign instead of a label (a planned journey keeps its end labels)
  const signId = !journey && focus != null ? focus : null;
  // while a station is selected, other stations step back (its separate-station transfer stays)
  const focusIds = useMemo(() => (signId == null ? null
    : new Set([signId, ...walks.filter((w) => w.a === signId || w.b === signId).map((w) => (w.a === signId ? w.b : w.a))])), [signId, walks]);

  // ---- labels: stations first (by importance), then area labels where there's room
  const labels = useMemo(
    () => (data && net ? layoutLabels(data, net, base, kb, signId, journey, active, streetNames) : []),
    [data, net, base, kb, signId, journey, active, streetNames],
  );
  const marksShown = kb >= CONNECT_K && active == null; // shuttle marks: street zoom, nothing else highlighted

  if (!data || !net) {
    // same element as the loaded map, so the size observer and wheel listener stay attached
    return (
      <div key="map" ref={box} className="relative grid h-full w-full place-items-center bg-[var(--water)]">
        <p className="rounded-full bg-bg px-4 py-2 text-sm font-semibold text-muted">Loading the subway map…</p>
      </div>
    );
  }

  // ---- pointing, tapping and stepping through stations
  const sx = (x: number) => x * v.k + v.x, sy = (y: number) => y * v.k + v.y;
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = box.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const isDrawn = (id: number, major: boolean) => kb >= 1.5 || major || !!active?.has(id);
  /** The stop nearest a screen point, within maxPx. `drawnOnly`: skip stations that have no marker at this zoom. */
  const nearest = ([px, py]: [number, number], maxPx: number, drawnOnly: boolean) => {
    const wx = (px - v.x) / v.k, wy = (py - v.y) / v.k;
    let best: HitStop | null = null, bd = maxPx / v.k;
    for (const h of net.hits) {
      if (drawnOnly && !isDrawn(h.id, h.major)) continue;
      const dx = h.x - wx, dy = h.y - wy;
      if (Math.abs(dx) > bd || Math.abs(dy) > bd) continue;
      const d = Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  };
  /** The stops of one station that draw as one marker with stop i at this zoom. */
  const groupOf = (id: number, i: number) => {
    const list = net.stops.get(id)!, p = list[i];
    return list.flatMap((q, j) => (Math.hypot(q.x - p.x, q.y - p.y) * v.k < MERGE_PX ? [j] : []));
  };
  /** What's under a screen point: a number of the selected station first (numbers can sit off their stops), then the
   *  nearest stop. A numbered station's stops are told apart by their numbers, so pointing at one is exact. */
  const hitAt = (pt: [number, number], maxPx: number, drawnOnly: boolean): Hover | null => {
    let best: Hover | null = null, bd = Infinity;
    for (const d of discs) {
      if (d.i == null || !d.label) continue;
      const dist = Math.hypot(sx(d.x) - pt[0], sy(d.y) - pt[1]);
      if (dist < d.r + maxPx / 3 && dist < bd) { bd = dist; best = { id: sel!.id, i: d.i, exact: true }; }
    }
    if (best) return best;
    const h = nearest(pt, maxPx, drawnOnly);
    return h ? { id: h.id, i: h.i, exact: numbered && h.id === sel?.id } : null;
  };
  const pointAt = (pt: [number, number]) => {
    const h = hitAt(pt, 14, true);
    setHover((p) => {
      if (!h) return p?.key ? p : null;
      return p && !p.key && p.id === h.id && p.i === h.i && !!p.exact === !!h.exact ? p : h;
    });
  };
  const open = (id: number, i: number | null, exact = false) => {
    setHover(null);
    if (pick) {
      pick(id);
      return;
    }
    if (i != null) {
      const g = exact ? [i] : groupOf(id, i);
      chooseStop(id, g.length > 1 ? primaryStop(net.stops.get(id)!, g) : i);
    }
    if (focus !== id) router.push(`/station/${id}`);
  };
  const stepStations = (dir: 1 | -1) => {
    const list = data.stations
      .filter((s) => isDrawn(s.id, s.nodes.length > 1 || s.routes.length >= 6))
      .map((s) => ({ s, X: sx(s.x), Y: sy(s.y) }))
      .filter(({ X, Y }) => X > 8 && Y > 8 && X < size.w - 8 && Y < size.h - 8)
      .sort((a, b) => Math.floor(a.Y / 32) - Math.floor(b.Y / 32) || a.X - b.X); // reading order
    if (!list.length) return;
    const at = hover?.key ? list.findIndex((q) => q.s.id === hover.id) : -1;
    const n = list.length;
    const next = list[at < 0 ? (dir > 0 ? 0 : n - 1) : (at + dir + n) % n].s;
    setHover({ id: next.id, i: primaryStop(net.stops.get(next.id)!), key: true });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pointerType.current = e.pointerType;
    moved.current = false;
    stopFlight();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) {
      if (e.pointerType !== "touch") pointAt(local(e));
      return;
    }
    const pts = [...pointers.current.values()];
    if (pts.length === 2) {
      const other = pts.find((p) => p !== prev)!;
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      const r = box.current!.getBoundingClientRect();
      moved.current = true;
      if (before > 0) zoomAt(after / before, (e.clientX + other.x) / 2 - r.left, (e.clientY + other.y) / 2 - r.top);
    } else {
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved.current = true;
      setView((p) => (p ? { k: p.k, x: p.x + dx, y: p.y + dy } : p));
    }
    if (moved.current && hover && !hover.key) setHover(null); // dragging: no tooltip
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
  };
  const onClick = (e: React.MouseEvent) => {
    if (moved.current || (e.target as Element).closest("button, a")) return;
    const h = hitAt(local(e), pointerType.current === "touch" ? 22 : 14, false);
    if (h) open(h.id, h.i, h.exact);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return; // the zoom buttons handle their own keys
    const step = 60;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => setView((p) => p && { k: p.k, x: p.x + step, y: p.y }),
      ArrowRight: () => setView((p) => p && { k: p.k, x: p.x - step, y: p.y }),
      ArrowUp: () => setView((p) => p && { k: p.k, x: p.x, y: p.y + step }),
      ArrowDown: () => setView((p) => p && { k: p.k, x: p.x, y: p.y - step }),
      "+": () => zoomAt(1.4, size.w / 2, size.h / 2),
      "=": () => zoomAt(1.4, size.w / 2, size.h / 2),
      "-": () => zoomAt(1 / 1.4, size.w / 2, size.h / 2),
      "]": () => stepStations(1),
      "[": () => stepStations(-1),
    };
    if (hover?.key) {
      keys.Enter = keys[" "] = () => open(hover.id, null);
      keys.Escape = () => setHover(null);
    }
    if (keys[e.key]) {
      e.preventDefault();
      keys[e.key]();
    }
  };

  // ---- the selected station, journey ends, and what's pointed at
  const color = (r: string) => `#${routes[r]?.color ?? data.colors[data.segs.find((s) => s.r.includes(net.routeIndex.get(r) ?? -1))?.c[0] ?? 0]}`;
  const order = byOrder(routes);
  const mark = (id: number, p: { x: number; y: number }): Mark => ({ x: p.x, y: p.y, r: markerRadius(net, kb, net.interchange.has(id), p.x, p.y) });
  const pxOf = (m: Mark) => (m.r * v.k) / kb;
  const onScreen = (X: number, Y: number) => X > -2 && Y > -2 && X < size.w + 2 && Y < size.h + 2;
  const detail = kb >= CONNECT_K;

  const sel = signId != null ? stationsById.get(signId) : undefined;
  const selStops = sel ? net.stops.get(sel.id)! : [];
  const selIdx = sel ? (selectedStop != null && selStops[selectedStop] ? selectedStop : primaryStop(selStops)) : -1;
  const under = new Set(sel ? groupOf(sel.id, selIdx) : []); // drawn under the selected marker
  const selWalks = sel ? walks.filter((w) => w.a === sel.id || w.b === sel.id) : [];
  const selComplex = sel ? complexes.get(sel.id) : undefined;
  const partners = selWalks.map((w) => (w.a === sel!.id ? { id: w.b, x: w.bx, y: w.by, r: w.br } : { id: w.a, x: w.ax, y: w.ay, r: w.ar }));
  // The complex's stops are numbered in the station header's line order: the same numbers as in Connections and on
  // the sign. Close enough to read, every stop carries its own number: on its own marker, or, when other stops are too
  // close to tell apart (Times Sq's 1/2/3 and 7), just off it with a short leader. Stops never move. If the numbers
  // can't all be placed cleanly at this zoom, the stops are highlighted without them.
  const numbering = selStops.length > 1 ? stopOrder(selStops, (r) => routes[r]?.sort_order ?? 99) : [];
  const numberOf = (j: number) => numbering.indexOf(j) + 1;
  const dotPx = sel ? Math.max(...selStops.map((p) => pxOf(mark(sel.id, p)))) : 0;
  const numR = Math.max(NUMBER_R, dotPx + 1.5);
  const keepOut = (): Box | undefined => {
    if (size.h >= SHORT_MAP) return undefined; // a wide map has room for the sign beside your stop
    const p = selStops[selIdx], X = p.x * v.k, Y = p.y * v.k;
    return othersNorth(selStops, p) ? [X - 400, Y + numR + 4, X + 400, Y + 400] : [X - 400, Y - 400, X + 400, Y - numR - 4];
  };
  const spots = sel && detail && kb >= NUMBER_K && numbering.length
    ? placeNumbers(selStops.map((p) => ({ x: p.x * v.k, y: p.y * v.k })), numbering, {
      r: numR + 3, dot: dotPx + 3.5, inlinePx: numR * 2 + 4, own: { i: selIdx, px: numR + dotPx + 2 }, keepOut: keepOut(),
      avoid: (selComplex?.links ?? []).map(([i, j]) => [selStops[i].x * v.k, selStops[i].y * v.k, selStops[j].x * v.k, selStops[j].y * v.k]),
    })
    : null;
  const numbered = spots != null;
  const listed = (a: number, b: number) => !!selComplex?.t.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

  const discs: Disc[] = [];
  if (sel) {
    const selKey = `s${sel.id}-${selIdx}`;
    if (spots) {
      selStops.forEach((p, j) => {
        const s = spots[j], mine = j === selIdx;
        discs.push({ x: s.x / v.k, y: s.y / v.k, r: numR, key: mine ? selKey : `n${sel.id}-${j}`, sel: mine, label: String(numberOf(j)), stop: s.inline ? undefined : mark(sel.id, p), i: j });
      });
    } else {
      discs.push({ ...mark(sel.id, selStops[selIdx]), key: selKey, sel: true, label: null });
      selStops.forEach((p, j) => { if (!under.has(j)) discs.push({ ...mark(sel.id, p), key: `r${sel.id}-${j}`, sel: false, label: null }); });
    }
    partners.forEach((p) => discs.push({ ...mark(p.id, p), key: `w${p.id}`, sel: false, label: null }));
  } else if (journey) {
    const first = journey.legs[0], last = journey.legs.at(-1)!;
    for (const [id, r] of [[first.boardStation, first.route], [last.alightStation, last.route]] as const) {
      const list = net.stops.get(id);
      if (list) discs.push({ ...mark(id, list[stopFor(list, r)]), key: `e${id}`, sel: true, label: null });
    }
  }
  for (const d of discs) if (d.sel && !d.label) d.r = Math.max(d.r, 5.5);
  const discPx = (d: Disc) => (d.label ? d.r : (d.r * v.k) / kb);
  const around = (X: number, Y: number, h: number): Box => [X - h, Y - h, X + h, Y + h];
  /** What the sign and tooltips keep clear of: a stop's number, and its own marker when the number sits off it. */
  const boxesOf = (d: Disc, number = true): Box[] => [
    ...(number ? [around(sx(d.x), sy(d.y), discPx(d) + 4)] : []),
    ...(d.stop ? [around(sx(d.stop.x), sy(d.stop.y), pxOf(d.stop) + 4)] : []),
  ];
  const links: Seg[] = detail && selComplex ? selComplex.links.map(([i, j]) => [selStops[i].x, selStops[i].y, selStops[j].x, selStops[j].y]) : [];
  const walkSegs: Seg[] = detail ? selWalks.map((w) => [w.ax, w.ay, w.bx, w.by]) : [];

  /** A stop as the rider sees it: its number when the selected station is numbered, else its marker. */
  const shownAt = (id: number, j: number): Ring => {
    const d = numbered && id === sel?.id ? discs.find((q) => q.i === j) : undefined;
    if (d) return { x: d.x, y: d.y, px: d.r };
    const m = mark(id, net.stops.get(id)![j]);
    return { x: m.x, y: m.y, px: pxOf(m) };
  };
  // pointed at on the map (not the selected stop: its sign already says it all), or a stop row in Connections
  const hov = hover && stationsById.get(hover.id) ? hover : null;
  const hovGroup = hov ? (hov.key ? net.stops.get(hov.id)!.map((_, j) => j) : hov.exact ? [hov.i] : groupOf(hov.id, hov.i)) : [];
  const tipShown = hov && !(sel && hov.id === sel.id && !hov.key && hovGroup.includes(selIdx)) ? hov : null;
  const rings: Ring[] = tipShown ? hovGroup.map((j) => shownAt(tipShown.id, j)) : [];
  const row = sel && transfer?.id === sel.id && transfer.hover != null && transfer.hover !== selIdx && selStops[transfer.hover] ? transfer.hover : null;
  if (row != null) rings.push(shownAt(sel!.id, row));
  // the transfer from your stop to the one pointed at, only where MTA lists it; its leader turns the pointing colour
  const pointed = row ?? (sel && tipShown && tipShown.id === sel.id && !tipShown.key && hovGroup.length === 1 ? tipShown.i : null);
  const focusLink: Seg | null = detail && sel && pointed != null && listed(selIdx, pointed)
    ? [selStops[selIdx].x, selStops[selIdx].y, selStops[pointed].x, selStops[pointed].y] : null;
  const hot = pointed != null ? discs.find((d) => d.i === pointed && d.stop)?.key ?? null : null;

  const labelBoxes = labels.map((l) => {
    const ox = l.x * (v.k - kb) + v.x, oy = l.y * (v.k - kb) + v.y; // placed at kb, drawn at k
    return { key: l.key, box: [l.box[0] + ox, l.box[1] + oy, l.box[2] + ox, l.box[3] + oy] as Box };
  });

  // ---- callouts: sign first (it wins the best spot), then one tooltip at most. No route badges around the station:
  // the sign lists every line, the numbers show where the stops are, and a stop's own lines show when it's pointed at.
  const items: CalloutItem[] = [];
  let live = "";
  if (sel) {
    const p = selStops[selIdx];
    const here = lineIds(p.r).sort(order);
    const others = lineIds(selStops.flatMap((q, j) => (j === selIdx ? [] : q.r))).filter((r) => !here.includes(r)).sort(order);
    const mine = discs.find((d) => d.sel)!;
    // The sign points at your stop: its number when the map numbers the stops (set off with a leader to the real stop
    // when stops crowd together, so pointing at the number keeps it clear of every other number), else its marker.
    // It keeps clear of every other number and stop marker.
    const X = sx(mine.x), Y = sy(mine.y);
    const stopBoxes = discs.flatMap((d) => (d.sel ? boxesOf(d, false) : boxesOf(d)));
    const nums = numbered ? {
      here: numberOf(selIdx),
      others: numbering.filter((j) => j !== selIdx).map((j) => ({ n: numberOf(j), lines: lineIds(selStops[j].r).sort(order) })),
    } : null;
    if (onScreen(X, Y)) {
      items.push({
        key: `sign${sel.id}-${selIdx}`, kind: "sign", x: X, y: Y, gap: discPx(mine) + (mine.label ? 6 : 10),
        order: ["right", "left", "top", "bottom"], hard: stopBoxes, reach: [12, 24, 36, 48, 60],
        body: <SignBody name={sel.name} stop={p.n} here={here} others={others} nums={nums} count={selStops.length}
          explore={transfer?.id === sel.id ? null : explore}
          walks={selWalks.map((w) => ({ name: stationsById.get(w.a === sel.id ? w.b : w.a)?.name ?? "a nearby station", secs: w.s }))} />,
      });
    }
    // Connections tab: the stop row being pointed at (hover or keyboard focus) is named on the map, one at a time
    if (row != null && !tipShown) {
      const q = selStops[row], at = shownAt(sel.id, row), X2 = sx(at.x), Y2 = sy(at.y);
      if (onScreen(X2, Y2)) {
        items.push({
          key: `row${sel.id}-${row}`, kind: "tip", x: X2, y: Y2, gap: at.px + 9, order: ["top", "right", "left", "bottom"], hard: stopBoxes,
          body: <TipBody title={q.n} lines={lineIds(q.r).sort(order)} foot={null} num={String(numberOf(row))} />,
        });
      }
    }
  }
  if (tipShown) {
    const st = stationsById.get(tipShown.id)!, list = net.stops.get(st.id)!;
    const whole = hovGroup.length === list.length;
    const names = new Set(hovGroup.map((j) => list[j].n));
    const title = whole || names.size > 1 ? st.name : list[hovGroup[0]].n;
    const lines = lineIds(hovGroup.flatMap((j) => list[j].r)).sort(order);
    const foot = list.length < 2 ? null
      : whole ? `${list.length} connected stops`
      : title !== st.name ? `Part of ${st.name} · ${list.length} stops`
      : `${hovGroup.length === 1 ? "One" : hovGroup.length} of ${list.length} connected stops`;
    // a stop of the selected station carries its number, as on the map and in Connections
    const num = sel && st.id === sel.id && !whole && numbering.length ? hovGroup.map(numberOf).sort((a, b) => a - b).join(" ") : null;
    const at = shownAt(st.id, tipShown.i), X = sx(at.x), Y = sy(at.y);
    if (onScreen(X, Y)) {
      items.push({ key: `tip${st.id}-${tipShown.i}${tipShown.key ? "k" : ""}`, kind: "tip", x: X, y: Y, gap: at.px + 10, order: ["top", "right", "left", "bottom"], body: <TipBody title={title} lines={lines} foot={foot} num={num} /> });
    }
    if (tipShown.key) live = `${title}: ${lines.map((r) => routes[r]?.short_name ?? r).join(", ")} trains. ${foot ? foot + ". " : ""}Press Enter to open.`;
  }

  // keep callouts inside the map and clear of its controls; labels are soft obstacles
  const bounds: Box = [8, 8, size.w - 8, size.h - 22];
  const hard: Box[] = [[size.w - 62, 4, size.w, 154]];
  if (pick) hard.push([size.w / 2 - 140, 0, size.w / 2 + 140, 54]);
  if ((route && !journey) || keyHint) hard.push([0, size.h - 96, 300, size.h]);
  const endIds = new Set<number>(journey ? [journey.legs[0].boardStation, journey.legs.at(-1)!.alightStation] : []);

  return (
    <div
      key="map"
      ref={box}
      tabIndex={0}
      role="application"
      aria-label="Subway map. Drag or use arrow keys to move, plus and minus to zoom. Press ] and [ to step through the stations in view, Enter to open one. Every station is also available through search."
      onKeyDown={onKey}
      onFocus={(e) => { if (e.target === e.currentTarget && e.currentTarget.matches(":focus-visible")) setKeyHint(true); }}
      onBlur={(e) => {
        if (e.target !== e.currentTarget) return;
        setKeyHint(false);
        setHover((p) => (p?.key ? null : p));
      }}
      className={`relative h-full w-full touch-none select-none overflow-hidden bg-[var(--water)] ${tipShown && !tipShown.key ? "cursor-pointer" : pick ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setHover((p) => (p?.key ? p : null))}
      onClick={onClick}
    >
      {/* out of flow: a fixed-width svg would stop the map shrinking when the window narrows, pushing the rail off screen */}
      <svg width={size.w} height={size.h} className="absolute inset-0 block">
        <g transform={`translate(${v.x},${v.y}) scale(${v.k})`}>
          {base && <BaseLayer base={base} />}
          {visibleKey && (
            <g opacity={Math.min(1, 0.35 + (v.k - STREET_K) / 1.5)}>
              {visibleKey.split(",").map((key) => tiles[key] && <StreetLayer key={key} d={tiles[key].d} width={(kb < 8 ? 1 : kb < 14 ? 2 : 3.2) / kb} />)}
            </g>
          )}
          <AreaLabels labels={labels} k={v.k} />
          <NetworkLayer data={data} kb={kb} dim={active != null} />
          {routeIdx != null && !journey && <RouteLayer key={route} data={data} kb={kb} routeIdx={routeIdx} color={color(route!)} />}
          {journey && <JourneyLayer key={journey.legs.map((l) => l.route + l.boardStation).join()} legs={legs} kb={kb} colors={journey.legs.map((l) => color(l.route))} />}
          {marksShown && <TrackMarks marks={trackMarks} k={v.k} kb={kb} labels={labels} label={(r) => routes[r]?.short_name ?? "S"} />}
          <StationLayer data={data} net={net} kb={kb} active={active} focusIds={focusIds} />
          <Highlights k={v.k} kb={kb} discs={discs} rings={rings} hot={hot} links={links} walks={walkSegs} focusLink={focusLink}
            strong={!!sel && transfer?.id === sel.id} ping={discs.find((d) => d.sel)?.key ?? null} />
          <StationLabels labels={labels} k={v.k} ends={endIds} />
        </g>
      </svg>

      <Callouts items={items} bounds={bounds} hard={hard} labels={labelBoxes} />
      <p className="sr-only" aria-live="polite">{live}</p>

      <div className="absolute right-3 top-3 flex flex-col overflow-hidden rounded-xl border border-rule bg-bg/95 shadow-[0_2px_10px_rgba(0,0,0,.12)] backdrop-blur">
        <button type="button" aria-label="Zoom in" className="press h-11 w-11 text-xl font-bold hover:bg-bg-2" onClick={() => zoomAt(1.5, size.w / 2, size.h / 2)}>+</button>
        <button type="button" aria-label="Zoom out" className="press h-11 w-11 border-t border-rule text-xl font-bold hover:bg-bg-2" onClick={() => zoomAt(1 / 1.5, size.w / 2, size.h / 2)}>−</button>
        <button type="button" aria-label="Back to the overview" title="Overview" className="press grid h-11 w-11 place-items-center border-t border-rule hover:bg-bg-2" onClick={() => animateTo(home(data))}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2 7V2h5M16 7V2h-5M2 11v5h5M16 11v5h-5" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
        </button>
      </div>
      {pick && (
        <p className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-sign px-4 py-2 text-sm font-bold text-sign-text shadow-lg">
          Tap a station on the map
        </p>
      )}
      <div className="pointer-events-none absolute bottom-7 left-3 flex flex-col items-start gap-1.5">
        {keyHint && (
          <p className="enter rounded-lg bg-bg/95 px-2.5 py-1.5 text-[12px] font-semibold text-text shadow-md">
            <kbd className="map-kbd">[</kbd> <kbd className="map-kbd">]</kbd> step through stations · <kbd className="map-kbd">Enter</kbd> opens
          </p>
        )}
        {route && !journey && routes[route] && (
          <p className="enter rounded-lg px-3 py-1.5 text-sm font-extrabold shadow-md"
            style={{ background: color(route), color: inkFor(routes[route].color) }}>
            {routes[route].short_name === "S" ? routes[route].long_name : `${routes[route].short_name} line`}
          </p>
        )}
      </div>
      <p title="Not an official MTA map. Subway lines and stations: MTA static GTFS. Land, water and parks: NYC Department of City Planning and NYC Parks (NYC Open Data), US Census Bureau. Streets: NYC Street Centerline, NYC Office of Technology and Innovation (NYC Open Data)."
        className="absolute bottom-0 right-0 max-w-full truncate rounded-tl-md bg-bg/90 px-2 py-0.5 text-[10.5px] font-medium text-muted">
        Not an official MTA map · Lines: MTA GTFS · Land, parks &amp; streets: NYC Open Data, US Census
      </p>
    </div>
  );
}

const spread = (s: MapStation) => Math.max(...s.nodes.map(([x, y]) => Math.hypot(x - s.x, y - s.y))) + 2;

// ------------------------------------------------------------------ labels
/** `skip`: the selected station, whose sign carries its name. */
function layoutLabels(data: MapData, net: Network, base: BaseData | null, kb: number, skip: number | null, journey: Journey | null, active: Set<number> | null,
  streetNames: { key: string; t: string; x: number; y: number; r: number }[]): PlacedLabel[] {
  const w = lineWidth(kb);
  const cands: LabelCandidate[] = [];
  const journeyKey = new Set<number>(journey ? [journey.legs[0].boardStation, ...journey.legs.map((l) => l.alightStation)] : []);
  for (const s of data.stations) {
    if (s.id === skip) continue;
    const ix = net.interchange.has(s.id);
    const major = s.routes.length >= 5 || s.nodes.length >= 3;
    let priority: number | null = null;
    if (journeyKey.has(s.id)) priority = 0;
    else if (active?.has(s.id)) priority = kb >= 1.6 ? 1 : major ? 1 : null;
    else if (active) priority = kb >= 3 ? 4 : null; // keep context sparse while something is selected
    else if (major && kb >= 0.85) priority = 2;
    else if (ix && kb >= 1.8) priority = 3;
    else if (kb >= 3.6) priority = 4;
    if (priority == null) continue;
    const close = kb >= CLOSE_LABEL_K;
    const fs = priority === 0 ? (close ? 15.5 : 14) : close ? 15 : priority <= 2 ? 12.5 : 11.5;
    const spreadPx = s.nodes.length > 1 ? spread(s) * kb : 0;
    cands.push({
      key: `s${s.id}`, text: s.name, x: s.x, y: s.y, fs, priority: priority * 1000 - s.routes.length * 10 - s.nodes.length,
      pad: Math.max(spreadPx, w * 1.6) + (priority === 0 ? 9 : close ? 7 : 4), dedupe: priority > 1,
      lines: close && priority !== 0 ? wrapName(s.name) : undefined,
    });
  }
  if (base) {
    for (const l of base.labels) {
      const show =
        l.k === "borough" ? kb < 2.6 :
        l.k === "region" ? kb < 3.2 :
        l.k === "water" ? (l.t === "Harlem River" ? kb >= 2.6 : kb >= 0.7) :
        l.k === "hood" ? (l.big ? kb >= 1.35 : kb >= 2.4) && kb < 12 :
        l.k === "park" ? (l.big ? kb >= 2.2 : kb >= 4.4) : false;
      if (!show) continue;
      const fs = l.k === "borough" ? 13 : l.k === "region" ? 11 : l.k === "hood" ? 11.5 : 11;
      cands.push({
        key: `b${l.t}`, text: l.t, x: l.x, y: l.y, fs, pad: 0, rotate: l.r, fixed: true,
        caps: l.k === "borough" || l.k === "region", priority: 10_000 + (l.k === "borough" ? 0 : l.k === "water" ? 1 : l.k === "hood" ? 2 : 3),
      });
    }
  }
  // street names last and quietest: they only fill the space that's left
  for (const n of streetNames) cands.push({ key: n.key, text: n.t, x: n.x, y: n.y, fs: 10.5, pad: 0, rotate: n.r, fixed: true, priority: 10_004 });
  return placeLabels(cands, kb, kb >= 9 ? 0 : 150);
}

const AreaLabels = memo(function AreaLabels({ labels, k }: { labels: PlacedLabel[]; k: number }) {
  return (
    <g aria-hidden="true" className="pointer-events-none">
      {labels.filter((l) => l.key.startsWith("b")).map((l) => {
        const kind = l.c.caps ? (l.c.fs >= 13 ? "borough" : "region") : l.c.priority === 10_001 ? "water" : l.c.priority === 10_003 ? "park" : l.c.priority === 10_004 ? "street" : "hood";
        return (
          <text key={l.key} data-label={l.key} x={l.x} y={l.y} dy={(l.c.fs * 0.35) / k} textAnchor="middle" fontSize={l.c.fs / k}
            transform={l.c.rotate ? `rotate(${l.c.rotate} ${l.x} ${l.y})` : undefined}
            className={`map-area map-${kind}`} style={{ letterSpacing: l.c.caps ? `${0.2 * (l.c.fs / k)}px` : undefined, strokeWidth: kind === "street" ? 2.5 / k : undefined }}>
            {l.text}
          </text>
        );
      })}
    </g>
  );
});

function StationLabels({ labels, k, ends }: { labels: PlacedLabel[]; k: number; ends: Set<number> }) {
  return (
    <g className="pointer-events-none">
      {labels.filter((l) => l.key.startsWith("s")).map((l) => {
        const id = Number(l.key.slice(1));
        const fs = l.c.fs / k;
        const x = l.x + l.dx / k, y = l.y + l.dy / k;
        if (ends.has(id)) {
          // a journey's ends read like their own signs: white on black
          const wpx = l.text.length * l.c.fs * 0.56 + 14;
          const left = l.anchor === "start" ? x - 7 / k : l.anchor === "end" ? x - wpx / k + 7 / k : x - wpx / 2 / k;
          return (
            <g key={l.key} data-label={l.key} className="enter">
              <rect x={left} y={y - fs * 1.05} width={wpx / k} height={fs * 1.5} rx={4 / k} fill="var(--sign)" stroke="var(--plate-edge)" strokeWidth={1 / k} />
              <text x={left + 7 / k} y={y} fontSize={fs} fontWeight={800} fill="var(--sign-text)">{l.text}</text>
            </g>
          );
        }
        return (
          <text key={l.key} data-label={l.key} x={x} y={y} textAnchor={l.anchor} fontSize={fs} fontWeight={l.c.lines || l.c.priority < 3000 ? 750 : 600}
            fill="var(--text)" stroke="var(--land)" strokeWidth={3.2 / k} strokeLinejoin="round" paintOrder="stroke">
            {l.c.lines ? l.c.lines.map((t, i) => <tspan key={i} x={x} dy={i ? fs * 1.2 : 0}>{t}</tspan>) : l.text}
          </text>
        );
      })}
    </g>
  );
}
