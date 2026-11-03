import type { Metadata } from "next";
import { Suspense } from "react";
import { LinePanel } from "@/components/panels";
import { Skeleton } from "@/components/StationView";

export const metadata: Metadata = { title: "Line · HEADWAY" };

export default function LinePage({ params }: PageProps<"/line/[route]">) {
  return (
    <Suspense fallback={<div className="p-3"><Skeleton rows={5} /></div>}>
      {params.then(({ route }) => <LinePanel key={route} routeId={decodeURIComponent(route)} />)}
    </Suspense>
  );
}
