// Pure layout helpers for the subway map: bundle offsets and label placement. No React, so it's testable.

/** Offset a flat [x0,y0,x1,y1,…] polyline sideways by `off` (world units), with mitred joins. */
export function offsetLine(d: number[], off: number): number[] {
  const n = d.length / 2;
  if (off === 0 || n < 2) return d;
  const out = new Array<number>(d.length);
  const normal = (i: number, j: number): [number, number] => {
    const dx = d[2 * j] - d[2 * i], dy = d[2 * j + 1] - d[2 * i + 1];
    const L = Math.hypot(dx, dy) || 1;
    return [-dy / L, dx / L];
  };
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? normal(i - 1, i) : null;
    const b = i < n - 1 ? normal(i, i + 1) : null;
    let nx = (a?.[0] ?? 0) + (b?.[0] ?? 0), ny = (a?.[1] ?? 0) + (b?.[1] ?? 0);
    const L = Math.hypot(nx, ny) || 1;
    nx /= L; ny /= L;
    // mitre: keep parallel lines parallel through a bend, but never spike on sharp turns
    const cos = a ? nx * a[0] + ny * a[1] : 1;
    const scale = 1 / Math.max(0.55, cos);
    out[2 * i] = d[2 * i] + nx * off * scale;
    out[2 * i + 1] = d[2 * i + 1] + ny * off * scale;
  }
  return out;
}

export const points = (d: number[]) => {
  let s = "";
  for (let i = 0; i < d.length; i += 2) s += `${i ? " " : ""}${d[i].toFixed(2)},${d[i + 1].toFixed(2)}`;
  return s;
};

export interface LabelCandidate {
  key: string;
  text: string;
  x: number; y: number; // world anchor
  fs: number; // font size, px
  pad: number; // distance from the anchor to the text, px (symbol radius + gap)
  priority: number; // lower is placed first
  rotate?: number; // degrees; rotated labels are centred on the anchor
  caps?: boolean; // tracked capitals are wider
  fixed?: boolean; // centred on the anchor, no alternative positions (area labels)
  dedupe?: boolean; // skip if the same text was already placed nearby (stations that share a name)
  lines?: string[]; // wrapped text, for large close-up station labels
}
/** `box`: where the label sits, in px at the zoom it was placed (world × k), for collision checks by callouts. */
export interface PlacedLabel { key: string; text: string; x: number; y: number; dx: number; dy: number; anchor: "start" | "end" | "middle"; c: LabelCandidate; box: Box }

export type Box = [number, number, number, number];
const hit = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/** Estimated text box (px) for Inter Tight at weight 600–800. */
export function textWidth(text: string, fs: number, caps = false) {
  return text.length * fs * (caps ? 0.74 : 0.55) + 2;
}

/**
 * Greedy collision-free placement at zoom k (screen px = world × k; pan doesn't change overlaps).
 * Each station label tries right, left, above, below its symbol; area labels are centred or skipped.
 * Labels sharing a name with one already placed within `dupPx` are skipped (e.g. two "23 St" a few blocks apart).
 */
export function placeLabels(cands: LabelCandidate[], k: number, dupPx = 140, obstacles: Box[] = []): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  const boxes: Box[] = [...obstacles];
  const byText = new Map<string, [number, number][]>();
  const sorted = [...cands].sort((a, b) => a.priority - b.priority);
  for (const c of sorted) {
    const sx = c.x * k, sy = c.y * k;
    if (c.dedupe && (byText.get(c.text) ?? []).some(([x, y]) => Math.hypot(x - sx, y - sy) < dupPx)) continue;
    const rows = c.lines ?? [c.text];
    const w = Math.max(...rows.map((t) => textWidth(t, c.fs, c.caps))), h = c.fs * 1.25 * rows.length;
    const up = (rows.length - 1) * c.fs * 0.6; // keeps a wrapped label centred on its anchor
    const options: [number, number, "start" | "end" | "middle", Box][] = [];
    if (c.fixed || c.rotate) {
      const rad = ((c.rotate ?? 0) * Math.PI) / 180;
      const bw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
      const bh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
      options.push([0, c.fs * 0.35, "middle", [sx - bw / 2, sy - bh / 2, sx + bw / 2, sy + bh / 2]]);
    } else {
      const p = c.pad;
      options.push(
        [p, c.fs * 0.35 - up, "start", [sx + p - 1, sy - h / 2, sx + p + w, sy + h / 2]],
        [-p, c.fs * 0.35 - up, "end", [sx - p - w, sy - h / 2, sx - p + 1, sy + h / 2]],
        [0, -p - c.fs * 0.3 - up * 2, "middle", [sx - w / 2, sy - p - h, sx + w / 2, sy - p]],
        [0, p + c.fs * 0.95, "middle", [sx - w / 2, sy + p, sx + w / 2, sy + p + h]],
      );
    }
    const ok = options.find((o) => !boxes.some((b) => hit(b, o[3])));
    if (!ok) continue;
    boxes.push(ok[3]);
    placed.push({ key: c.key, text: c.text, x: c.x, y: c.y, dx: ok[0], dy: ok[1], anchor: ok[2], c, box: ok[3] });
    if (c.dedupe) byText.set(c.text, [...(byText.get(c.text) ?? []), [sx, sy]]);
  }
  return placed;
}

