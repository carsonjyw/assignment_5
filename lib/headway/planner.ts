// Trip planner over MTA's own schedule (public/data/plan.json, built by scripts/build_transit_assets.py).
// Nodes are (platform, route): platforms are direction-specific (127N / 127S), so direction is built in.
// Costs are SCHEDULED: median run times between stops for the chosen service period, half the
// scheduled headway as expected wait, and MTA transfers.txt minimum transfer times. No imports.

export interface PlanData {
  bands: [string, number, number][];
  services: string[];
  routes: string[];
  platforms: [string, string, number | null][]; // stop_id, parent_stop_id, station_id
  same_station_transfer_s: Record<string, number>;
  transfers: [string, string, number][]; // parent → parent walking transfer
  headsigns: string[];
  graph: Record<string, { segments: number[][]; headways: number[][]; headsigns: [number, string, number][] }>;
  feed_version?: string | null;
}

export interface Leg {
  route: string;
  direction: "N" | "S";
  headsign: string | null; // typical destination of this route/direction in the chosen period
  boardStation: number;
  alightStation: number;
  boardPlatform: string;
  alightPlatform: string;
  stations: number[]; // every station passed, in order, including both ends
  rideS: number; // scheduled in-vehicle time
  headwayS: number; // scheduled time between trains
}

export interface Transfer {
  atStation: number;
  toStation: number; // same as atStation unless it's a walking connection between stations
  walkS: number; // MTA min_transfer_time (0 when the next train uses the same platform)
  waitS: number; // half the next line's scheduled headway
}

export interface Journey {
  band: string;
  totalS: number; // scheduled estimate, including expected waits
  firstWaitS: number;
  legs: Leg[];
  transfers: Transfer[];
}

const DEFAULT_SAME_STATION_S = 180; // MTA's usual value in transfers.txt
const TRANSFER_PENALTY_S = 90; // prefer fewer changes when times are close

/** Service period for a moment in New York (calendar_dates holidays are not modelled). */
export function bandFor(date: Date, data: Pick<PlanData, "bands">): { key: string; service: string; band: string; label: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23" })
    .formatToParts(date);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 12) % 24;
  const service = wd === "Sat" ? "Saturday" : wd === "Sun" ? "Sunday" : "Weekday";
  const band = data.bands.find(([, a, b]) => hour >= a && hour < b)?.[0] ?? "midday";
  const names: Record<string, string> = { early: "late night", am: "morning", midday: "midday", pm: "evening rush", evening: "evening" };
  return { key: `${service}:${band}`, service, band, label: `${service} ${names[band] ?? band}` };
}

interface Prepared {
  ride: Map<number, [number, number][]>; // node → [nextNode, secs]
  headway: Map<number, number>; // node → headway secs
  headsign: Map<string, number>;
  nodesAtStation: Map<number, number[]>;
}

const cache = new WeakMap<object, Map<string, Prepared>>();

function prepare(data: PlanData, key: string): Prepared | null {
  const g = data.graph[key];
  if (!g) return null;
  let perData = cache.get(data);
  if (!perData) cache.set(data, (perData = new Map()));
  const hit = perData.get(key);
  if (hit) return hit;
  const R = data.routes.length;
  const node = (p: number, r: number) => p * R + r;
  const ride = new Map<number, [number, number][]>();
  for (const [a, b, r, s] of g.segments) {
    const k = node(a, r);
    const list = ride.get(k);
    if (list) list.push([node(b, r), s]);
    else ride.set(k, [[node(b, r), s]]);
  }
  const headway = new Map<number, number>();
  const nodesAtStation = new Map<number, number[]>();
  for (const [p, r, h] of g.headways) {
    const k = node(p, r);
    headway.set(k, h);
    const st = data.platforms[p][2];
    if (st == null) continue;
    const list = nodesAtStation.get(st);
    if (list) list.push(k);
    else nodesAtStation.set(st, [k]);
  }
  // nodes that only appear as a trip's last stop (no departures) still need a station entry
  for (const [, b, r] of g.segments) {
    const st = data.platforms[b][2];
    if (st == null) continue;
    const k = node(b, r);
    const list = nodesAtStation.get(st) ?? [];
    if (!list.includes(k)) list.push(k);
    nodesAtStation.set(st, list);
  }
  const headsign = new Map<string, number>();
  for (const [r, d, h] of g.headsigns) headsign.set(`${r}:${d}`, h);
  const prepared = { ride, headway, headsign, nodesAtStation };
  perData.set(key, prepared);
  return prepared;
}

/** Walking time between two platforms of connected stations, or null if MTA lists no connection. */
function walkSeconds(data: PlanData, pa: number, pb: number, xfer: Map<string, number>): number | null {
  if (pa === pb) return 0;
  const [, parentA] = data.platforms[pa];
  const [, parentB] = data.platforms[pb];
  if (parentA === parentB) return data.same_station_transfer_s[parentA] ?? DEFAULT_SAME_STATION_S;
  return xfer.get(`${parentA}>${parentB}`) ?? null;
}

const xferCache = new WeakMap<object, Map<string, number>>();
function transferMap(data: PlanData) {
  let m = xferCache.get(data);
  if (!m) {
    m = new Map(data.transfers.map(([a, b, s]) => [`${a}>${b}`, s] as [string, number]));
    xferCache.set(data, m);
  }
  return m;
}

/**
 * Shortest scheduled journey between two stations (complex ids) for a service period.
 * `transferPenaltyS` can be raised to find a fewer-transfers alternative.
 */
