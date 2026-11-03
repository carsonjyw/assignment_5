"use client";

// Explore · Plan · Saved. Top tabs on desktop, a labelled bottom bar on mobile. No hamburger, no gestures.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";

const TABS = [
  { href: "/", label: "Explore", match: (p: string) => p === "/" || p.startsWith("/station") || p.startsWith("/line") },
  { href: "/plan", label: "Plan", match: (p: string) => p.startsWith("/plan") },
  { href: "/saved", label: "Saved", match: (p: string) => p.startsWith("/saved") },
];

// The pathname is request data, so the active tab streams in; the fallback is the same bar, unhighlighted
export const TopTabs = () => <Suspense fallback={<TopBar path="" />}><WithPath bar={TopBar} /></Suspense>;
export const BottomTabs = () => <Suspense fallback={<BottomBar path="" />}><WithPath bar={BottomBar} /></Suspense>;

function WithPath({ bar: Bar }: { bar: (p: { path: string }) => React.ReactNode }) {
  return <Bar path={usePathname()} />;
}

function TopBar({ path }: { path: string }) {
  return (
    <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
      {TABS.map((t) => {
        const on = t.match(path);
        return (
          <Link key={t.href} href={t.href} aria-current={on ? "page" : undefined}
            className={`press rounded-full px-4 py-2 text-[15px] font-bold ${on ? "bg-sign-text text-sign" : "text-sign-muted hover:text-sign-text"}`}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

function BottomBar({ path }: { path: string }) {
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-20 flex border-t border-white/15 bg-sign pb-[env(safe-area-inset-bottom)] md:hidden">
      {TABS.map((t) => {
        const on = t.match(path);
        return (
          <Link key={t.href} href={t.href} aria-current={on ? "page" : undefined}
            className={`press flex-1 py-3.5 text-center text-[15px] font-extrabold ${on ? "text-sign-text shadow-[inset_0_3px_0_#fff]" : "text-sign-muted"}`}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
