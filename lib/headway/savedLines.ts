"use client";

// Which lines a rider wants to see for each saved station (empty = all). A per-browser preference in
// localStorage: `follows` stays a plain user/station row, so RLS and the backend are unchanged.
import { useSyncExternalStore } from "react";

const KEY = "headway-saved-lines";
const NONE: string[] = [];
type Store = Record<string, string[]>;
let cache: Store | null = null;
const listeners = new Set<() => void>();

function read(): Store {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Store;
  } catch {
    cache = {};
  }
  return cache;
}

export function setSavedLines(stationId: number, lines: string[]) {
  const next = { ...read() };
  if (lines.length) next[stationId] = lines;
  else delete next[stationId];
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // private mode / blocked storage: the choice still applies for this visit
  }
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useSavedLines(stationId: number): string[] {
  return useSyncExternalStore(subscribe, () => read()[stationId] ?? NONE, () => NONE);
}
