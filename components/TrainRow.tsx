"use client";

import { useState } from "react";
import { clockTime, formatEta, trainStatusText, type Route, type Train } from "@/lib/headway/core";
import { RouteMark } from "./RouteMark";

// One arrival on a light panel: mark · destination · LIVE/SCHEDULED in words · big countdown numeral.
export function TrainRow({ train, route, nowMs }: { train: Train; route?: Route; nowMs: number }) {
  // Highlight once when MTA revises this train's time by ≥30 s (React "previous render" pattern)
  const [seen, setSeen] = useState({ eta: train.eta, flashes: 0 });
  if (seen.eta !== train.eta) {
    setSeen({ eta: train.eta, flashes: Math.abs(train.eta - seen.eta) >= 30 ? seen.flashes + 1 : seen.flashes });
  }
  const status = trainStatusText(train);
  const live = status === "Live";
  const label = formatEta(train.eta, nowMs);
  const [num, unit] = label === "Arriving" ? ["Now", ""] : label.split(" min")[0].includes("h") ? [label, ""] : [label.replace(" min", ""), "min"];
  return (
    <li key={seen.flashes} className={`enter -mx-1.5 flex items-center gap-3 rounded-md border-t border-panel-rule px-1.5 py-2 first:border-t-0 ${seen.flashes ? "flash" : ""}`}>
      <RouteMark route={route} routeId={train.route_id} size="lg" muted={!live} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-bold leading-tight text-panel-text">{train.headsign ?? "Destination not given"}</p>
        <p className={`label-caps mt-0.5 ${live ? "text-live" : train.carried ? "text-warn" : "text-panel-muted"}`}>
          {status} <span className="font-semibold normal-case tracking-normal text-panel-muted">· {clockTime(train.eta)}</span>
        </p>
      </div>
      <p className={`tabular min-w-[4.5rem] text-right leading-none text-panel-text ${live ? "text-[30px] font-black" : "text-[26px] font-medium"}`}
        aria-label={`${route?.short_name ?? train.route_id} train to ${train.headsign ?? "unknown destination"}: ${label}, ${status}`}>
        {num}{unit && <span className="ml-0.5 text-sm font-bold">{unit}</span>}
      </p>
    </li>
  );
}
