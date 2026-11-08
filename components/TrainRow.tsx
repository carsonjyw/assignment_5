"use client";

import { useState } from "react";
import { clockTime, formatEta, trainStatusText, type Route, type Train } from "@/lib/headway/core";
import { RouteMark } from "./RouteMark";

// One compact arrival on a light panel: mark · destination · LIVE/SCHEDULED in words · countdown.
export function TrainRow({ train, route, nowMs }: { train: Train; route?: Route; nowMs: number }) {
  // Highlight once when MTA revises this train's time by ≥30 s (React "previous render" pattern)
  const [seen, setSeen] = useState({ eta: train.eta, flashes: 0 });
  if (seen.eta !== train.eta) {
    setSeen({ eta: train.eta, flashes: Math.abs(train.eta - seen.eta) >= 30 ? seen.flashes + 1 : seen.flashes });
  }
  const status = trainStatusText(train);
  const live = status === "Live";
  const label = formatEta(train.eta, nowMs);
  const now = label === "Arriving";
  const hours = !now && label.split(" min")[0].includes("h");
  return (
    <li key={seen.flashes} title={`${status} · ${clockTime(train.eta)}`} className={`enter -mx-1.5 flex min-h-10 items-center gap-2.5 rounded-md border-t border-panel-rule px-1.5 py-1 first:border-t-0 ${seen.flashes ? "flash" : ""}`}>
      <RouteMark route={route} routeId={train.route_id} size="sm" muted={!live} />
      <p className="min-w-0 flex-1 truncate text-[14px] font-semibold leading-tight text-panel-text">{train.headsign ?? "Destination not given"}</p>
      <span className={`label-caps flex-none !text-[10px] ${live ? "text-live" : train.carried ? "text-warn" : "text-panel-muted"}`}>{status}</span>
      <p className="tabular min-w-[3.6rem] flex-none text-right leading-none text-panel-text"
        aria-label={`${route?.short_name ?? train.route_id} train to ${train.headsign ?? "unknown destination"}: ${label}, ${status}, ${clockTime(train.eta)}`}>
        {now ? (
          <span className={`inline-block rounded-md px-2 py-1 text-[14px] font-extrabold ${live ? "bg-[#d9f2e3] text-[#0b5a31]" : "bg-[var(--panel-rule)] text-panel-text"}`}>Now</span>
        ) : hours ? (
          <span className="text-[15px] font-bold">{label}</span>
        ) : (
          <><span className={`text-[20px] ${live ? "font-extrabold" : "font-medium"}`}>{label.replace(" min", "")}</span><span className="ml-0.5 text-xs font-semibold">min</span></>
        )}
      </p>
    </li>
  );
}
