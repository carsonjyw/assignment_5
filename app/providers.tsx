"use client";

// App-wide live context: one Supabase client (carrying the Clerk session token), a server-corrected
// clock that ticks every second, the routes table, and the worker heartbeat subscription.
import { useSession } from "@clerk/nextjs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HEARTBEAT_SILENCE_S, type Route, type WorkerStatus } from "@/lib/headway/core";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "@/lib/supabase/config";

type ChannelState = "connecting" | "subscribed" | "closed" | "error";

interface Live {
  supabase: SupabaseClient;
  nowMs: number; // server-corrected, ticks every second
  routes: Record<string, Route>;
  routeList: Route[];
  status: WorkerStatus | null;
  realtimeHealthy: boolean;
  visible: boolean; // tab visible; subscriptions pause while hidden
}

const LiveContext = createContext<Live | null>(null);

// One Supabase client per browser tab. accessToken is read on every request, so sign-in/out
// needs no new client; signed-out requests fall back to the publishable key (anon role).
// The token is read from Clerk's browser instance at request time, so even the very first query a
// child component sends (child effects run before this provider's) carries the signed-in session.
type ClerkGlobal = { Clerk?: { session?: { getToken(): Promise<string | null> } | null } };
const currentToken = async () => (await (globalThis as ClerkGlobal).Clerk?.session?.getToken()) ?? null;
let client: SupabaseClient | null = null;
function getClient(): SupabaseClient {
  client ??= createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { accessToken: currentToken });
  return client;
}

export function useLive(): Live {
  const v = useContext(LiveContext);
  if (!v) throw new Error("useLive outside <LiveProvider>");
  return v;
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const [supabase] = useState(getClient);

  // Realtime keeps its own copy of the token: refresh it when the user signs in or out
  useEffect(() => {
    void supabase.realtime.setAuth();
  }, [supabase, session?.id]);

  // ---- clock: offset between this device and the database, then a 1 s tick
  const [offsetMs, setOffsetMs] = useState(0);
  const [localNow, setLocalNow] = useState(0); // 0 until mounted: no clock during prerender
  useEffect(() => {
    const t0 = Date.now();
    supabase.rpc("server_now").then(({ data }) => {
      if (typeof data === "string") setOffsetMs(Date.parse(data) - (t0 + Date.now()) / 2);
    });
    const tick = () => setLocalNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [supabase]);

  // ---- tab visibility
  const [visible, setVisible] = useState(true);
  // A fresh connection gets a 10 s grace period before "Reconnecting" can show (no flash on load or on
  // returning to the tab, when the old heartbeat time would otherwise read as silence)
  const [channelState, setChannelState] = useState<ChannelState>("connecting");
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    const on = () => {
      const v = document.visibilityState === "visible";
      setVisible(v);
      if (!v) {
        setChannelState("connecting");
        setGraceOver(false);
      }
    };
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  // ---- routes (29 rows, static)
  const [routeList, setRouteList] = useState<Route[]>([]);
  useEffect(() => {
    supabase.from("routes").select("*").order("sort_order").then(({ data }) => setRouteList((data as Route[]) ?? []));
  }, [supabase]);
  const routes = useMemo(() => Object.fromEntries(routeList.map((r) => [r.route_id, r])), [routeList]);

  // ---- worker heartbeat: Realtime when connected, REST every 15 s otherwise (signal A + B + C)
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  // Local time the socket was last known to be current: a heartbeat event arrived, or a REST check
  // found nothing newer than what the socket already delivered (the worker is quiet, not the socket).
  const [lastEventAt, setLastEventAt] = useState(0);
  const lastEventLocal = useRef(0);
  const lastRunIdSeen = useRef(0);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const load = async (verifySocket = false) => {
      const { data } = await supabase.from("worker_status").select("*").eq("id", 1).maybeSingle();
      if (cancelled || !data) return;
      const s = data as WorkerStatus;
      if (verifySocket && s.last_run_id <= lastRunIdSeen.current) {
        // Nothing newer than the socket delivered: the connection is fine, the worker is just silent
        lastEventLocal.current = Date.now();
        setLastEventAt(lastEventLocal.current);
      }
      lastRunIdSeen.current = Math.max(lastRunIdSeen.current, s.last_run_id);
      setStatus(s);
    };
    void load();
    const grace = setTimeout(() => !cancelled && setGraceOver(true), 10_000);
    const channel = supabase
      .channel("worker-status")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "worker_status" }, (payload) => {
        lastEventLocal.current = Date.now();
        setLastEventAt(lastEventLocal.current);
        const s = payload.new as WorkerStatus;
        lastRunIdSeen.current = Math.max(lastRunIdSeen.current, s.last_run_id);
        setStatus(s);
      })
      .subscribe((s) => {
        if (cancelled) return; // a removed channel's late CLOSED must not overwrite the new one
        if (s === "SUBSCRIBED") {
          setChannelState("subscribed");
          lastEventLocal.current = Date.now();
          setLastEventAt(lastEventLocal.current);
          void load(); // catch up on anything missed while connecting
        } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") setChannelState("error");
        else if (s === "CLOSED") setChannelState("closed");
      });
    const poll = setInterval(() => {
      // REST fallback: only after 20 s without a heartbeat (normally never, events come every 15 s).
      // It keeps worker/feed health accurate while the socket is down, and confirms a quiet socket
      // before the 30 s threshold so a paused worker reads as Stale, not Reconnecting.
      if (Date.now() - lastEventLocal.current > (HEARTBEAT_SILENCE_S - 10) * 1000) void load(true);
    }, 5_000);
    return () => {
      cancelled = true;
      clearTimeout(grace);
      clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  }, [supabase, visible]);

  const realtimeHealthy = (channelState === "connecting" && !graceOver)
    || (channelState === "subscribed" && localNow - lastEventAt <= HEARTBEAT_SILENCE_S * 1000);

  const value = useMemo<Live>(
    () => ({ supabase, nowMs: localNow ? localNow + offsetMs : 0, routes, routeList, status, realtimeHealthy, visible }),
    [supabase, localNow, offsetMs, routes, routeList, status, realtimeHealthy, visible],
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}
