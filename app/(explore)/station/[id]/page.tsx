import type { Metadata } from "next";
import { Suspense } from "react";
import { Skeleton, StationView } from "@/components/StationView";

export const metadata: Metadata = { title: "Station · HEADWAY" };

// params are runtime data (445 stations aren't prerendered), so they resolve inside Suspense
export default function StationPage({ params, searchParams }: PageProps<"/station/[id]">) {
  return (
    <Suspense fallback={<div className="p-3"><Skeleton /></div>}>
      {Promise.all([params, searchParams]).then(([{ id }, sp]) => (
        <StationView key={id} stationId={Number(id)} initialRoute={typeof sp.line === "string" ? sp.line : null} />
      ))}
    </Suspense>
  );
}
