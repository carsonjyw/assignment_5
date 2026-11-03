"use client";

// Appearance: Auto (follow the device) → Light → Dark. The choice is a per-browser convenience in
// localStorage; app/layout.tsx applies it before first paint so there's no flash of the wrong theme.
import { useSyncExternalStore } from "react";
import { THEME_KEY } from "@/lib/theme";

type Theme = "auto" | "light" | "dark";
const NEXT: Record<Theme, Theme> = { auto: "light", light: "dark", dark: "auto" };
const NAME: Record<Theme, string> = { auto: "Auto", light: "Light", dark: "Dark" };

const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const read = (): Theme => {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "auto";
};

function apply(t: Theme) {
  const root = document.documentElement;
  if (t === "auto") delete root.dataset.theme;
  else root.dataset.theme = t;
  try {
    if (t === "auto") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch {
    // private mode / blocked storage: the choice still applies for this visit
  }
  listeners.forEach((l) => l());
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, read, () => "auto" as Theme);
  const next = NEXT[theme];
  return (
    <button
      type="button"
      onClick={() => apply(next)}
      aria-label={`Appearance: ${NAME[theme]}${theme === "auto" ? " (matches your device)" : ""}. Switch to ${NAME[next]}`}
      title={`Appearance: ${NAME[theme]} · click for ${NAME[next]}`}
      className="press inline-flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-full border border-sign-text/30 px-2.5 text-sm font-bold text-sign-text hover:border-sign-text"
    >
      <Icon theme={theme} />
      <span className="hidden lg:inline">{NAME[theme]}</span>
    </button>
  );
}

function Icon({ theme }: { theme: Theme }) {
  const common = { width: 18, height: 18, viewBox: "0 0 18 18", "aria-hidden": true } as const;
  if (theme === "light") {
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <circle cx="9" cy="9" r="3.4" />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
          const r = (a * Math.PI) / 180;
          return <line key={a} x1={9 + Math.cos(r) * 5.6} y1={9 + Math.sin(r) * 5.6} x2={9 + Math.cos(r) * 7.6} y2={9 + Math.sin(r) * 7.6} />;
        })}
      </svg>
    );
  }
  if (theme === "dark") {
    return (
      <svg {...common} fill="currentColor">
        <path d="M11.8 2.2a6.9 6.9 0 1 0 4 10.6A6 6 0 0 1 11.8 2.2Z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="9" cy="9" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 2.4a6.6 6.6 0 0 1 0 13.2Z" fill="currentColor" />
    </svg>
  );
}
