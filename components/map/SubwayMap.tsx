"use client";

// Interactive network map in one projection (public/data/map.json + basemap.json):
//   1. geography: land, water (everything that isn't land), parks, area labels (NYC Open Data, Census),
//      and, once zoomed in, the real street grid (NYC Street Centerline, loaded tile by tile)
//   2. network: one segment per pair of adjacent stations from MTA GTFS, routes bundled side by side by
//      trunk colour, interchanges joined by connectors drawn between their real station positions
//   3. selection: highlighted line, planned journey, focused station (always on top, strongest emphasis)
// Pan: drag / arrow keys. Zoom: wheel, pinch, +/- buttons or keys. Tap a station to open it (or to pick
// it in Plan). Nothing is drawn that isn't in the data: no schematic redraw, no invented track.
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLive } from "@/app/providers";
import { lineWidth, offsetLine, placeLabels, points, visibleTiles, zoomBucket, type LabelCandidate, type PlacedLabel } from "@/lib/headway/mapLayout";
import type { Journey } from "@/lib/headway/planner";
import { inkFor } from "../RouteMark";
import { useMap, type BaseData, type MapData, type MapStation } from "./MapContext";

interface View { k: number; x: number; y: number; auto?: { w: number; h: number } } // screen = world * k + (x, y); auto = untouched overview
const MIN_K = 0.45, MAX_K = 24;
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));
// Default framing: Manhattan, the Bronx line to 149 St, western Queens and Brooklyn to Prospect Park
const HOME = { lon0: -74.035, lon1: -73.87, lat0: 40.66, lat1: 40.83 };

// Street grid: context only, so a failed download simply leaves it out
const STREET_K = 4; // blocks are big enough to read from here
const STREET_NAMES_K = 9;
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

// ------------------------------------------------------------------ derived network structures
interface Network {
  hop: Map<string, number[]>; // "route|a|b" → segment indices
  nodeBundle: Map<string, number>; // "x,y" of a station node → most lines meeting there
  interchange: Set<number>; // complexes served by 2+ trunk colours or spread over 2+ stations
  connectors: Map<number, number[]>; // complex → flat [x0,y0,x1,y1, …] pairs: shortest links between its stations
  routeIndex: Map<string, number>;
}

/** Minimum spanning tree over a complex's station positions: transfer connectors without zig-zags. */
function spanningLinks(nodes: [number, number][]): number[] {
  const inTree = [0], out: number[] = [];
  const rest = nodes.map((_, i) => i).slice(1);
  while (rest.length) {
    let best: [number, number, number] = [Infinity, 0, 0];
    for (const a of inTree) for (const b of rest) {
      const d = Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]);
      if (d < best[0]) best = [d, a, b];
    }
    out.push(...nodes[best[1]], ...nodes[best[2]]);
    inTree.push(best[2]);
    rest.splice(rest.indexOf(best[2]), 1);
  }
  return out;
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
  for (const st of data.stations) {
    const cs = new Set(st.routes.map((r) => (trunks.has(r) ? trunks.get(r)! : (trunks.set(r, colourOf(r)), trunks.get(r)!))));
    if (st.nodes.length > 1 || cs.size > 1) interchange.add(st.id);
  }
  const connectors = new Map(data.stations.filter((st) => st.nodes.length > 1).map((st) => [st.id, spanningLinks(st.nodes)]));
  return { hop, nodeBundle, interchange, connectors, routeIndex };
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

const StationLayer = memo(function StationLayer({ data, net, kb, active }: { data: MapData; net: Network; kb: number; active: Set<number> | null }) {
  const w = lineWidth(kb);
  const showLocal = kb >= 1.5;
  return (
    <g aria-hidden="true">
      {data.stations.map((s) => {
        const ix = net.interchange.has(s.id);
        // zoomed out: only major interchanges (multi-station complexes, 6+ routes) keep a symbol
        const major = s.nodes.length > 1 || s.routes.length >= 6;
        if (!showLocal && !(major || active?.has(s.id))) return null;
        const faded = active != null && !active.has(s.id);
        const nodes = s.nodes.length ? s.nodes : [[s.x, s.y] as [number, number]];
        const radius = ([x, y]: number[]) => {
          const bundle = net.nodeBundle.get(`${x},${y}`) ?? 1;
          return ix ? Math.max(3.6, (bundle * w * 1.1) / 2 + 1.6) : Math.max(1.8, w * 0.62 + (bundle - 1) * w * 0.55);
        };
        const ring = ix ? 1.9 : 1.2;
        return (
          <g key={s.id} opacity={faded ? 0.4 : 1}>
            {/* a complex's stations stay separate circles at their real positions, joined by a thin link */}
            {nodes.length > 1 && (
              <path d={links(net.connectors.get(s.id)!)} fill="none" stroke="var(--station-link)" strokeWidth={Math.max(2.4, w * 0.75)} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
            )}
            {nodes.map((n, i) => (
              <circle key={i} cx={n[0]} cy={n[1]} r={radius(n) / kb} fill="var(--station-fill)" stroke="var(--station-ring)" strokeWidth={ring} vectorEffect="non-scaling-stroke" />
            ))}
          </g>
        );
      })}
    </g>
  );
});

