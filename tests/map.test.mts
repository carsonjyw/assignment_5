// Map tests against the real generated assets (public/data/map.json from MTA GTFS, basemap.json from
// NYC Open Data + Census) and the pure layout helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { offsetLine, placeLabels, textWidth, type LabelCandidate } from "../lib/headway/mapLayout.ts";

const map = JSON.parse(readFileSync(new URL("../public/data/map.json", import.meta.url), "utf8"));
const base = JSON.parse(readFileSync(new URL("../public/data/basemap.json", import.meta.url), "utf8"));
const key = (x: number, y: number) => `${x},${y}`;
const ends = (d: number[]) => [key(d[0], d[1]), key(d[d.length - 2], d[d.length - 1])];
const station = (id: number) => map.stations.find((s: { id: number }) => s.id === id);

test("every route's track is one connected network (no fragments)", () => {
  for (let r = 0; r < map.routes.length; r++) {
    const segs = map.segs.filter((s: { r: number[] }) => s.r.includes(r));
    assert.ok(segs.length > 0, `${map.routes[r]} has track`);
    const adj = new Map<string, Set<string>>();
    for (const s of segs) {
      const [a, b] = ends(s.d);
      adj.set(a, (adj.get(a) ?? new Set()).add(b));
      adj.set(b, (adj.get(b) ?? new Set()).add(a));
    }
    const start = adj.keys().next().value!;
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) for (const n of adj.get(queue.pop()!)!) if (!seen.has(n)) { seen.add(n); queue.push(n); }
    assert.equal(seen.size, adj.size, `${map.routes[r]}: ${adj.size - seen.size} nodes not connected`);
  }
});

test("shared track is drawn once: a segment carries every route that runs on it", () => {
  const counts = map.segs.map((s: { r: number[] }) => s.r.length);
  assert.ok(counts.filter((n: number) => n >= 3).length > 50, "trunk sections carry several routes");
  // Lexington Av express 4/5 and local 6 share the 59 St → 86 St corridor, drawn as one bundle
  const ri = (r: string) => map.routes.indexOf(r);
  const hop = map.hops.find(([r, a, b]: number[]) => r === ri("4") && a === Math.min(613, 397) && b === Math.max(613, 397));
  assert.ok(hop, "4 train hop 59 St → 86 St exists");
  assert.ok(hop[3].length >= 3, "the express hop runs through the local stations (68 St, 77 St), not a straight chord");
  for (const i of hop[3]) assert.ok(map.segs[i].r.includes(ri("6")), "and shares those segments with the 6");
});

test("express hops split only at stations the train really passes", () => {
  const ri = (r: string) => map.routes.indexOf(r);
  const nodeKeys = (id: number) => station(id).nodes.map(([x, y]: number[]) => key(x, y));
  const onRoute = (id: number, r: string) => map.segs.some((s: { r: number[]; d: number[] }) => s.r.includes(ri(r)) && ends(s.d).some((e) => nodeKeys(id).includes(e)));
  assert.ok(!onRoute(223, "4"), "the 4 does not run through Lexington Av/63 St (a crossing line)");
  assert.ok(onRoute(53, "B") && onRoute(52, "B"), "the B express passes Neck Rd and Avenue U on the Brighton line's shared tracks");
});

test("planned legs can be drawn on real track: hops cover the network", () => {
  assert.ok(map.hops.length > 900);
  for (const [, , , segs] of map.hops) for (const i of segs) assert.ok(map.segs[i], "hop points at a real segment");
});

test("interchanges keep their real station positions (Times Sq has 5 member stations)", () => {
  const ts = station(611);
  assert.equal(ts.nodes.length, 5);
  for (const [x, y] of ts.nodes) assert.ok(Math.hypot(x - ts.x, y - ts.y) < 12, "members are within the complex");
});

