"use client";

// Rider-facing freshness: one badge in the header for the whole system, and the "Reconnecting…" bar.
// Every state has an icon and words; colour only reinforces.
import { useLive } from "@/app/providers";
import { agoText, computeFreshness, freshnessText, type Freshness } from "@/lib/headway/core";

export function useFreshness(loaded: boolean, neededFeeds: string[]): Freshness {
  const { status, nowMs, realtimeHealthy } = useLive();
  // No clock yet (first render) counts as loading, so no wrong countdown is ever shown
  return computeFreshness({ loaded: loaded && nowMs > 0, status, neededFeeds, nowMs, realtimeHealthy });
}

const STYLE: Record<Freshness["kind"], { cls: string; icon: string }> = {
  loading: { cls: "text-panel-muted", icon: "○" },
  fresh: { cls: "text-live", icon: "●" },
  partial: { cls: "text-warn", icon: "▲" },
  stale: { cls: "text-warn", icon: "◷" },
  down: { cls: "text-down", icon: "■" },
};

// What screen readers announce: only when the state changes, never every countdown second
const ANNOUNCE: Record<Freshness["kind"], string> = {
  loading: "Loading live times",
  fresh: "Live times",
  partial: "Some lines have delayed data",
  stale: "Times may be out of date",
  down: "Live times unavailable",
};

/**
 * The one system freshness indicator (header, every screen size). Per-station boards don't repeat it;
 * they only add a specific warning when a line's own feed is delayed or unavailable.
 */
export function LiveBadge() {
  const f = useFreshness(true, []);
  const s = STYLE[f.kind];
  const label =
    f.kind === "loading" ? "Connecting…" :
    f.kind === "fresh" || f.kind === "partial" ? `Live · ${agoText(f.updatedAgoS ?? 0)}` :
    f.kind === "stale" ? (f.updatedAgoS === null ? "Waiting for data" : `Delayed · ${agoText(f.updatedAgoS)}`) :
    "Offline";
  const tone = f.kind === "fresh" || f.kind === "partial" ? "text-sign-muted" : f.kind === "down" ? "text-[#ff9b93]" : f.kind === "loading" ? "text-sign-muted" : "text-[#ffd166]";
  return (
    // fixed minimum width: the label changes length every second without moving the header
    <span className={`flex min-w-[7.6rem] items-center justify-end gap-1.5 text-[13px] font-semibold tabular sm:text-sm ${tone}`}
      title={f.kind === "fresh" ? "MTA real-time data, checked every 15 seconds" : freshnessText(f)}>
      {f.kind === "fresh" || f.kind === "partial"
        ? <i aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-[#3ddc84] breathe" />
        : <span aria-hidden="true">{s.icon}</span>}
      <span aria-hidden="true">{label}</span>
      <span className="sr-only" aria-live="polite">{ANNOUNCE[f.kind]}</span>
    </span>
  );
}

export function ConnectionBar() {
  const { realtimeHealthy, status, visible } = useLive();
  // Before the first heartbeat arrives the page shows Loading instead; while hidden nothing is shown
  if (realtimeHealthy || !status || !visible) return null;
  return (
    <div role="status" data-testid="reconnecting" className="border-t border-white/15 bg-[#1b1d21] px-4 py-1.5 text-center text-sm font-semibold text-sign-text">
      Reconnecting… times update again as soon as the connection is back.
    </div>
  );
}