/** Zoom bucket: layers that depend on zoom are rebuilt only when k crosses a step of ×1.2. */
export const zoomBucket = (k: number) => Math.pow(1.2, Math.round(Math.log(k) / Math.log(1.2)));

/** Line width in screen px: thin when zoomed out, fuller when zoomed in. */
export const lineWidth = (k: number) => Math.min(7, Math.max(2, 2.1 * Math.pow(k, 0.45)));

/** Two balanced lines for a long station name: "47-50 Sts-Rockefeller Ctr" → "47-50 Sts", "Rockefeller Ctr". */
export function wrapName(name: string): string[] {
  if (name.length <= 14) return [name];
  let best = -1;
  for (let i = 1; i < name.length - 1; i++) {
    if ((name[i] === " " || name[i] === "-") && (best < 0 || Math.abs(i - name.length / 2) < Math.abs(best - name.length / 2))) best = i;
  }
  return best < 0 ? [name] : [name.slice(0, best), name.slice(best + 1)];
}

// ------------------------------------------------------------------ stops
/** One physical stop: its name, the routes MTA lists there, and its real position. */
export interface MapStop { n: string; r: string[]; x: number; y: number }

/** A station's physical stops: its complex's member stops, or the station itself. */
export function stopsOf(s: { name: string; routes: string[]; nodes: [number, number][]; x: number; y: number }, complex?: { stops: MapStop[] }): MapStop[] {
  if (complex?.stops.length) return complex.stops;
  const [x, y] = s.nodes[0] ?? [s.x, s.y];
  return [{ n: s.name, r: s.routes, x, y }];
}

/** Lines as riders name them: part-time express variants (6X, 7X, FX) fold into their line. */
export function lineIds(r: string[]): string[] {
  const out = [...new Set(r.filter((id) => !/^\dX$|^FX$/.test(id)))];
  return out.length ? out : [...new Set(r)];
}

/** Without a stop chosen on the map, a station opens at its busiest stop (most lines, then MTA's order). */
export function primaryStop(stops: MapStop[], among: number[] = stops.map((_, i) => i)): number {
  let best = among[0] ?? 0;
  for (const i of among) if (lineIds(stops[i].r).length > lineIds(stops[best].r).length) best = i;
  return best;
}

/** The order a complex's stops are numbered in, on the map and in Connections: by each stop's first line in MTA's
 *  route order (the order the station header lists them), then the data's order. */
export function stopOrder(stops: MapStop[], rank: (route: string) => number): number[] {
  const first = (s: MapStop) => Math.min(...lineIds(s.r).map(rank));
  return stops.map((_, i) => i).sort((a, b) => first(stops[a]) - first(stops[b]) || a - b);
}

/** Where a numbered stop's number sits, in screen px: on the stop's own marker (`inline`), or just off it. */
export interface NumberSpot { x: number; y: number; inline: boolean }
type Pt = { x: number; y: number };
type Seg = [number, number, number, number];
const segPointDist = ([ax, ay, bx, by]: Seg, p: Pt) => {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / l)) : 0;
  return Math.hypot(p.x - ax - t * dx, p.y - ay - t * dy);
};
const segsCross = ([a, b, c, d]: Seg, [e, f, g, h]: Seg) => {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return o(a, b, c, d, e, f) !== o(a, b, c, d, g, h) && o(e, f, g, h, a, b) !== o(e, f, g, h, c, d);
};

