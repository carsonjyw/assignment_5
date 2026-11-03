// Unit tests for the page logic. Run: npm run test:ui  (Node runs TypeScript directly)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cardRows, computeFreshness, directionHeading, formatEta, freshnessText, groupStation, trainStatusText, visibleTrains,
  type Platform, type Route, type Train, type WorkerStatus,
} from "../lib/headway/core.ts";

const NOW = Date.UTC(2026, 10, 3, 19, 30, 0);
const nowS = NOW / 1000;
const train = (o: Partial<Train> = {}): Train => ({
  trip_id: "t", route_id: "A", eta: nowS + 300, kind: "arr", headsign: "Far Rockaway-Mott Av", live: true,
  feed: "gtfs-ace", carried: false, ...o,
});
const ROUTES: Record<string, Route> = Object.fromEntries(
  [["1", "gtfs", 20], ["2", "gtfs", 21], ["3", "gtfs", 22], ["A", "gtfs-ace", 1], ["C", "gtfs-ace", 2], ["E", "gtfs-ace", 3],
   ["N", "gtfs-nqrw", 13], ["7", "gtfs", 27], ["GS", "gtfs", 17]].map(([id, feed, order]) => [
    id, { route_id: id as string, short_name: id as string, long_name: "", color: "000000", text_color: "FFFFFF", feed: feed as string, sort_order: order as number },
  ]),
);

const ok = (ts = nowS - 5) => ({ ok: true, feed_ts: ts, reason: null, last_ok_at: null, fail_streak: 0 });
const status = (o: Partial<WorkerStatus> = {}): WorkerStatus => ({
  last_run_id: 10, last_run_at: new Date(NOW - 5000).toISOString(), last_success_at: new Date(NOW - 5000).toISOString(),
  last_status: "ok", feeds: { gtfs: ok(), "gtfs-ace": ok(), "gtfs-nqrw": ok() }, ...o,
});

test("formatEta: Arriving under a minute, minutes, hours", () => {
  assert.equal(formatEta(nowS + 30, NOW), "Arriving");
  assert.equal(formatEta(nowS - 10, NOW), "Arriving");
  assert.equal(formatEta(nowS + 61, NOW), "1 min");
  assert.equal(formatEta(nowS + 14 * 60 + 59, NOW), "14 min");
  assert.equal(formatEta(nowS + 65 * 60, NOW), "1 h 5 min");
});

test("live vs scheduled is explicit text", () => {
  assert.equal(trainStatusText(train()), "Live");
  assert.equal(trainStatusText(train({ live: false })), "Scheduled");
  assert.equal(trainStatusText(train({ carried: true })), "Delayed data");
});

test("direction headings: keep uptown/downtown, 'To' for places, fix generic fallbacks", () => {
  assert.equal(directionHeading("Uptown & The Bronx", []), "Uptown & The Bronx");
  assert.equal(directionHeading("Uptown - Queens", []), "Uptown and Queens");
  assert.equal(directionHeading("Grand Central", []), "To Grand Central");
  assert.equal(directionHeading("Euclid - Lefferts - Rockaways", []), "To Euclid, Lefferts, Rockaways");
  assert.equal(directionHeading("Northbound", [train({ headsign: "Times Sq-42 St" }), train({ headsign: "Times Sq-42 St" })]), "To Times Sq-42 St");
});

