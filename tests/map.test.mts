// Map tests against the real generated assets (public/data/map.json from MTA GTFS, basemap.json from
// NYC Open Data + Census) and the pure layout helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  balanceRows, lineIds, markRows, offsetLine, overlapArea, placeCallout, placeLabels, placeNumbers, primaryStop, stopFor, stopOrder, stopsOf, textWidth, transferMinutes, visibleTiles, wrapName,
  type Box, type LabelCandidate,
} from "../lib/headway/mapLayout.ts";

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

test("transfers: documented only, solid within a complex, dashed between complexes, no web or hub", () => {
  type C = { id: number; stops: { n: string; r: string[]; x: number; y: number }[]; t: [number, number, number][]; links: [number, number][] };
  const complexes = map.complexes as C[];
  assert.equal(complexes.length, map.stations.filter((s: { nodes: unknown[] }) => s.nodes.length > 1).length, "every multi-stop station");
  for (const c of complexes) {
    const st = station(c.id);
    assert.equal(c.stops.length, st.nodes.length);
    for (const s of c.stops) assert.ok(st.nodes.some(([x, y]: number[]) => x === s.x && y === s.y), `${s.n} is at a real stop position`);
    for (const [i, j, secs] of c.t) assert.ok(c.stops[i] && c.stops[j] && i !== j && secs >= 0); // 0 s is real: Queensboro Plaza's 7 to N/W
    const documented = (i: number, j: number) => c.t.some(([x, y]) => (x === i && y === j) || (x === j && y === i));
    for (const [i, j] of c.links) assert.ok(documented(i, j), `${st.name}: every line is a documented transfer`);
    assert.ok(c.links.length <= c.stops.length - 1, `${st.name}: a tree, never every pair`);
  }
  const ts = complexes.find((c) => c.id === 611)!;
  const at = (r: string) => ts.stops.findIndex((s) => s.r.includes(r));
  const time = (a: number, b: number) => ts.t.find(([x, y]) => (x === a && y === b) || (x === b && y === a))?.[2];
  assert.equal(ts.t.length, 10, "Times Sq documents every pair of its 5 stops");
  assert.equal(ts.links.length, 4, "but draws only 4");
  const degree = new Map<number, number>();
  for (const l of ts.links) for (const i of l) degree.set(i, (degree.get(i) ?? 0) + 1);
  assert.ok(Math.max(...degree.values()) <= 2, "a chain, no hub");
  assert.equal(time(at("A"), at("7")), 180, "A/C/E to the 7: 3 minutes");
  assert.equal(time(at("A"), at("N")), 300, "A/C/E to N/Q/R/W: 5 minutes");
  assert.ok(ts.links.some(([i, j]) => [i, j].includes(at("A")) && [i, j].includes(at("7"))), "A/C/E connects by its shortest documented transfer");
  const wh = map.stations.find((s: { name: string }) => s.name === "Whitehall St-South Ferry");
  assert.equal(complexes.find((c) => c.id === wh.id)!.links.length, 0, "no documented transfer, so no line");
  assert.equal(map.walks.length, 2, "only the documented transfers between separate complexes are dashed");
  for (const w of map.walks) assert.notEqual(w.a, w.b);
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

test("street tiles: real streets, same projection, loaded by what's in view", () => {
  const index = JSON.parse(readFileSync(new URL("../public/data/streets/index.json", import.meta.url), "utf8"));
  const ts = station(611);
  const key = `${Math.floor(ts.x / index.size)}_${Math.floor(ts.y / index.size)}`;
  assert.ok(index.tiles.includes(key), "Times Sq's tile exists");
  const tile = JSON.parse(readFileSync(new URL(`../public/data/streets/${key}.json`, import.meta.url), "utf8"));
  const w42 = tile.n.filter((n: unknown[]) => n[0] === "W 42 St");
  assert.ok(w42.length > 0, "West 42nd Street is in the Times Sq tile");
  assert.ok(w42.every((n: number[]) => inside(borough("Manhattan"), [n[1], n[2]])), "and sits in Manhattan on the same projection");
  assert.ok(w42.some((n: number[]) => Math.hypot(n[1] - ts.x, n[2] - ts.y) < 40), "near Times Sq");
  const set = new Set<string>(index.tiles);
  const k = 5, view = { k, x: 300 - ts.x * k, y: 300 - ts.y * k };
  assert.ok(visibleTiles(view, 600, 600, index.size, set).includes(key), "the tile under the view loads");
  assert.deepEqual(visibleTiles({ k: 5, x: 1e6, y: 1e6 }, 600, 600, index.size, set), [], "nothing loads off the map");
});

test("stops: real positions, rider line names, a sensible default stop", () => {
  const ts = map.complexes.find((c: { id: number }) => c.id === 611);
  const stops = stopsOf(station(611), ts);
  assert.equal(stops.length, 5, "Times Sq opens as its 5 real stops");
  const at = (r: string) => stops.findIndex((s) => s.r.includes(r));
  assert.equal(stops[at("A")].n, "42 St-Port Authority Bus Terminal", "the A/C/E stop keeps its own name");
  assert.deepEqual(lineIds(stops[at("7")].r), ["7"], "the 7 express folds into the 7");
  assert.equal(primaryStop(stops), at("N"), "default: the busiest stop (N/Q/R/W), not a made-up centre");
  assert.equal(primaryStop(stops, [at("1"), at("7")]), at("1"), "between two overlapping stops, the busier one");
  assert.equal(stopFor(stops, "7"), at("7"), "a planned 7 leg starts at the 7's own stop");
  const one = map.stations.find((s: { nodes: unknown[] }) => s.nodes.length === 1);
  const single = stopsOf(one);
  assert.equal(single.length, 1);
  assert.deepEqual([single[0].x, single[0].y], one.nodes[0], "a one-stop station is its real stop");
  assert.equal(transferMinutes(180), "3 min");
  assert.equal(transferMinutes(0), "under 1 min", "Queensboro Plaza's 0 s cross-platform transfer");
});

test("callouts stay in the map, clear of controls and stops, and don't flip while panning", () => {
  const bounds: Box = [8, 8, 792, 578];
  const inside = (c: { x: number; y: number }, w: number, h: number) => c.x >= bounds[0] && c.y >= bounds[1] && c.x + w <= bounds[2] && c.y + h <= bounds[3];
  // open space: first choice, pointer on the box
  const a = placeCallout({ x: 300, y: 300, w: 220, h: 90, gap: 16, bounds });
  assert.equal(a.side, "right");
  assert.ok(inside(a, 220, 90) && a.tip > 0 && a.tip < 90);
  // near the right edge: it moves to another side, still inside
  const b = placeCallout({ x: 760, y: 300, w: 220, h: 90, gap: 16, bounds });
  assert.notEqual(b.side, "right");
  assert.ok(inside(b, 220, 90));
  // near the top: slides down along its side, but the pointer stays on the box
  const c = placeCallout({ x: 300, y: 20, w: 220, h: 90, gap: 16, bounds });
  assert.ok(inside(c, 220, 90) && c.tip >= 12 && c.tip <= 90 - 12);
  // hard obstacles (the zoom controls, another stop) are avoided when there's room
  const controls: Box = [316, 200, 560, 400];
  const d = placeCallout({ x: 300, y: 300, w: 220, h: 90, gap: 16, bounds, hard: [controls] });
  assert.equal(overlapArea([d.x, d.y, d.x + 220, d.y + 90], controls), 0);
  // labels are soft: the side covering fewer of them wins
  const label: Box = [310, 280, 420, 300];
  assert.notEqual(placeCallout({ x: 300, y: 300, w: 220, h: 90, gap: 16, bounds, soft: [{ box: label }] }).side, "right");
  // and a station's name outweighs a larger street name
  const station: Box = [100, 280, 200, 300], street: Box = [310, 270, 500, 300]; // 2,000 px² × 4 vs 5,520 px²
  assert.equal(placeCallout({ x: 300, y: 300, w: 220, h: 90, gap: 16, bounds, order: ["right", "left"], soft: [{ box: station, weight: 4 }, { box: street }] }).side, "right");
  // sticky: an equally good previous side is kept
  assert.equal(placeCallout({ x: 400, y: 300, w: 220, h: 90, gap: 16, bounds, prev: "left" }).side, "left");
  // a stop number just above the anchor on its best side: the box steps down along that side, pointer still on it
  const number: Box = [310, 260, 334, 284];
  const e = placeCallout({ x: 300, y: 300, w: 220, h: 90, gap: 16, bounds, order: ["right", "left"], hard: [number], soft: [{ box: [60, 250, 290, 350], weight: 10 }] });
  assert.equal(e.side, "right");
  assert.equal(overlapArea([e.x, e.y, e.x + 220, e.y + 90], number), 0);
  assert.ok(e.tip >= 12 && e.tip <= 90 - 12);
  assert.equal(e.reach, 0, "attached when there's room");
  // a ring of numbers all round the anchor (your stop in the middle of its station): it stands off just far enough
  const ring: Box[] = [[270, 270, 330, 330], [250, 285, 270, 315], [330, 285, 350, 315], [285, 250, 315, 270], [285, 330, 315, 350]];
  const f = placeCallout({ x: 300, y: 300, w: 220, h: 90, gap: 16, bounds, hard: ring.slice(1), reach: [12, 24, 36, 48] });
  assert.ok(f.reach > 0);
  for (const q of ring.slice(1)) assert.equal(overlapArea([f.x, f.y, f.x + 220, f.y + 90], q), 0);
});

test("complexes: every stop gets its own number, in the station header's line order, never a shared marker", () => {
  // MTA's route order as the database lists it (the station header shows A C E N Q R W S 1 2 3 7)
  const rank = (r: string) => ["A", "C", "E", "N", "Q", "R", "W", "GS", "1", "2", "3", "7"].indexOf(r);
  const ts = map.complexes.find((c: { id: number }) => c.id === 611);
  const stops = stopsOf(station(611), ts);
  const order = stopOrder(stops, rank);
  assert.deepEqual(order.map((i) => lineIds(stops[i].r).join("")), ["ACE", "NQRW", "GS", "123", "7"], "1 A/C/E · 2 N/Q/R/W · 3 S · 4 1/2/3 · 5 7");

  // the map's sizes: a number's radius (with its halo) and a stop marker's, at each zoom the map numbers stops
  const opts = (k: number) => {
    const dot = 6 * Math.min(1.25, Math.max(0.8, k / 10)) + 3.5, r = 11;
    return { r, dot, inlinePx: (r - 3) * 2 + 4 };
  };
  const at = (k: number) => (s: { x: number; y: number }) => ({ x: s.x * k, y: s.y * k });
  const at10 = placeNumbers(stops.map(at(10)), order, opts(10));
  assert.ok(at10, "Times Sq is numbered at the station page's zoom");
  const byLine = (l: string) => at10[stops.findIndex((s) => lineIds(s.r).join("") === l)];
  // the 1/2/3 and 7 stops are 0.6 units apart in MTA's data: each keeps its own marker, numbers set off with leaders
  assert.equal(byLine("123").inline, false);
  assert.equal(byLine("7").inline, false);
  assert.equal(byLine("ACE").inline, true, "a stop with room carries its number on its own marker");
  // your stop keeps its number on its own marker whenever that covers no other stop (the phone strip opens at zoom 8,
  // where N/Q/R/W is 18 px from the 1/2/3): the crowded stops make room instead
  const nqrw = stops.findIndex((s) => lineIds(s.r).join("") === "NQRW");
  assert.equal(placeNumbers(stops.map(at(8)), order, opts(8))![nqrw].inline, false, "without the preference it's set off");
  assert.equal(placeNumbers(stops.map(at(8)), order, { ...opts(8), own: { i: nqrw, px: 16 } })![nqrw].inline, true);

  const complexes = map.complexes as { id: number; stops: { n: string; r: string[]; x: number; y: number }[] }[];
  for (const k of [6, 8, 10, 14, 18, 24]) {
    const o = opts(k);
    for (const c of complexes) {
      const ps = c.stops.map(at(k));
      const own = { i: primaryStop(c.stops), px: o.r + o.dot - 4 };
      const spots = placeNumbers(ps, stopOrder(c.stops, rank), { ...o, own });
      assert.ok(spots, `${station(c.id).name} is numbered at zoom ${k}`);
      const onMarker = (i: number) => (i === own.i ? own.px : o.inlinePx); // how clear a number on its own marker is kept
      spots.forEach((s, i) => {
        // numbers never overlap one another, never cover a stop, and stay close to their own stop
        spots.forEach((t, j) => {
          if (j > i) assert.ok(Math.hypot(s.x - t.x, s.y - t.y) >= (s.inline && t.inline ? Math.min(onMarker(i), onMarker(j)) : o.r * 2 + 2) - 1e-6, `${station(c.id).name} @${k}: numbers ${i} and ${j} overlap`);
        });
        ps.forEach((p, j) => {
          if (j === i && s.inline) return; // on its own marker
          const min = s.inline ? onMarker(i) : o.r + o.dot;
          assert.ok(Math.hypot(s.x - p.x, s.y - p.y) >= min - 1e-6, `${station(c.id).name} @${k}: a number covers a stop`);
        });
        assert.ok(Math.hypot(s.x - ps[i].x, s.y - ps[i].y) <= o.r + o.dot + 24 + 1e-6, "next to its own stop");
        // and the stops themselves never move
        if (s.inline) assert.deepEqual([s.x, s.y], [ps[i].x, ps[i].y]);
      });
    }
  }
  // stops on different levels at the very same spot (W 4 St): one marker, two numbers with their own leaders
  const w4 = map.stations.find((s: { name: string }) => s.name === "W 4 St-Wash Sq");
  const w4stops = stopsOf(w4, map.complexes.find((c: { id: number }) => c.id === w4.id));
  const w4spots = placeNumbers(w4stops.map(at(24)), w4stops.map((_, i) => i), opts(24))!;
  assert.equal(w4spots.filter((s) => !s.inline).length, w4stops.length);
  // when there's no clean room, it says so (the map then shows the stops without numbers) rather than overlapping them
  const crowd = Array.from({ length: 12 }, () => ({ x: 0, y: 0 }));
  assert.equal(placeNumbers(crowd, crowd.map((_, i) => i), { r: 11, dot: 9, inlinePx: 20 }), null);
});

test("the sign's transfer marks stay on one row, or two balanced rows, never a stray mark", () => {
  assert.deepEqual(markRows([1, 2, 3, 4, 5, 6, 7, 8, 9]).map((r) => r.length), [9], "9 fit on one row");
  assert.deepEqual(markRows([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]).map((r) => r.length), [6, 5], "11 split 6 + 5");
  // numbered: whole stops per row, balanced by size (a number plus its lines), never split inside a stop
  const groups = [{ n: 1, l: 3 }, { n: 3, l: 1 }, { n: 4, l: 3 }, { n: 5, l: 1 }]; // Times Sq from N/Q/R/W
  assert.deepEqual(balanceRows(groups, (g) => g.l + 1, 8).map((r) => r.map((g) => g.n)), [[1, 3], [4, 5]]);
  assert.deepEqual(balanceRows(groups.slice(0, 2), (g) => g.l + 1, 8).map((r) => r.length), [2], "fits on one row");
});

test("long station names wrap into two balanced lines", () => {
  assert.deepEqual(wrapName("50 St"), ["50 St"]);
  assert.deepEqual(wrapName("47-50 Sts-Rockefeller Ctr"), ["47-50 Sts", "Rockefeller Ctr"]);
  assert.deepEqual(wrapName("34 St-Penn Station"), ["34 St-Penn", "Station"]);
});
