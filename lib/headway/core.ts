// Pure, dependency-free logic shared by the pages: data shapes, time formatting, direction labels,
// platform grouping, and the six freshness states (docs/step3/DATA_FLOW.md §4.4–4.5).
// No imports, so `node --test` can run it directly (tests/headway-core.test.ts).

export const FEEDS = ["gtfs", "gtfs-ace", "gtfs-bdfm", "gtfs-g", "gtfs-jz", "gtfs-l", "gtfs-nqrw", "gtfs-si"] as const;

export interface Route {
  route_id: string;
  short_name: string;
  long_name: string;
  color: string;
  text_color: string;
  feed: string;
  sort_order: number;
}

export interface Station {
  station_id: number;
  name: string;
  borough: string;
  routes: string[];
}

export interface Platform {
  stop_id: string;
  parent_stop_id: string;
  station_id: number;
  direction: "N" | "S";
  direction_label: string;
  line_name: string;
}

// One entry of platform_boards.trains, as written by commit_worker_run
export interface Train {
  trip_id: string;
  route_id: string;
  eta: number; // POSIX seconds
  kind: "arr" | "dep";
  headsign: string | null;
  live: boolean;
  feed: string;
  carried: boolean;
}

export interface FeedHealth {
  ok: boolean;
  feed_ts: number | null;
  reason: string | null;
  last_ok_at: string | null;
  fail_streak: number;
}

export interface WorkerStatus {
  last_run_id: number;
  last_run_at: string | null;
  last_success_at: string | null;
  last_status: "ok" | "partial" | "error" | null;
  feeds: Record<string, FeedHealth>;
}

// ------------------------------------------------------------------------------------------ time
export const PAST_GRACE_S = 30; // a train stays on the board until 30 s past its time

/** "Arriving", "4 min", "1 h 5 min" from an absolute eta and the (server-corrected) clock. */
export function formatEta(etaS: number, nowMs: number): string {
  const secs = etaS - nowMs / 1000;
  if (secs < 60) return "Arriving";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Clock time in New York ("12:41 PM"), shown as secondary detail. */
export function clockTime(etaS: number): string {
  return new Date(etaS * 1000).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
  });
}

export const isUpcoming = (t: Train, nowMs: number) => t.eta >= nowMs / 1000 - PAST_GRACE_S;

/** Explicit words for the row: never rely on colour or symbol alone. */
export function trainStatusText(t: Train): "Live" | "Scheduled" | "Delayed data" {
  if (t.carried) return "Delayed data";
  return t.live ? "Live" : "Scheduled";
}

// ------------------------------------------------------------------------------------------ labels
/**
 * Rider-facing direction header. Keeps MTA's "Uptown & The Bronx" style labels, turns place names
 * into "To Grand Central", and replaces generic fallbacks with the most common destination.
 */
export function directionHeading(label: string, trains: Train[]): string {
  const l = label.trim();
  if (/^(north|south)bound$/i.test(l)) {
    const dest = mostCommon(trains.map((t) => t.headsign).filter((h): h is string => !!h));
    return dest ? `To ${dest}` : l;
  }
  if (/uptown|downtown/i.test(l)) return l.replace(/ - /g, " and ");
  return `To ${l.replace(/ - /g, ", ")}`;
}

function mostCommon(xs: string[]): string | null {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
  return best;
}

// ------------------------------------------------------------------------------------------ boards
export interface DirectionBoard {
  stopId: string;
  direction: "N" | "S";
  heading: string;
  trains: Train[]; // upcoming only, sorted by eta
}

export interface LineGroup {
  key: string; // parent_stop_id, e.g. "127" for the 1 2 3 at Times Sq
  lineName: string;
  routes: string[]; // routes seen on this group's platforms, in route sort order
  feeds: string[];
  directions: DirectionBoard[]; // N then S, always both (empty boards still shown)
}

/** Groups a station's platforms by line (parent stop), each with both directions. */
export function groupStation(
  platforms: Platform[],
  boards: Record<string, Train[] | undefined>,
  routes: Record<string, Route | undefined>,
  nowMs: number,
): LineGroup[] {
  const order = (r: string) => routes[r]?.sort_order ?? 999;
  const byParent = new Map<string, Platform[]>();
  for (const p of platforms) {
    const list = byParent.get(p.parent_stop_id);
    if (list) list.push(p);
    else byParent.set(p.parent_stop_id, [p]);
  }
  const groups: LineGroup[] = [];
  for (const [key, ps] of byParent) {
    ps.sort((a, b) => (a.direction === b.direction ? 0 : a.direction === "N" ? -1 : 1));
    const directions = ps.map((p) => {
      const trains = (boards[p.stop_id] ?? []).filter((t) => isUpcoming(t, nowMs)).sort((a, b) => a.eta - b.eta);
      return { stopId: p.stop_id, direction: p.direction, heading: directionHeading(p.direction_label, trains), trains };
    });
    const seen = new Set(directions.flatMap((d) => d.trains.map((t) => t.route_id)));
    const groupRoutes = [...seen].sort((a, b) => order(a) - order(b));
    const feeds = [...new Set(groupRoutes.map((r) => routes[r]?.feed).filter((f): f is string => !!f))];
    groups.push({ key, lineName: ps[0].line_name, routes: groupRoutes, feeds, directions });
  }
  // Stable, rider-friendly order: by the first route's sort order, then by line name
  const first = (g: LineGroup) => (g.routes.length ? order(g.routes[0]) : 998);
  groups.sort((a, b) => first(a) - first(b) || a.lineName.localeCompare(b.lineName));
  return groups;
}

