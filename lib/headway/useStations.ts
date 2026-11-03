"use client";

// Loads stations + their platforms + current boards, then keeps the boards live with a Realtime
// subscription filtered to exactly these stations (never table-wide). Pauses while the tab is hidden.
import { useEffect, useMemo, useState } from "react";
import { useLive } from "@/app/providers";
import type { Platform, Station, Train } from "./core";

export interface StationData {
  loaded: boolean;
  error: string | null;
  stations: Record<number, Station>;
  platforms: Platform[];
  boards: Record<string, Train[]>;
}

const EMPTY: StationData = { loaded: true, error: null, stations: {}, platforms: [], boards: {} };

export function useStations(stationIds: number[]): StationData {
  const { supabase, visible } = useLive();
  const key = useMemo(() => [...new Set(stationIds)].sort((a, b) => a - b).join(","), [stationIds]);
  const [state, setState] = useState<StationData>({ loaded: false, error: null, stations: {}, platforms: [], boards: {} });

  useEffect(() => {
    const ids = key ? key.split(",").map(Number) : [];
    if (ids.length === 0 || !visible) return;
    let cancelled = false;

    const load = async () => {
      const [st, pl, bd] = await Promise.all([
        supabase.from("stations").select("station_id,name,borough,routes").in("station_id", ids),
        supabase.from("platforms").select("*").in("station_id", ids),
        supabase.from("platform_boards").select("stop_id,trains").in("station_id", ids),
      ]);
      if (cancelled) return;
      const err = st.error ?? pl.error ?? bd.error;
      setState({
        loaded: true,
        error: err ? "Couldn't load this station. Check your connection." : null,
        stations: Object.fromEntries(((st.data as Station[]) ?? []).map((s) => [s.station_id, s])),
        platforms: (pl.data as Platform[]) ?? [],
        boards: Object.fromEntries(((bd.data as { stop_id: string; trains: Train[] }[]) ?? []).map((b) => [b.stop_id, b.trains])),
      });
    };

    const filter = ids.length === 1 ? `station_id=eq.${ids[0]}` : `station_id=in.(${ids.join(",")})`;
    const channel = supabase
      .channel(`boards:${key}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "platform_boards", filter }, (payload) => {
        const row = payload.new as { stop_id?: string; trains?: Train[] };
        if (!row?.stop_id) return;
        setState((s) => ({ ...s, boards: { ...s.boards, [row.stop_id!]: row.trains ?? [] } }));
      })
      .subscribe((status) => {
        // (Re)subscribed: refetch so nothing missed while connecting or hidden is lost
        if (status === "SUBSCRIBED") void load();
      });

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [supabase, key, visible]);

  return key ? state : EMPTY;
}