// ------------------------------------------------------------------ basemap alignment (same projection)
function rings(d: string): [number, number][][] {
  return d.split("Z").filter(Boolean).map((r) => r.replace(/^M/, "").split("L").map((p) => p.split(",").map(Number) as [number, number]));
}
function inside(rs: [number, number][][], [x, y]: [number, number]) {
  let c = false;
  for (const r of rs) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const borough = (n: string) => rings(base.land.find((l: { n: string }) => l.n === n).d);
const allLand = base.land.flatMap((l: { d: string }) => rings(l.d));

test("basemap and network share one projection: stations sit in the right borough", () => {
  const at = (id: number) => [station(id).x, station(id).y] as [number, number];
  assert.ok(inside(borough("Manhattan"), at(611)), "Times Sq is in Manhattan");
  assert.ok(inside(borough("Manhattan"), at(153)), "125 St (A) is in Manhattan");
  assert.ok(inside(borough("Brooklyn"), at(58)), "Coney Island is in Brooklyn");
  assert.ok(inside(borough("Staten Island"), at(501)), "St George is on Staten Island");
  // and the share of stations on land is essentially all of them (a few sit at piers/bridgeheads)
  const onLand = map.stations.filter((s: { x: number; y: number }) => inside(allLand, [s.x, s.y])).length;
  assert.ok(onLand / map.stations.length > 0.97, `${onLand}/${map.stations.length} stations on land`);
});

test("water labels are on water and borough labels on land", () => {
  for (const l of base.labels) {
    if (l.k === "water") assert.ok(!inside(allLand, [l.x, l.y]), `${l.t} is on water`);
    if (l.k === "borough") assert.ok(inside(allLand, [l.x, l.y]), `${l.t} is on land`);
  }
  const names = base.labels.map((l: { t: string }) => l.t);
  for (const n of ["Hudson River", "East River", "Harlem River", "MANHATTAN", "BROOKLYN", "QUEENS", "THE BRONX", "STATEN ISLAND", "Midtown", "Harlem", "Astoria", "Williamsburg", "Flushing", "Central Park", "Prospect Park"]) {
    assert.ok(names.includes(n), `${n} labelled`);
  }
});

// ------------------------------------------------------------------ layout helpers
test("offsetLine keeps parallel lines parallel", () => {
  const d = [0, 0, 10, 0, 20, 0];
  assert.deepEqual(offsetLine(d, 2).map((v) => Math.round(v * 100) / 100), [0, 2, 10, 2, 20, 2]);
  const bend = offsetLine([0, 0, 10, 0, 10, 10], 1);
  assert.ok(Math.abs(bend[2] - 9) < 1e-9 && Math.abs(bend[3] - 1) < 1e-9, "mitred corner");
});

test("labels never overlap, important ones always win, nearby duplicates are dropped", () => {
  const c = (key: string, text: string, x: number, y: number, priority: number, dedupe = true): LabelCandidate =>
    ({ key, text, x, y, fs: 12, pad: 4, priority, dedupe });
  const placed = placeLabels([
    c("a", "23 St", 0, 0, 3), c("b", "23 St", 10, 0, 3), // same name a few blocks apart
    c("c", "Times Sq-42 St", 1, 0, 0, false), // the selected station
    c("d", "28 St", 0, 3, 3),
    c("e", "23 St", 400, 0, 3), // same name far away is fine
  ], 1);
  const keys = placed.map((p) => p.key);
  assert.ok(keys.includes("c"), "selected station is placed");
  assert.equal(keys.filter((k) => k === "a" || k === "b").length <= 1, true, "one '23 St' nearby");
  assert.ok(keys.includes("e"));
  const box = (p: (typeof placed)[number]) => {
    const w = textWidth(p.text, p.c.fs), h = p.c.fs * 1.25;
    const x0 = p.anchor === "start" ? p.x + p.dx : p.anchor === "end" ? p.x + p.dx - w : p.x - w / 2;
    const yc = p.y + p.dy - p.c.fs * 0.35;
    return [x0, yc - h / 2, x0 + w, yc + h / 2];
  };
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    const [a, b] = [box(placed[i]), box(placed[j])];
    assert.ok(!(a[0] < b[2] - 1 && a[2] > b[0] + 1 && a[1] < b[3] - 1 && a[3] > b[1] + 1), `${placed[i].key} and ${placed[j].key} overlap`);
  }
});
