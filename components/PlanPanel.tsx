"use client";

// Plan: origin → destination over MTA's schedule graph, transfers from transfers.txt, journey drawn on
// the map, and live next departures from HEADWAY's boards. Scheduled estimates are always labelled.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useLive } from "@/app/providers";
import { directionHeading, formatEta, isUpcoming, trainStatusText } from "@/lib/headway/core";
import { bandFor, minutes, planOptions, type Journey, type Leg, type PlanData } from "@/lib/headway/planner";
import { useStations } from "@/lib/headway/useStations";
import { useMap } from "./map/MapContext";
import { RouteMark } from "./RouteMark";
import { StationSearch } from "./StationSearch";

let planPromise: Promise<PlanData> | null = null;
const loadPlan = () => (planPromise ??= fetch("/data/plan.json").then((r) => {
  if (!r.ok) throw new Error("timetable unavailable");
  return r.json();
}));

export function PlanPanel({ initialFrom, initialTo }: { initialFrom: number | null; initialTo: number | null }) {
  const router = useRouter();
  const { nowMs } = useLive();
  const { stationsById, setJourney, setFocus, setPick } = useMap();
  const [from, setFrom] = useState<number | null>(initialFrom);
  const [to, setTo] = useState<number | null>(initialTo);
  const [picking, setPicking] = useState<"from" | "to" | null>(null);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [planError, setPlanError] = useState(false);
  const [choice, setChoice] = useState(0);

  useEffect(() => {
    loadPlan().then(setPlan).catch(() => setPlanError(true));
  }, []);

  // Keep the URL shareable: /plan?from=153&to=602
  useEffect(() => {
    const q = new URLSearchParams();
    if (from) q.set("from", String(from));
    if (to) q.set("to", String(to));
    router.replace(`/plan${q.size ? `?${q}` : ""}`, { scroll: false });
  }, [from, to, router]);

  // Map "pick a station" mode
  useEffect(() => {
    if (!picking) {
      setPick(null);
      return;
    }
    setPick((id: number) => {
      if (picking === "from") setFrom(id);
      else setTo(id);
      setPicking(null);
    });
    return () => setPick(null);
  }, [picking, setPick]);

  // Re-evaluate the service period every 10 minutes, not every clock tick
  const tenMin = nowMs > 0 ? Math.floor(nowMs / 600_000) : 0;
  const band = useMemo(() => (plan && tenMin ? bandFor(new Date(tenMin * 600_000), plan) : null), [plan, tenMin]);
  const options = useMemo(() => (plan && band && from && to ? planOptions(plan, band.key, from, to) : []), [plan, band, from, to]);
  const journey: Journey | null = options[Math.min(choice, options.length - 1)] ?? null;

  useEffect(() => {
    setJourney(journey);
    setFocus(null);
    return () => setJourney(null);
  }, [journey, setJourney, setFocus]);

  const name = (id: number | null) => (id != null ? stationsById.get(id)?.name ?? `Station ${id}` : null);

  return (
    <div>
      <div className="sign-band px-4 pb-4 pt-4 md:px-5 md:pb-5">
        <h1 className="sign-type text-[24px] leading-tight md:text-[28px]">Plan a trip</h1>
        <div className="relative mt-3 space-y-2">
          <End label="From" value={name(from)} onClear={() => setFrom(null)} picking={picking === "from"} onPickMap={() => setPicking(picking === "from" ? null : "from")}
            onPick={(h) => setFrom(h.station_id)} />
          <End label="To" value={name(to)} onClear={() => setTo(null)} picking={picking === "to"} onPickMap={() => setPicking(picking === "to" ? null : "to")}
            onPick={(h) => setTo(h.station_id)} />
          {from && to && (
            // sits on the seam between the two fields, so swapping costs no extra row
            <button type="button" aria-label="Swap origin and destination" title="Swap" onClick={() => { setFrom(to); setTo(from); setChoice(0); }}
              className="press absolute right-[5.5rem] top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full border-2 border-sign bg-sign-text text-base font-black text-sign shadow hover:bg-[#e8e8e6]">⇅</button>
          )}
        </div>
      </div>

      <div className="p-4">
        {planError && <p role="alert" className="mb-3 rounded-xl border-2 border-down bg-down-bg p-4 font-semibold text-down">The timetable couldn&apos;t load. Check your connection and try again.</p>}
        {!from || !to ? (
          <p className="text-muted">Choose where you&apos;re starting and where you&apos;re going. You can search or tap stations on the map.</p>
        ) : from === to ? (
          <p className="font-semibold">Origin and destination are the same station.</p>
        ) : !plan || !band ? (
          <p className="text-muted">Loading the timetable…</p>
        ) : !journey ? (
          <div className="rounded-xl border-2 border-warn bg-warn-bg p-4 text-warn">
            <p className="font-extrabold">No scheduled subway route found for {band.label}.</p>
            <p className="mt-1 text-sm font-medium">Some lines don&apos;t run at this time, or these stations aren&apos;t connected by subway (for example, Staten Island needs the ferry). We don&apos;t guess a route.</p>
          </div>
        ) : (
          <JourneyView journey={journey} band={band.label} options={options} choice={choice} onChoose={setChoice} feedVersion={plan.feed_version ?? null} />
        )}
      </div>
    </div>
  );
}