/** Trains to show for one direction under the current line filter. */
export function visibleTrains(trains: Train[], filter: string | null, expanded: boolean, limit = 3): {
  shown: Train[];
  hidden: number;
} {
  const pool = filter ? trains.filter((t) => t.route_id === filter) : trains;
  const shown = expanded ? pool : pool.slice(0, limit);
  return { shown, hidden: pool.length - shown.length };
}

/** Home card rows: one per direction with a train, soonest first, with the next two times. */
export function cardRows(groups: LineGroup[], max = 4, only: string[] = []): {
  rows: { stopId: string; heading: string; first: Train; then: Train[] }[];
  totalDirections: number;
} {
  // `only`: keep just these routes (a saved station's chosen lines); empty means every line
  const all = groups.flatMap((g) => g.directions)
    .map((d) => (only.length ? { ...d, trains: d.trains.filter((t) => only.includes(t.route_id)) } : d))
    .filter((d) => d.trains.length > 0);
  all.sort((a, b) => a.trains[0].eta - b.trains[0].eta);
  return {
    rows: all.slice(0, max).map((d) => ({ stopId: d.stopId, heading: d.heading, first: d.trains[0], then: d.trains.slice(1, 3) })),
    totalDirections: groups.reduce((n, g) => n + g.directions.length, 0),
  };
}

// ------------------------------------------------------------------------------------------ freshness
export const STALE_AFTER_S = 60; // 4 missed 15 s runs
export const FEED_MAX_AGE_S = 90; // MTA's own header.timestamp
export const HEARTBEAT_SILENCE_S = 30; // no worker_status event for 2 runs → treat the socket as dead

export type FreshKind = "loading" | "fresh" | "stale" | "down" | "partial";

export interface Freshness {
  kind: FreshKind;
  reconnecting: boolean; // banner, shown in addition to kind
  updatedAgoS: number | null; // since last successful worker run
  badFeeds: string[]; // feeds this view needs that are failing or too old
  reason: "worker_error" | "feeds_down" | "worker_silent" | null;
}

/**
 * Combines the three independent signals: A worker heartbeat, B per-feed health (MTA's own clock),
 * C the browser's Realtime connection. Precedence: loading > down > stale > partial > fresh.
 */
export function computeFreshness(input: {
  loaded: boolean;
  status: WorkerStatus | null;
  neededFeeds: string[];
  nowMs: number; // server-corrected
  realtimeHealthy: boolean;
}): Freshness {
  const { loaded, status, neededFeeds, nowMs, realtimeHealthy } = input;
  const reconnecting = !realtimeHealthy;
  if (!loaded || !status) return { kind: "loading", reconnecting, updatedAgoS: null, badFeeds: [], reason: null };

  const successMs = status.last_success_at ? Date.parse(status.last_success_at) : NaN;
  const updatedAgoS = Number.isFinite(successMs) ? Math.max(0, Math.round((nowMs - successMs) / 1000)) : null;
  const badFeeds = neededFeeds.filter((f) => {
    const h = status.feeds?.[f];
    if (!h || !h.ok || !h.feed_ts) return true;
    return nowMs / 1000 - h.feed_ts > FEED_MAX_AGE_S;
  });
  const base = { reconnecting, updatedAgoS, badFeeds };

  if (status.last_status === "error") return { ...base, kind: "down", reason: "worker_error" };
  if (neededFeeds.length > 0 && badFeeds.length === neededFeeds.length && updatedAgoS !== null && updatedAgoS <= STALE_AFTER_S) {
    return { ...base, kind: "down", reason: "feeds_down" };
  }
  if (updatedAgoS === null || updatedAgoS > STALE_AFTER_S) return { ...base, kind: "stale", reason: "worker_silent" };
  if (badFeeds.length > 0) return { ...base, kind: "partial", reason: null };
  return { ...base, kind: "fresh", reason: null };
}

/** Plain-language status line for riders. */
export function freshnessText(f: Freshness): string {
  switch (f.kind) {
    case "loading":
      return "Loading live times…";
    case "fresh":
      return `Live · updated ${agoText(f.updatedAgoS ?? 0)}`;
    case "stale":
      return f.updatedAgoS === null
        ? "Waiting for live times"
        : `Last updated ${agoText(f.updatedAgoS)}, times may be off`;
    case "partial":
      return `Live · some lines have delayed data`;
    case "down":
      return "Live times aren't available right now. We'll keep trying.";
  }
}

export function agoText(s: number): string {
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
}

/** Feeds a set of routes depends on (for signal B). */
export function feedsFor(routeIds: string[], routes: Record<string, Route | undefined>): string[] {
  return [...new Set(routeIds.map((r) => routes[r]?.feed).filter((f): f is string => !!f))];
}