// ------------------------------------------------------------------ the map
export function SubwayMap() {
  const { data, base, stationsById, route, focus, journey, pick } = useMap();
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
  const hasView = view != null;

  // ---- react to selections (station focus, line, journey)
  const journeyStations = useMemo(() => journey?.legs.flatMap((l) => l.stations) ?? [], [journey]);
  useEffect(() => {
    if (!data || !viewRef.current) return;
    if (journeyStations.length) {
      animateTo(fit(journeyStations.map((id) => stationsById.get(id)!).filter(Boolean), 48, 9, 150));
    } else if (focus != null && stationsById.get(focus)) {
      const s = stationsById.get(focus)!;
      const k = Math.max(viewRef.current.k, 5);
      const cx = size.w < 600 ? (size.w - 60) / 2 : size.w / 2; // narrow: keep it clear of the zoom controls
      animateTo({ k, x: cx - s.x * k, y: size.h / 2 - s.y * k });
    } else if (route) {
      const pts = data.stations.filter((s) => s.routes.includes(route));
      if (pts.length) animateTo(fit(pts, 40, 7, 56));
    }
  }, [focus, route, journeyStations, data, stationsById, fit, animateTo, size, hasView]);

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

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;
    stopFlight();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
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
      setView((v) => (v ? { k: v.k, x: v.x + dx, y: v.y + dy } : v));
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = 60;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => setView((v) => v && { k: v.k, x: v.x + step, y: v.y }),
      ArrowRight: () => setView((v) => v && { k: v.k, x: v.x - step, y: v.y }),
      ArrowUp: () => setView((v) => v && { k: v.k, x: v.x, y: v.y + step }),
      ArrowDown: () => setView((v) => v && { k: v.k, x: v.x, y: v.y - step }),
      "+": () => zoomAt(1.4, size.w / 2, size.h / 2),
      "=": () => zoomAt(1.4, size.w / 2, size.h / 2),
      "-": () => zoomAt(1 / 1.4, size.w / 2, size.h / 2),
    };
    if (keys[e.key]) {
      e.preventDefault();
      keys[e.key]();
    }
  };

  const select = (s: MapStation) => {
    if (moved.current) return; // a drag, not a tap
    if (pick) pick(s.id);
    else router.push(`/station/${s.id}`);
  };

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

  // ---- labels: stations first (by importance), then area labels where there's room
  const labels = useMemo(
    () => (data && net ? layoutLabels(data, net, base, kb, focus, journey, active, streetNames) : []),
    [data, net, base, kb, focus, journey, active, streetNames],
  );

  if (!data || !net) {
    // same element as the loaded map, so the size observer and wheel listener stay attached
    return (
      <div key="map" ref={box} className="relative grid h-full w-full place-items-center bg-[var(--water)]">
        <p className="rounded-full bg-bg px-4 py-2 text-sm font-semibold text-muted">Loading the subway map…</p>
      </div>
    );
  }
  const color = (r: string) => `#${routes[r]?.color ?? data.colors[data.segs.find((s) => s.r.includes(net.routeIndex.get(r) ?? -1))?.c[0] ?? 0]}`;
  const ends = new Set<number>(journey ? [journey.legs[0].boardStation, journey.legs.at(-1)!.alightStation] : focus != null ? [focus] : []);

  return (
    <div
      key="map"
      ref={box}
      tabIndex={0}
      role="application"
      aria-label="Subway map. Drag or use arrow keys to move, plus and minus to zoom. Every station is also available through search."
      onKeyDown={onKey}
      className={`relative h-full w-full touch-none select-none overflow-hidden bg-[var(--water)] ${pick ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <svg width={size.w} height={size.h} className="block">
        <g transform={`translate(${v.x},${v.y}) scale(${v.k})`}>
          {base && <BaseLayer base={base} />}
          {visibleKey && (
            <g opacity={Math.min(1, 0.35 + (v.k - STREET_K) / 1.5)}>
              {visibleKey.split(",").map((key) => tiles[key] && <StreetLayer key={key} d={tiles[key].d} width={(kb < 8 ? 1 : kb < 14 ? 1.7 : 2.6) / kb} />)}
            </g>
          )}
          <AreaLabels labels={labels} k={v.k} />
          <NetworkLayer data={data} kb={kb} dim={active != null} />
          {routeIdx != null && !journey && <RouteLayer key={route} data={data} kb={kb} routeIdx={routeIdx} color={color(route!)} />}
          {journey && <JourneyLayer key={journey.legs.map((l) => l.route + l.boardStation).join()} legs={legs} kb={kb} colors={journey.legs.map((l) => color(l.route))} />}
          <StationLayer data={data} net={net} kb={kb} active={active} />
          {[...ends].map((id) => {
            const s = stationsById.get(id);
            return s && (
              <g key={`e${id}`}>
                <circle cx={s.x} cy={s.y} r={7.5 / v.k} fill="var(--selected-dot)" stroke="var(--selected-halo)" strokeWidth={2.5 / v.k} />
                <circle cx={s.x} cy={s.y} r={16 / v.k} fill="none" stroke="var(--selected-dot)" strokeWidth={2.5 / v.k} className="map-ping" />
              </g>
            );
          })}
          <StationLabels labels={labels} k={v.k} ends={ends} />
          {/* hit targets last: generous, invisible, one per station */}
          {data.stations.map((s) => (
            <circle key={`h${s.id}`} cx={s.x} cy={s.y} r={Math.max(12 / v.k, s.nodes.length > 1 ? spread(s) : 0)} fill="transparent"
              onClick={() => select(s)} className="cursor-pointer">
              <title>{s.nodes.length > 1 ? `${s.name}: ${s.nodes.length} linked stops, one station complex` : s.name}</title>
            </circle>
          ))}
        </g>
      </svg>

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
        {route && !journey && routes[route] && (
          <p className="enter rounded-lg px-3 py-1.5 text-sm font-extrabold shadow-md"
            style={{ background: color(route), color: inkFor(routes[route].color) }}>
            {routes[route].short_name === "S" ? routes[route].long_name : `${routes[route].short_name} line`}
          </p>
        )}
        {/* the linked circles need a word of explanation, but only once they're big enough to notice */}
        {v.k >= 3 && (
          <p className="hidden items-center gap-2 rounded-lg bg-bg/95 px-2.5 py-1.5 text-xs font-semibold text-text shadow-sm sm:flex">
            <svg width="30" height="12" viewBox="0 0 30 12" aria-hidden="true">
              <line x1="6" y1="6" x2="24" y2="6" stroke="currentColor" strokeWidth="2.4" />
              <circle cx="6" cy="6" r="4" fill="#fff" stroke="#0d0e10" strokeWidth="1.9" />
              <circle cx="24" cy="6" r="4" fill="#fff" stroke="#0d0e10" strokeWidth="1.9" />
            </svg>
            Linked stops: one station, walk between platforms
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

const links = (d: number[]) => {
  let out = "";
  for (let i = 0; i < d.length; i += 4) out += `M${d[i]},${d[i + 1]}L${d[i + 2]},${d[i + 3]}`;
  return out;
};
const spread = (s: MapStation) => Math.max(...s.nodes.map(([x, y]) => Math.hypot(x - s.x, y - s.y))) + 2;

// ------------------------------------------------------------------ labels
function layoutLabels(data: MapData, net: Network, base: BaseData | null, kb: number, focus: number | null, journey: Journey | null, active: Set<number> | null,
  streetNames: { key: string; t: string; x: number; y: number; r: number }[]): PlacedLabel[] {
  const w = lineWidth(kb);
  const cands: LabelCandidate[] = [];
  const journeyKey = new Set<number>(journey ? [journey.legs[0].boardStation, ...journey.legs.map((l) => l.alightStation)] : []);
  for (const s of data.stations) {
    const ix = net.interchange.has(s.id);
    const major = s.routes.length >= 5 || s.nodes.length >= 3;
    let priority: number | null = null;
    if (s.id === focus || journeyKey.has(s.id)) priority = 0;
    else if (active?.has(s.id)) priority = kb >= 1.6 ? 1 : major ? 1 : null;
    else if (active) priority = kb >= 3 ? 4 : null; // keep context sparse while something is selected
    else if (major && kb >= 0.85) priority = 2;
    else if (ix && kb >= 1.8) priority = 3;
    else if (kb >= 3.6) priority = 4;
    if (priority == null) continue;
    const fs = priority === 0 ? 14 : priority <= 2 ? 12.5 : 11.5;
    const spreadPx = s.nodes.length > 1 ? spread(s) * kb : 0;
    cands.push({
      key: `s${s.id}`, text: s.name, x: s.x, y: s.y, fs, priority: priority * 1000 - s.routes.length * 10 - s.nodes.length,
      pad: Math.max(spreadPx, w * 1.6) + (priority === 0 ? 9 : 4), dedupe: priority > 1,
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
          <text key={l.key} x={l.x} y={l.y} dy={(l.c.fs * 0.35) / k} textAnchor="middle" fontSize={l.c.fs / k}
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
          // the selected station reads like its own sign: white on black
          const wpx = l.text.length * l.c.fs * 0.56 + 14;
          const left = l.anchor === "start" ? x - 7 / k : l.anchor === "end" ? x - wpx / k + 7 / k : x - wpx / 2 / k;
          return (
            <g key={l.key} className="enter">
              <rect x={left} y={y - fs * 1.05} width={wpx / k} height={fs * 1.5} rx={4 / k} fill="var(--sign)" stroke="var(--plate-edge)" strokeWidth={1 / k} />
              <text x={left + 7 / k} y={y} fontSize={fs} fontWeight={800} fill="var(--sign-text)">{l.text}</text>
            </g>
          );
        }
        return (
          <text key={l.key} x={x} y={y} textAnchor={l.anchor} fontSize={fs} fontWeight={l.c.priority < 3000 ? 750 : 600}
            fill="var(--text)" stroke="var(--land)" strokeWidth={3.2 / k} strokeLinejoin="round" paintOrder="stroke">
            {l.text}
          </text>
        );
      })}
    </g>
  );
}
