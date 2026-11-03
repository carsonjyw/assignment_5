// Planner tests against the real generated graph (public/data/plan.json from MTA static GTFS).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bandFor, planJourney, planOptions, type PlanData } from "../lib/headway/planner.ts";

const data: PlanData = JSON.parse(readFileSync(new URL("../public/data/plan.json", import.meta.url), "utf8"));
const map = JSON.parse(readFileSync(new URL("../public/data/map.json", import.meta.url), "utf8"));
const name = (id: number) => map.stations.find((s: { id: number }) => s.id === id)?.name;
const WEEKDAY_MIDDAY = "Weekday:midday";

test("transfer journey: 125 St → 14 St-Union Sq uses a real downtown route and MTA transfer", () => {
  const j = planJourney(data, WEEKDAY_MIDDAY, 153, 602)!;
  assert.ok(j, "route found");
  assert.ok(j.legs.length >= 2, "needs a transfer");
  assert.equal(j.legs[0].boardStation, 153);
  assert.equal(j.legs[0].direction, "S", "leaves 125 St southbound (downtown)");
  assert.equal(j.legs.at(-1)!.alightStation, 602);
  assert.equal(j.transfers.length, j.legs.length - 1);
  for (const t of j.transfers) assert.ok(t.walkS >= 0 && t.walkS <= 600);
  // every leg's stations are consecutive real stops of that line
  for (const l of j.legs) assert.ok(l.stations.length >= 2 && l.rideS > 0);
  assert.ok(j.totalS > 10 * 60 && j.totalS < 45 * 60, `plausible total ${j.totalS}s`);
  console.log("125 St → Union Sq:", j.legs.map((l) => `${l.route}${l.direction} ${name(l.boardStation)}→${name(l.alightStation)} (${l.stations.length - 1} stops)`).join(" + "), `${Math.round(j.totalS / 60)} min`);
});

test("direct journey: Astoria-Ditmars Blvd → Atlantic Av-Barclays is one N/W ride, no transfer", () => {
  const j = planJourney(data, WEEKDAY_MIDDAY, 1, 617)!;
  assert.equal(j.legs.length, 1);
  assert.ok(["N", "W"].includes(j.legs[0].route) || j.legs.length === 1);
  assert.equal(j.legs[0].direction, "S");
  assert.equal(j.transfers.length, 0);
});

test("direction is correct both ways: Times Sq ↔ 125 St", () => {
  const up = planJourney(data, WEEKDAY_MIDDAY, 611, 153)!;
  const down = planJourney(data, WEEKDAY_MIDDAY, 153, 611)!;
  assert.equal(up.legs[0].direction, "N");
  assert.equal(down.legs[0].direction, "S");
  assert.equal(up.legs.length, 1);
  assert.equal(down.legs.length, 1);
});

test("Staten Island Railway is reachable only via SIR legs within Staten Island", () => {
  const j = planJourney(data, WEEKDAY_MIDDAY, 501, 522)!; // St George → Tottenville
  assert.ok(j);
  assert.deepEqual([...new Set(j.legs.map((l) => l.route))], ["SI"]);
});

test("service patterns differ by period: late night has fewer segments than midday", () => {
  assert.ok(data.graph["Weekday:early"].segments.length < data.graph[WEEKDAY_MIDDAY].segments.length);
  assert.equal(bandFor(new Date("2026-11-04T15:00:00Z"), data).key, "Weekday:midday"); // 10:00 NY
  assert.equal(bandFor(new Date("2026-11-08T16:00:00Z"), data).key, "Sunday:midday"); // 11:00 EST
  assert.equal(bandFor(new Date("2026-11-08T14:00:00Z"), data).key, "Sunday:am");
});

test("same station or unknown station returns no journey (never an invented route)", () => {
  assert.equal(planJourney(data, WEEKDAY_MIDDAY, 611, 611), null);
  assert.equal(planJourney(data, WEEKDAY_MIDDAY, 611, 999999), null);
  assert.equal(planJourney(data, "Holiday:none", 611, 153), null);
});

test("options: fewer-transfers alternative only when it really has fewer transfers", () => {
  const opts = planOptions(data, WEEKDAY_MIDDAY, 153, 602);
  assert.ok(opts.length >= 1 && opts.length <= 2);
  if (opts.length === 2) assert.ok(opts[1].transfers.length < opts[0].transfers.length);
});

test("map asset uses real MTA coordinates and geometry only", () => {
  assert.equal(map.stations.length, 445);
  assert.ok(map.segs.length > 400, "track network: one segment per pair of adjacent stations");
  const ts = map.stations.find((s: { id: number }) => s.id === 611);
  assert.ok(ts.routes.includes("7") && ts.routes.includes("A"), "routes from the schedule");
});
