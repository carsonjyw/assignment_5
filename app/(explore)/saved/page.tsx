import type { Metadata } from "next";
import { SavedPanel } from "@/components/panels";

export const metadata: Metadata = { title: "Saved · HEADWAY" };

export default function SavedPage() {
  return <SavedPanel />;
}