/**
 * Numbers for a selected station's stops, in screen px at one zoom (pan doesn't change them). Stops never move.
 * A stop with no other stop within `inlinePx` carries its number on its own marker. Stops closer than that keep their
 * own marker at their real position, and their number sits just off it, joined by a short leader: placed in number
 * order, clear of every other number and every stop, leaders never crossing, pointing away from the nearest stops
 * where it can, and off the drawn transfers (`avoid`). `r`: a number's radius; `dot`: a stop marker's radius. `own`: your
 * stop, whose number stays on its own marker whenever it covers no other stop's marker (within `own.px`): the others make
 * room. `keepOut`: where the station sign will go (on a phone's short map), kept clear where possible. Null when a
 * number can't be placed cleanly: the map then highlights the stops without numbers at this zoom rather than forcing them.
 */
export function placeNumbers(pts: Pt[], order: number[], o: {
  r: number; dot: number; inlinePx: number; avoid?: Seg[]; own?: { i: number; px: number }; keepOut?: Box;
}): NumberSpot[] | null {
  const spots: (NumberSpot | null)[] = pts.map(() => null);
  const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const clear = (i: number, px: number) => pts.every((q, j) => j === i || dist(q, pts[i]) >= px);
  if (o.own && pts[o.own.i] && clear(o.own.i, o.own.px)) spots[o.own.i] = { ...pts[o.own.i], inline: true };
  for (const i of order) if (!spots[i] && clear(i, o.inlinePx) && spots.every((s, j) => !s || j === i || dist(s, pts[i]) >= o.inlinePx)) spots[i] = { ...pts[i], inline: true };
  const leaders: Seg[] = [];
  const HARD = 1e4;
  for (const i of order) {
    if (spots[i]) continue;
    const p = pts[i];
    // away from the stops crowding it, the closest counting most (stops at the very same spot give no direction)
    let ax = 0, ay = 0;
    pts.forEach((q, j) => {
      const d = dist(p, q);
      if (j !== i && d > 0.5 && d < o.inlinePx * 3) { ax += (p.x - q.x) / (d * d); ay += (p.y - q.y) / (d * d); }
    });
    const al = Math.hypot(ax, ay);
    let best: { s: NumberSpot; l: Seg } | null = null, bestCost = Infinity;
    for (const reach of [8, 15, 24]) {
      const d = o.r + o.dot + reach;
      for (let a = 0; a < 16; a++) {
        const t = -Math.PI / 2 + (a * Math.PI) / 8, cx = Math.cos(t), cy = Math.sin(t);
        const c = { x: p.x + cx * d, y: p.y + cy * d };
        const l: Seg = [p.x + cx * o.dot, p.y + cy * o.dot, c.x - cx * o.r, c.y - cy * o.r];
        let cost = reach;
        for (const s of spots) if (s && (dist(s, c) < o.r * 2 + 2 || segPointDist(l, s) < o.r + 1)) cost += HARD;
        pts.forEach((q, j) => {
          if (dist(q, c) < o.r + o.dot + 2) cost += HARD; // never covers a stop
          else if (j !== i && segPointDist(l, q) < o.dot) cost += 40; // a leader over another stop reads badly
        });
        for (const m of leaders) if (segsCross(l, m) || segPointDist(m, c) < o.r + 1) cost += HARD;
        // rather not on a drawn transfer: a number sitting on one reads as part of it
        for (const m of o.avoid ?? []) if (segPointDist(m, c) < o.r) cost += 30;
        if (o.keepOut && overlapArea(o.keepOut, [c.x - o.r, c.y - o.r, c.x + o.r, c.y + o.r]) > 0) cost += 60;
        if (al > 0) cost -= 10 * ((cx * ax + cy * ay) / al);
        if (cost < bestCost) { bestCost = cost; best = { s: { ...c, inline: false }, l }; }
      }
    }
    if (!best || bestCost >= HARD) return null;
    spots[i] = best.s;
    leaders.push(best.l);
  }
  return spots as NumberSpot[];
}

/** Route marks in one row, or two balanced rows when there are more than `max` (6 + 5, never 10 + 1). */
export function markRows<T>(items: T[], max = 9): T[][] {
  return balanceRows(items, () => 1, max);
}

/** Items in one row, or two rows split where their sizes balance best, when they add up to more than `max`. */
export function balanceRows<T>(items: T[], size: (t: T) => number, max: number): T[][] {
  const total = items.reduce((a, t) => a + size(t), 0);
  if (total <= max || items.length < 2) return [items];
  let at = 1, best = Infinity, run = 0;
  for (let i = 1; i < items.length; i++) {
    run += size(items[i - 1]);
    // ties go to the longer first row (6 + 5, not 5 + 6)
    const gap = Math.abs(2 * run - total) - (run * 2 >= total ? 0.5 : 0);
    if (gap < best) { best = gap; at = i; }
  }
  return [items.slice(0, at), items.slice(at)];
}

