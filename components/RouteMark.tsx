import type { Route } from "@/lib/headway/core";

// HEADWAY's own route mark: a rounded square in the line's colour with our typeface (not MTA bullet
// artwork). The letter's ink is whichever of black/white has the higher WCAG contrast on that colour,
// so every mark is legible (e.g. the grey L and orange B D F M get black ink).

function luminance(hex: string) {
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function inkFor(hex: string): "#000000" | "#ffffff" {
  const L = luminance(hex);
  return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? "#000000" : "#ffffff";
}

const SIZES = { xs: "h-5 min-w-5 text-[11px] rounded-[5px]", sm: "h-6 min-w-6 text-[13px] rounded-[6px]", md: "h-8 min-w-8 text-base rounded-[8px]", lg: "h-10 min-w-10 text-xl rounded-[10px]" };

export function RouteMark({ route, routeId, size = "md", muted = false }: {
  route?: Route; routeId: string; size?: keyof typeof SIZES; muted?: boolean;
}) {
  const color = route?.color ?? "808183";
  const label = route?.short_name ?? routeId;
  const express = /^[0-9A-Z]X$/.test(routeId);
  const shown = express ? routeId[0] : label === "SIR" ? "SIR" : label;
  return (
    <span
      role="img"
      aria-label={`${label}${express ? " express" : ""}${label === "S" ? " shuttle" : ""} train`}
      title={route?.long_name}
      className={`inline-flex flex-none items-center justify-center px-1 font-extrabold leading-none ${SIZES[size]} ${muted ? "opacity-100" : ""}`}
      style={{
        background: muted ? "transparent" : `#${color}`,
        color: muted ? "var(--panel-text)" : inkFor(color),
        boxShadow: muted ? `inset 0 0 0 2px #${color}` : express ? "inset 0 0 0 2px rgba(255,255,255,.95), inset 0 0 0 3px rgba(0,0,0,.35)" : undefined,
        fontSize: shown.length > 2 ? "0.62em" : undefined,
      }}
    >
      {shown}
    </span>
  );
}
