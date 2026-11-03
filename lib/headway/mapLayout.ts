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
}
export interface PlacedLabel { key: string; text: string; x: number; y: number; dx: number; dy: number; anchor: "start" | "end" | "middle"; c: LabelCandidate }

type Box = [number, number, number, number];
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
    const w = textWidth(c.text, c.fs, c.caps), h = c.fs * 1.25;
    const options: [number, number, "start" | "end" | "middle", Box][] = [];
    if (c.fixed || c.rotate) {
      const rad = ((c.rotate ?? 0) * Math.PI) / 180;
      const bw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
      const bh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
      options.push([0, c.fs * 0.35, "middle", [sx - bw / 2, sy - bh / 2, sx + bw / 2, sy + bh / 2]]);
    } else {
      const p = c.pad;
      options.push(
        [p, c.fs * 0.35, "start", [sx + p - 1, sy - h / 2, sx + p + w, sy + h / 2]],
        [-p, c.fs * 0.35, "end", [sx - p - w, sy - h / 2, sx - p + 1, sy + h / 2]],
        [0, -p - c.fs * 0.3, "middle", [sx - w / 2, sy - p - h, sx + w / 2, sy - p]],
        [0, p + c.fs * 0.95, "middle", [sx - w / 2, sy + p, sx + w / 2, sy + p + h]],
      );
    }
    const ok = options.find((o) => !boxes.some((b) => hit(b, o[3])));
    if (!ok) continue;
    boxes.push(ok[3]);
    placed.push({ key: c.key, text: c.text, x: c.x, y: c.y, dx: ok[0], dy: ok[1], anchor: ok[2], c });
    if (c.dedupe) byText.set(c.text, [...(byText.get(c.text) ?? []), [sx, sy]]);
  }
  return placed;
}

/** Zoom bucket: layers that depend on zoom are rebuilt only when k crosses a step of ×1.2. */
export const zoomBucket = (k: number) => Math.pow(1.2, Math.round(Math.log(k) / Math.log(1.2)));

/** Line width in screen px: thin when zoomed out, fuller when zoomed in. */
export const lineWidth = (k: number) => Math.min(6, Math.max(2, 2.1 * Math.pow(k, 0.42)));