export function planJourney(data: PlanData, key: string, from: number, to: number, transferPenaltyS = TRANSFER_PENALTY_S): Journey | null {
  if (from === to) return null;
  const P = prepare(data, key);
  if (!P) return null;
  const R = data.routes.length;
  const xfer = transferMap(data);
  const platOf = (n: number) => Math.floor(n / R);
  const routeOf = (n: number) => n % R;
  const stationOf = (n: number) => data.platforms[platOf(n)][2];

  // Transfer candidates from a node: every node at the same station or at an MTA-linked station
  const linked = new Map<number, number[]>(); // station → stations reachable on foot
  for (const [a, b] of data.transfers) {
    const sa = data.platforms.find((p) => p[1] === a)?.[2];
    const sb = data.platforms.find((p) => p[1] === b)?.[2];
    if (sa == null || sb == null || sa === sb) continue;
    linked.set(sa, [...(linked.get(sa) ?? []), sb]);
  }

  const dist = new Map<number, number>();
  const prev = new Map<number, { from: number | null; kind: "start" | "ride" | "transfer"; secs: number; wait: number }>();
  const heap: [number, number][] = [];
  const push = (d: number, n: number) => {
    heap.push([d, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };

  for (const n of P.nodesAtStation.get(from) ?? []) {
    const h = P.headway.get(n);
    if (h == null) continue; // no departures from here in this period
    const wait = h / 2;
    dist.set(n, wait);
    prev.set(n, { from: null, kind: "start", secs: 0, wait });
    push(wait, n);
  }

  let best: { node: number; d: number } | null = null;
  for (let item = pop(); item; item = pop()) {
    const [d, n] = item;
    if (d > (dist.get(n) ?? Infinity)) continue;
    const st = stationOf(n);
    if (st === to && prev.get(n)?.kind === "ride") {
      best = { node: n, d };
      break;
    }
    for (const [m, s] of P.ride.get(n) ?? []) {
      const nd = d + s;
      if (nd < (dist.get(m) ?? Infinity)) {
        dist.set(m, nd);
        prev.set(m, { from: n, kind: "ride", secs: s, wait: 0 });
        push(nd, m);
      }
    }
    // Only change trains after riding (never transfer twice in a row, never at the origin)
    if (prev.get(n)?.kind !== "ride" || st == null) continue;
    const stations = [st, ...(linked.get(st) ?? [])];
    for (const s2 of stations) {
      for (const m of P.nodesAtStation.get(s2) ?? []) {
        if (routeOf(m) === routeOf(n) && platOf(m) === platOf(n)) continue;
        const h = P.headway.get(m);
        if (h == null) continue;
        const walk = walkSeconds(data, platOf(n), platOf(m), xfer);
        if (walk == null) continue;
        const nd = d + walk + h / 2 + transferPenaltyS;
        if (nd < (dist.get(m) ?? Infinity)) {
          dist.set(m, nd);
          prev.set(m, { from: n, kind: "transfer", secs: walk, wait: h / 2 });
          push(nd, m);
        }
      }
    }
  }
  if (!best) return null;

  // Rebuild the path, then group consecutive rides on one route into legs
  const path: number[] = [];
  for (let n: number | null = best.node; n != null; n = prev.get(n)?.from ?? null) path.push(n);
  path.reverse();
  const legs: Leg[] = [];
  const transfers: Transfer[] = [];
  let firstWait = 0;
  let penalties = 0;
  for (let i = 0; i < path.length; i++) {
    const n = path[i];
    const info = prev.get(n)!;
    const plat = data.platforms[platOf(n)];
    const route = data.routes[routeOf(n)];
    const dir = plat[0].endsWith("N") ? "N" : "S";
    if (info.kind === "start" || info.kind === "transfer") {
      if (info.kind === "start") firstWait = info.wait;
      else {
        transfers.push({ atStation: stationOf(info.from!)!, toStation: plat[2]!, walkS: info.secs, waitS: Math.round(info.wait) });
        penalties += transferPenaltyS;
      }
      const hs = P.headsign.get(`${routeOf(n)}:${dir}`);
      legs.push({
        route, direction: dir, headsign: hs != null ? data.headsigns[hs] : null,
        boardStation: plat[2]!, alightStation: plat[2]!, boardPlatform: plat[0], alightPlatform: plat[0],
        stations: [plat[2]!], rideS: 0, headwayS: Math.round(P.headway.get(n) ?? 0),
      });
    } else {
      const leg = legs[legs.length - 1];
      leg.rideS += info.secs;
      leg.alightStation = plat[2]!;
      leg.alightPlatform = plat[0];
      if (leg.stations[leg.stations.length - 1] !== plat[2]) leg.stations.push(plat[2]!);
    }
  }
  const realLegs = legs.filter((l) => l.stations.length > 1);
  return { band: key, totalS: Math.round(best.d - penalties), firstWaitS: Math.round(firstWait), legs: realLegs, transfers };
}

/** Best journey plus, when different, the fewest-transfers alternative. */
export function planOptions(data: PlanData, key: string, from: number, to: number): Journey[] {
  const fast = planJourney(data, key, from, to);
  if (!fast) return [];
  const simple = planJourney(data, key, from, to, 900);
  const sig = (j: Journey) => j.legs.map((l) => `${l.route}${l.direction}${l.boardStation}-${l.alightStation}`).join("|");
  return simple && sig(simple) !== sig(fast) && simple.transfers.length < fast.transfers.length ? [fast, simple] : [fast];
}

export const minutes = (s: number) => Math.max(1, Math.round(s / 60));