/** MTA's minimum transfer time, as riders read it ("allow 3 min"). Not a measured walk: MTA doesn't publish one. */
export const transferMinutes = (secs: number) => (secs < 60 ? "under 1 min" : `${Math.round(secs / 60)} min`);

/** The stop a planned leg boards or leaves from: the one that route serves. */
export function stopFor(stops: MapStop[], route: string): number {
  const i = stops.findIndex((s) => s.r.includes(route));
  return i >= 0 ? i : primaryStop(stops);
}

// ------------------------------------------------------------------ callouts (station sign, tooltip, route badges)
export type Side = "right" | "left" | "top" | "bottom";
// top-left in px; tip: the anchor's offset along the attached edge; reach: how much further off than `gap` it stands
export interface Callout { side: Side; x: number; y: number; tip: number; reach: number }

export function overlapArea(a: Box, b: Box) {
  return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
}

/**
 * Place a w×h px box beside an anchor, `gap` px away: inside `bounds` if at all possible, clear of `hard` boxes
 * (map controls, the stops it describes), and over as little of the `soft` boxes (labels, weighted by importance)
 * as it can. It slides along its side to stay in bounds or to step clear of an obstacle, but never so far that the
 * pointer would leave the box. Keeps `prev` side unless another is clearly better, so it doesn't flip while the map pans.
 * Only when every spot beside the anchor covers a hard obstacle, it may stand further off by one of the `reach`
 * distances (its pointer then extends to the anchor), whichever covers least.
 */
export function placeCallout(o: {
  x: number; y: number; w: number; h: number; gap: number; bounds: Box; hard?: Box[]; soft?: { box: Box; weight?: number }[];
  order?: Side[]; prev?: Side | null; inset?: number; reach?: number[];
}): Callout {
  const { x: ax, y: ay, w, h, bounds } = o;
  const order = o.order ?? ["right", "top", "left", "bottom"];
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const slide = (start: number, size: number, anchor: number, lo: number, hi: number) => {
    const inset = Math.min(o.inset ?? 12, size / 2);
    return clamp(clamp(start, lo, hi - size), anchor - size + inset, anchor - inset);
  };
  let best: Callout = { side: order[0], x: ax + o.gap, y: ay - h / 2, tip: h / 2, reach: 0 }, bestScore = Infinity, bestHard = Infinity;
  const tryAt = (reach: number) => order.forEach((side, rank) => {
    const across = side === "right" || side === "left", gap = o.gap + reach;
    // centred on the anchor first, then shifted along the side (a little cost per step) if that clears something
    for (const shift of [0, -0.5, 0.5, -1, 1]) {
      const along = (across ? h : w) / 2 * shift;
      const x = across ? (side === "right" ? ax + gap : ax - gap - w) : slide(ax - w / 2 + along, w, ax, bounds[0], bounds[2]);
      const y = across ? slide(ay - h / 2 + along, h, ay, bounds[1], bounds[3]) : side === "bottom" ? ay + gap : ay - gap - h;
      const b: Box = [x, y, x + w, y + h];
      const hard = (o.hard ?? []).reduce((a, q) => a + overlapArea(b, q), 0);
      let score = (w * h - overlapArea(b, bounds)) * 1000 + hard * 100 + rank * 40 + Math.abs(shift) * 60 + reach * 25 - (side === o.prev ? 600 : 0);
      for (const q of o.soft ?? []) score += overlapArea(b, q.box) * (q.weight ?? 1);
      if (score < bestScore) {
        bestScore = score;
        bestHard = hard;
        best = { side, x, y, tip: across ? ay - y : ax - x, reach };
      }
    }
  });
  tryAt(0);
  if (bestHard > 0) for (const r of o.reach ?? []) tryAt(r);
  return best;
}

/** Street tiles touching the current view (tile keys are "col_row" in map units; `pad` covers lines that cross a tile edge). */
export function visibleTiles(view: { k: number; x: number; y: number }, w: number, h: number, size: number, available: Set<string>, pad = 20): string[] {
  const x0 = (-view.x) / view.k - pad, x1 = (w - view.x) / view.k + pad;
  const y0 = (-view.y) / view.k - pad, y1 = (h - view.y) / view.k + pad;
  const out: string[] = [];
  for (let c = Math.floor(x0 / size); c <= Math.floor(x1 / size); c++) {
    for (let r = Math.floor(y0 / size); r <= Math.floor(y1 / size); r++) {
      const key = `${c}_${r}`;
      if (available.has(key)) out.push(key);
    }
  }
  return out;
}
