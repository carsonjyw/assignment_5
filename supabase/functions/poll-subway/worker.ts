// One worker run: claim lease → fetch 8 feeds → decode + health checks → candidate boards → commit.
// All dependencies are injected so tests can run it on saved MTA responses against a local Postgres.
import { buildCandidates } from "./boards.ts";
import { decodeFeed, type FeedMessage } from "./gtfs.ts";

export const FEEDS = ["gtfs", "gtfs-ace", "gtfs-bdfm", "gtfs-g", "gtfs-jz", "gtfs-l", "gtfs-nqrw", "gtfs-si"] as const;
export const FEED_URL = (feed: string) =>
  `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F${feed}`;

export const FETCH_TIMEOUT_MS = 6_000;
export const MAX_FEED_AGE_S = 90;

export interface FeedReport {
  ok: boolean;
  feed_ts: number | null;
  reason: string | null;
}

export type FetchFeed = (feed: string) => Promise<Uint8Array>;
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>;

export interface RunResult {
  run_id: number | null;
  status: string; // ok | partial | error | skipped
  boards_changed?: number;
  trains_in?: number;
  trains_rejected?: number;
  feeds_rejected?: Record<string, string>;
  meta?: Record<string, unknown>;
  error?: string;
}

// Fetch one feed with a timeout and a single retry on network errors / 5xx.
export function httpFetchFeed(fetchImpl: typeof fetch = fetch): FetchFeed {
  return async (feed) => {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetchImpl(FEED_URL(feed), { signal: ctrl.signal });
        if (res.status >= 500 && attempt === 0) {
          await res.body?.cancel();
          lastErr = new Error(`http_${res.status}`);
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel();
          throw new Error(`http_${res.status}`);
        }
        return new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        lastErr = ctrl.signal.aborted ? new Error("timeout") : (e as Error);
        if (lastErr.message.startsWith("http_4")) break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr ?? new Error("fetch_failed");
  };
}

export async function runOnce(deps: { fetchFeed: FetchFeed; rpc: Rpc; nowMs?: () => number }): Promise<RunResult> {
  const now = deps.nowMs ?? Date.now;
  const t0 = now();
  const runId = (await deps.rpc("claim_worker_run", {})) as number | null;
  if (runId === null || runId === undefined) {
    return { run_id: null, status: "skipped" };
  }

  const meta: Record<string, unknown> = {};
  try {
    // 1. Fetch all 8 feeds in parallel
    const tFetch = now();
    const fetched = await Promise.allSettled(FEEDS.map((f) => deps.fetchFeed(f)));
    meta.fetch_ms = now() - tFetch;

    // 2. Decode + worker-side health checks
    const tDecode = now();
    const nowS = Math.floor(now() / 1000);
    const reports: Record<string, FeedReport> = {};
    const healthy: { feed: string; msg: FeedMessage }[] = [];
    let bytes = 0;
    let trips = 0;
    FEEDS.forEach((feed, i) => {
      const r = fetched[i];
      if (r.status === "rejected") {
        reports[feed] = { ok: false, feed_ts: null, reason: String((r.reason as Error)?.message ?? r.reason).slice(0, 40) };
        return;
      }
      bytes += r.value.byteLength;
      let msg: FeedMessage;
      try {
        msg = decodeFeed(r.value);
      } catch {
        reports[feed] = { ok: false, feed_ts: null, reason: "decode" };
        return;
      }
      if (nowS - msg.timestamp > MAX_FEED_AGE_S) {
        reports[feed] = { ok: false, feed_ts: msg.timestamp, reason: "feed_too_old" };
        return;
      }
      reports[feed] = { ok: true, feed_ts: msg.timestamp, reason: null };
      trips += msg.trips.length;
      healthy.push({ feed, msg });
    });
    meta.decode_ms = now() - tDecode;
    meta.bytes = bytes;
    meta.trips = trips;

    // 3. Candidate boards (next 3 per route per platform)
    const tBuild = now();
    const boards = buildCandidates(healthy, nowS);
    meta.build_ms = now() - tBuild;
    meta.boards_sent = boards.length;

    // 4. Commit: validation, diff and fenced writes all happen in PostgreSQL
    const tCommit = now();
    const res = (await deps.rpc("commit_worker_run", {
      p_run_id: runId,
      p_feeds: reports,
      p_boards: boards,
      p_meta: meta,
    })) as RunResult;
    meta.commit_ms = now() - tCommit;
    meta.total_ms = now() - t0;
    return { ...res, run_id: runId, meta };
  } catch (e) {
    const error = (e as Error).message ?? String(e);
    meta.total_ms = now() - t0;
    try {
      await deps.rpc("fail_worker_run", { p_run_id: runId, p_error: error, p_meta: meta });
    } catch {
      // the run row stays 'running'; its lease expires and the next claim supersedes it
    }
    return { run_id: runId, status: "error", error, meta };
  }
}