function End({ label, value, onClear, onPick, picking, onPickMap }: {
  label: string; value: string | null; onClear: () => void; onPick: (h: { station_id: number }) => void; picking: boolean; onPickMap: () => void;
}) {
  if (value) {
    return (
      <div className="flex min-h-14 items-center gap-3 rounded-xl bg-sign-text py-1.5 pl-4 pr-2 text-sign">
        <span className="label-caps w-9 flex-none text-[#4a4d52]">{label}</span>
        <span className="sign-type min-w-0 flex-1 text-[16px] leading-snug md:text-[17px]">{value}</span>
        <button type="button" onClick={onClear} className="press min-h-11 flex-none rounded-full px-3 text-sm font-bold underline underline-offset-4">Change</button>
      </div>
    );
  }
  return (
    <div className="rounded-xl bg-sign-text p-3 text-sign [&_label]:text-[#4a4d52]">
      <StationSearch label={label} placeholder="Search a station" onPick={onPick} />
      <button type="button" onClick={onPickMap} aria-pressed={picking}
        className={`press mt-2 min-h-11 rounded-full border-2 px-4 text-sm font-bold ${picking ? "border-sign bg-sign text-sign-text" : "border-[#0d0e10]"}`}>
        {picking ? "Tap a station on the map… (cancel)" : "Pick on the map"}
      </button>
    </div>
  );
}

function JourneyView({ journey, band, options, choice, onChoose, feedVersion }: {
  journey: Journey; band: string; options: Journey[]; choice: number; onChoose: (i: number) => void; feedVersion: string | null;
}) {
  const { stationsById } = useMap();
  const name = (id: number) => stationsById.get(id)?.name ?? `Station ${id}`;
  // Live boards for every station where the rider boards a train
  const boardIds = useMemo(() => [...new Set(journey.legs.map((l) => l.boardStation))], [journey]);
  const live = useStations(boardIds);

  return (
    <div className="enter">
      {options.length > 1 && (
        <div className="mb-3 flex gap-2" role="radiogroup" aria-label="Route options">
          {options.map((o, i) => (
            <button key={i} type="button" role="radio" aria-checked={i === choice} onClick={() => onChoose(i)}
              className={`press min-h-11 flex-1 rounded-xl border-2 px-3 text-left text-sm font-bold ${i === choice ? "border-text bg-text text-bg" : "border-rule"}`}>
              {i === 0 ? "Fastest" : "Fewer transfers"} · {minutes(o.totalS)} min
            </button>
          ))}
        </div>
      )}
      <div className="rounded-xl bg-sign px-4 py-3 text-sign-text">
        <p className="sign-type text-[28px] leading-none">About {minutes(journey.totalS)} min</p>
        <p className="label-caps mt-1.5 text-sign-muted">By schedule · {band} timetable</p>
        <p className="mt-1 text-sm text-sign-muted">
          {journey.legs.length === 1 ? "One train, no transfers" : `${journey.transfers.length} transfer${journey.transfers.length > 1 ? "s" : ""}`} ·
          includes about {minutes(journey.firstWaitS + journey.transfers.reduce((n, t) => n + t.waitS, 0))} min of average waiting
        </p>
      </div>

      <ol className="mt-3 space-y-2">
        {journey.legs.map((leg, i) => (
          <li key={i} className="space-y-2">
            {i > 0 && <TransferStep t={journey.transfers[i - 1]} name={name} next={leg} />}
            <LegCard leg={leg} name={name} boards={live.boards} platforms={live.platforms} />
          </li>
        ))}
        <li className="flex items-center gap-3 rounded-xl border-2 border-text px-4 py-3">
          <span aria-hidden="true" className="text-xl">◉</span>
          <span><span className="label-caps block text-muted">Arrive</span><span className="font-extrabold">{name(journey.legs.at(-1)!.alightStation)}</span></span>
        </li>
      </ol>

      <p className="mt-4 text-xs leading-relaxed text-muted">
        Travel times are scheduled estimates from MTA&apos;s timetable ({band}{feedVersion ? `, ${feedVersion.slice(0, 8)}` : ""}), using median run times between stops and half the scheduled time between trains as waiting.
        They don&apos;t include live delays, planned weekend or night service changes, or holiday schedules. Times marked <b>Live</b> come from MTA&apos;s real-time feeds.
      </p>
    </div>
  );
}