test("Times Sq style grouping: every line group, both directions, routes in order", () => {
  const p = (stop: string, parent: string, label: string, line: string): Platform => ({
    stop_id: stop, parent_stop_id: parent, station_id: 611, direction: stop.endsWith("N") ? "N" : "S", direction_label: label, line_name: line,
  });
  const platforms = [
    p("127S", "127", "Downtown & Brooklyn", "Broadway - 7Av"), p("127N", "127", "Uptown & The Bronx", "Broadway - 7Av"),
    p("A27N", "A27", "Uptown - Queens", "8th Av - Fulton St"), p("A27S", "A27", "Downtown & Brooklyn", "8th Av - Fulton St"),
    p("902N", "902", "Northbound", "Lexington - Shuttle"), p("902S", "902", "Grand Central", "Lexington - Shuttle"),
  ];
  const boards = {
    "127N": [train({ trip_id: "x2", route_id: "2", eta: nowS + 200, feed: "gtfs" }), train({ trip_id: "x1", route_id: "1", eta: nowS + 100, feed: "gtfs" })],
    "A27S": [train({ trip_id: "a", route_id: "A" }), train({ trip_id: "c", route_id: "C", eta: nowS - 120 })], // c already gone
    "902S": [train({ trip_id: "s", route_id: "GS", feed: "gtfs", headsign: "Grand Central-42 St" })],
  };
  const groups = groupStation(platforms, boards, ROUTES, NOW);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((g) => g.key), ["A27", "902", "127"]); // A (1) < GS (17) < 1 (20)
  for (const g of groups) assert.equal(g.directions.length, 2, "both directions always shown");
  const g127 = groups.find((g) => g.key === "127")!;
  assert.deepEqual(g127.directions.map((d) => d.direction), ["N", "S"]);
  assert.deepEqual(g127.directions[0].trains.map((t) => t.trip_id), ["x1", "x2"], "sorted by eta");
  assert.deepEqual(g127.routes, ["1", "2"]);
  assert.equal(groups.find((g) => g.key === "A27")!.directions[1].trains.length, 1, "past trains dropped locally");
  assert.equal(groups.find((g) => g.key === "902")!.directions[1].heading, "To Grand Central");
});

test("line filter and show-more keep every route reachable", () => {
  const ts = [1, 2, 3, 4, 5].map((i) => train({ trip_id: `t${i}`, route_id: i % 2 ? "A" : "C", eta: nowS + i * 60 }));
  assert.deepEqual(visibleTrains(ts, null, false), { shown: ts.slice(0, 3), hidden: 2 });
  assert.equal(visibleTrains(ts, null, true).hidden, 0);
  assert.deepEqual(visibleTrains(ts, "C", false).shown.map((t) => t.trip_id), ["t2", "t4"]);
});

test("home card rows: soonest directions first, capped, with 'then' times", () => {
  const platforms: Platform[] = ["A15N", "A15S"].map((s) => ({
    stop_id: s, parent_stop_id: "A15", station_id: 153, direction: s.endsWith("N") ? "N" : "S", direction_label: s.endsWith("N") ? "Uptown & The Bronx" : "Downtown & Brooklyn", line_name: "8th Av",
  }));
  const groups = groupStation(platforms, {
    A15N: [train({ trip_id: "n1", eta: nowS + 600 })],
    A15S: [train({ trip_id: "s1", eta: nowS + 120 }), train({ trip_id: "s2", eta: nowS + 240 }), train({ trip_id: "s3", eta: nowS + 360 }), train({ trip_id: "s4", eta: nowS + 480 })],
  }, ROUTES, NOW);
  const { rows, totalDirections } = cardRows(groups);
  assert.equal(totalDirections, 2);
  assert.deepEqual(rows.map((r) => r.first.trip_id), ["s1", "n1"]);
  assert.deepEqual(rows[0].then.map((t) => t.trip_id), ["s2", "s3"]);
});

test("freshness precedence: loading, fresh, partial, stale, down, reconnecting", () => {
  const base = { loaded: true, neededFeeds: ["gtfs-ace"], nowMs: NOW, realtimeHealthy: true };
  assert.equal(computeFreshness({ ...base, loaded: false, status: null }).kind, "loading");

  const fresh = computeFreshness({ ...base, status: status() });
  assert.equal(fresh.kind, "fresh");
  assert.equal(freshnessText(fresh), "Live · updated 5 s ago");

  // a recently successful worker run must not hide an outdated MTA feed
  const frozen = status({ feeds: { "gtfs-ace": ok(nowS - 120), gtfs: ok() } });
  assert.equal(computeFreshness({ ...base, neededFeeds: ["gtfs-ace", "gtfs"], status: frozen }).kind, "partial");
  assert.equal(computeFreshness({ ...base, status: frozen }).kind, "down", "the only feed this station needs is frozen");

  const silent = status({ last_success_at: new Date(NOW - 61_000).toISOString() });
  const stale = computeFreshness({ ...base, status: silent });
  assert.equal(stale.kind, "stale");
  assert.equal(freshnessText(stale), "Last updated 1 min ago, times may be off");

  assert.equal(computeFreshness({ ...base, status: status({ last_status: "error" }) }).kind, "down");

  const rc = computeFreshness({ ...base, status: status(), realtimeHealthy: false });
  assert.equal(rc.kind, "fresh");
  assert.equal(rc.reconnecting, true, "reconnecting is a banner on top of the data state");
});
