import type { Metadata } from "next";
import { Suspense } from "react";
import { PlanPanel } from "@/components/PlanPanel";

export const metadata: Metadata = { title: "Plan · HEADWAY" };

const num = (v: string | string[] | undefined) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);

export default function PlanPage({ searchParams }: PageProps<"/plan">) {
  return (
    <Suspense fallback={<p className="p-5 text-muted">Loading…</p>}>
      {searchParams.then((sp) => <PlanPanel initialFrom={num(sp.from)} initialTo={num(sp.to)} />)}
    </Suspense>
  );
}
