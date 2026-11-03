import { MapProvider } from "@/components/map/MapContext";
import { SubwayMap } from "@/components/map/SubwayMap";

// Explore, Plan and Saved share one persistent map (it keeps its pan/zoom across pages).
// Desktop: map canvas + right rail. Mobile: map on top, rail below, labelled tab bar at the bottom.
export default function ExploreLayout({ children }: LayoutProps<"/">) {
  return (
    <MapProvider>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <section aria-label="Subway map" className="h-[33vh] min-h-52 flex-none border-b border-rule md:h-auto md:flex-1 md:border-b-0">
          <SubwayMap />
        </section>
        <aside className="min-h-0 flex-1 overflow-y-auto bg-bg pb-24 md:w-[440px] md:flex-none md:border-l md:border-rule md:pb-6">
          {children}
        </aside>
      </div>
    </MapProvider>
  );
}