function LegCard({ leg, name, boards, platforms }: {
  leg: Leg; name: (id: number) => string; boards: Record<string, import("@/lib/headway/core").Train[]>; platforms: import("@/lib/headway/core").Platform[];
}) {
  const { routes, nowMs } = useLive();
  const [open, setOpen] = useState(false);
  const r = routes[leg.route];
  const plat = platforms.find((p) => p.stop_id === leg.boardPlatform);
  const next = (boards[leg.boardPlatform] ?? []).filter((t) => t.route_id === leg.route && isUpcoming(t, nowMs)).sort((a, b) => a.eta - b.eta).slice(0, 3);
  const heading = plat ? directionHeading(plat.direction_label, next) : leg.direction === "N" ? "Northbound" : "Southbound";
  return (
    <div className="rounded-xl bg-panel px-4 py-3 text-panel-text" style={{ boxShadow: `inset 6px 0 0 #${r?.color ?? "808183"}` }}>
      <div className="flex items-start gap-3 pl-1">
        <RouteMark route={r} routeId={leg.route} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="font-extrabold leading-tight">
            {r?.short_name === "S" ? r.long_name : `${r?.short_name ?? leg.route} train`} toward {leg.headsign ?? "the end of the line"}
          </p>
          <p className="text-sm font-semibold text-panel-muted">{heading} · board at {name(leg.boardStation)}</p>
          <p className="mt-1 text-sm">
            Ride <b>{leg.stations.length - 1} stop{leg.stations.length > 2 ? "s" : ""}</b> to <b>{name(leg.alightStation)}</b> · about {minutes(leg.rideS)} min by schedule
          </p>
          <p className="mt-1.5 text-sm">
            {next.length ? (
              <><span className={`label-caps ${next[0].live ? "text-live" : "text-panel-muted"}`}>{trainStatusText(next[0])}</span>{" "}
                <b>Next {r?.short_name ?? leg.route}: {formatEta(next[0].eta, nowMs)}</b>
                {next.length > 1 && <span className="text-panel-muted">, then {next.slice(1).map((t) => formatEta(t.eta, nowMs).replace(" min", "")).join(", ")} min</span>}</>
            ) : (
              <span className="text-panel-muted">No live {r?.short_name ?? leg.route} departures listed here right now. Trains run about every {minutes(leg.headwayS)} min by schedule.</span>
            )}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-3 text-sm font-bold">
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="press min-h-11 underline underline-offset-4">
              {open ? "Hide stops" : `Show ${leg.stations.length} stops`}
            </button>
            <Link href={`/station/${leg.boardStation}`} className="press inline-flex min-h-11 items-center underline underline-offset-4">Live board</Link>
          </div>
          {open && (
            <ol className="enter mb-1 border-l-4 pl-3" style={{ borderColor: `#${r?.color ?? "808183"}` }}>
              {leg.stations.map((id) => <li key={id} className="py-0.5 text-sm">{name(id)}</li>)}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

function TransferStep({ t, name, next }: { t: Journey["transfers"][number]; name: (id: number) => string; next: Leg }) {
  const { routes } = useLive();
  const r = routes[next.route];
  return (
    <div className="flex items-center gap-3 rounded-xl border-2 border-dashed border-rule px-4 py-2.5">
      <span aria-hidden="true" className="text-xl font-black">⇄</span>
      <p className="text-sm">
        <b>Transfer at {name(t.atStation)}</b>
        {t.toStation !== t.atStation ? <> · walk to {name(t.toStation)}</> : null} to the {r?.short_name ?? next.route}.{" "}
        <span className="text-muted">{t.walkS > 0 ? `MTA allows about ${minutes(t.walkS)} min to change platforms.` : "Same platform."}</span>
      </p>
    </div>
  );
}
