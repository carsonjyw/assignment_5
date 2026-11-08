"use client";

// Shared state between the persistent map (Explore layout) and the rail pages: which line is
// highlighted, which station is focused (and which of its physical stops), the planned journey, and
// "pick a station on the map" mode.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { primaryStop, stopsOf, type MapStop } from "@/lib/headway/mapLayout";
import type { Journey } from "@/lib/headway/planner";

export type { MapStop };

export interface MapStation {
  id: number; name: string; x: number; y: number;
  nodes: [number, number][]; // positions of the complex's member stations (2+ = an in-station transfer)
  routes: string[]; groups: number;
}
export interface MapSeg { c: number[]; r: number[]; d: number[] } // trunk colours, routes, flat x,y (railroad north)
export interface MapData {
  w: number; h: number;
  proj: { lat0: number; kx: number; minx: number; maxy: number; s: number };
  colors: string[]; routes: string[];
  segs: MapSeg[];
  hops: [number, number, number, number[]][]; // route index, complex A < complex B, segments between them
  stations: MapStation[];
  complexes: MapComplex[];
  walks: MapWalk[];
}
// A multi-stop station: each stop's name, lines and position, MTA's documented transfers [stop i, stop j, min seconds],
// and the minimal set of them drawn as thin solid connectors when the station is selected [stop i, stop j]
export interface MapComplex { id: number; stops: MapStop[]; t: [number, number, number][]; links: [number, number][] }
// A documented transfer between two separate complexes: drawn dotted when either one is selected
export interface MapWalk { a: number; b: number; s: number; ax: number; ay: number; bx: number; by: number; ar: string[]; br: string[] }
// The Connections section is open; `hover`: the stop row the rider is pointing at (index into the station's stops)
export interface TransferView { id: number; hover: number | null }
export interface BaseLabel { t: string; k: "borough" | "region" | "hood" | "park" | "water"; x: number; y: number; r: number; big?: boolean }
export interface BaseData { attribution: string; land: { n: string; k: "borough" | "region"; d: string }[]; parks: { n: string; d: string }[]; labels: BaseLabel[] }

interface MapState {
  data: MapData | null;
  base: BaseData | null;
  stationsById: Map<number, MapStation>;
  complexes: Map<number, MapComplex>;
  walks: MapWalk[];
  transfer: TransferView | null;
  setTransfer: (t: TransferView | null) => void;
  route: string | null;
  setRoute: (r: string | null) => void;
  focus: number | null;
  setFocus: (id: number | null) => void;
  /** The focused station's selected stop (index into its stops): the one tapped on the map or chosen in
   *  Connections, else its busiest stop. Null when nothing is focused. */
  selectedStop: number | null;
  chooseStop: (id: number, stop: number) => void;
  journey: Journey | null;
  setJourney: (j: Journey | null) => void;
  pick: ((id: number) => void) | null; // when set, tapping a station calls this instead of opening it
  setPick: (fn: ((id: number) => void) | null) => void;
  explore: (() => void) | null; // set by the station panel: opens its Connections tab (the sign's "Explore connections")
  setExplore: (fn: (() => void) | null) => void;
}

const Ctx = createContext<MapState | null>(null);
const once = <T,>(url: string) => {
  let p: Promise<T> | null = null;
  return () => (p ??= fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url} unavailable`);
    return r.json() as Promise<T>;
  }));
};
export const loadMapData = once<MapData>("/data/map.json");
const loadBase = once<BaseData>("/data/basemap.json");

export function MapProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<MapData | null>(null);
  const [base, setBase] = useState<BaseData | null>(null);
  const [route, setRoute] = useState<string | null>(null);
  const [focus, setFocusState] = useState<number | null>(null);
  const [stopPick, setStopPick] = useState<{ id: number; stop: number } | null>(null);
  const [journey, setJourney] = useState<Journey | null>(null);
  const [transfer, setTransfer] = useState<TransferView | null>(null);
  const [pick, setPickState] = useState<((id: number) => void) | null>(null);
  const [explore, setExploreState] = useState<(() => void) | null>(null);

  useEffect(() => {
    loadMapData().then(setData).catch(() => setData(null));
    // the basemap is context only: the network works without it
    loadBase().then(setBase).catch(() => setBase(null));
  }, []);

  // stable identity: panels call this from effects, so it must not change when the context value does
  const setPick = useCallback((fn: ((id: number) => void) | null) => setPickState(() => fn), []);
  const setExplore = useCallback((fn: (() => void) | null) => setExploreState(() => fn), []);

  // rebuilt only when the data changes, so map effects keyed on it don't re-run on every selection
  const stationsById = useMemo(() => new Map((data?.stations ?? []).map((s) => [s.id, s])), [data]);

  const complexes = useMemo(() => new Map((data?.complexes ?? []).map((c) => [c.id, c])), [data]);

  const walks = useMemo(() => data?.walks ?? [], [data]);

  // Stable, like setPick. Focusing another station forgets the stop chosen at the last one (a stop tapped on the
  // map is recorded just before its station page sets the focus, so that one is kept).
  const setFocus = useCallback((id: number | null) => {
    setFocusState(id);
    if (id != null) setStopPick((p) => (p && p.id !== id ? null : p));
  }, []);
  const chooseStop = useCallback((id: number, stop: number) => setStopPick({ id, stop }), []);

  const selectedStop = useMemo(() => {
    const s = focus != null ? stationsById.get(focus) : undefined;
    if (!s) return null;
    const stops = stopsOf(s, complexes.get(s.id));
    return stopPick?.id === s.id && stops[stopPick.stop] ? stopPick.stop : primaryStop(stops);
  }, [focus, stopPick, stationsById, complexes]);

  const value = useMemo<MapState>(() => ({
    data, base, stationsById, complexes, walks, transfer, setTransfer,
    route, setRoute, focus, setFocus, selectedStop, chooseStop, journey, setJourney,
    pick, setPick, explore, setExplore,
  }), [data, base, stationsById, complexes, walks, transfer, route, focus, setFocus, selectedStop, chooseStop, journey, pick, setPick, explore, setExplore]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMap(): MapState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMap outside <MapProvider>");
  return v;
}
