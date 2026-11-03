// Builds candidate platform boards: the next 3 trains of every route at every platform.
// The database decides what changed (commit_worker_run); this only shapes the input.
import type { FeedMessage } from "./gtfs.ts";

export interface CandidateTrain {
  trip_id: string;
  route_id: string;
  eta: number; // POSIX seconds
  kind: "arr" | "dep"; // which time MTA gave: arrival, or departure only (origin terminals)
  dest: string; // stop_id of the trip's last stop; SQL resolves it to a station name
  live: boolean; // NYCT is_assigned
  feed: string;
}

export interface CandidateBoard {
  stop_id: string;
  trains: CandidateTrain[];
}

export const PAST_GRACE_S = 30; // keep trains up to 30 s past their ETA (MTA lingers at stations)
export const HORIZON_S = 90 * 60; // ignore predictions more than 90 min out
export const PER_ROUTE = 3;

export function buildCandidates(feeds: { feed: string; msg: FeedMessage }[], nowS: number): CandidateBoard[] {
  const byStop = new Map<string, CandidateTrain[]>();
  for (const { feed, msg } of feeds) {
    for (const t of msg.trips) {
      if (!t.tripId || !t.routeId || t.stops.length === 0) continue;
      const dest = t.stops[t.stops.length - 1].stopId;
      for (const s of t.stops) {
        const eta = s.arrival ?? s.departure;
        if (!eta || !/[NS]$/.test(s.stopId)) continue;
        if (eta < nowS - PAST_GRACE_S || eta > nowS + HORIZON_S) continue;
        const train: CandidateTrain = {
          trip_id: t.tripId,
          route_id: t.routeId,
          eta,
          kind: s.arrival ? "arr" : "dep",
          dest,
          live: t.assigned,
          feed,
        };
        const list = byStop.get(s.stopId);
        if (list) list.push(train);
        else byStop.set(s.stopId, [train]);
      }
    }
  }

  const boards: CandidateBoard[] = [];
  for (const [stop_id, trains] of byStop) {
    trains.sort((a, b) => a.eta - b.eta || a.trip_id.localeCompare(b.trip_id));
    const perRoute = new Map<string, number>();
    const seen = new Set<string>();
    const keep: CandidateTrain[] = [];
    for (const t of trains) {
      if (seen.has(t.trip_id)) continue; // a trip can list a stop once; guard anyway
      const n = perRoute.get(t.route_id) ?? 0;
      if (n >= PER_ROUTE) continue;
      perRoute.set(t.route_id, n + 1);
      seen.add(t.trip_id);
      keep.push(t);
    }
    boards.push({ stop_id, trains: keep });
  }
  return boards;
}
