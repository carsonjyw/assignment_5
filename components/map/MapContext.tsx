"use client";

// Shared state between the persistent map (Explore layout) and the rail pages: which line is
// highlighted, which station is focused, the planned journey, and "pick a station on the map" mode.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Journey } from "@/lib/headway/planner";

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
}
export interface BaseLabel { t: string; k: "borough" | "region" | "hood" | "park" | "water"; x: number; y: number; r: number; big?: boolean }
export interface BaseData { attribution: string; land: { n: string; k: "borough" | "region"; d: string }[]; parks: { n: string; d: string }[]; labels: BaseLabel[] }

interface MapState {
  data: MapData | null;
  base: BaseData | null;
  stationsById: Map<number, MapStation>;
  route: string | null;
  setRoute: (r: string | null) => void;
  focus: number | null;
  setFocus: (id: number | null) => void;
  journey: Journey | null;
  setJourney: (j: Journey | null) => void;
  pick: ((id: number) => void) | null; // when set, tapping a station calls this instead of opening it
  setPick: (fn: ((id: number) => void) | null) => void;
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
  const [focus, setFocus] = useState<number | null>(null);
  const [journey, setJourney] = useState<Journey | null>(null);
  const [pick, setPickState] = useState<((id: number) => void) | null>(null);

  useEffect(() => {
    loadMapData().then(setData).catch(() => setData(null));
    // the basemap is context only: the network works without it
    loadBase().then(setBase).catch(() => setBase(null));
  }, []);

  // stable identity: panels call this from effects, so it must not change when the context value does
  const setPick = useCallback((fn: ((id: number) => void) | null) => setPickState(() => fn), []);

  // rebuilt only when the data changes, so map effects keyed on it don't re-run on every selection
  const stationsById = useMemo(() => new Map((data?.stations ?? []).map((s) => [s.id, s])), [data]);

  const value = useMemo<MapState>(() => ({
    data, base, stationsById,
    route, setRoute, focus, setFocus, journey, setJourney,
    pick, setPick,
  }), [data, base, stationsById, route, focus, journey, pick, setPick]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMap(): MapState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMap outside <MapProvider>");
  return v;
}
