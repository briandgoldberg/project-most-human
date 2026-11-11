import type { Metadata } from "next";
import { TrainingRoom } from "@/components/TrainingRoom";

export const metadata: Metadata = {
  title: "Training room · Most Human",
  robots: { index: false, follow: false },
};

export default function Train() {
  return <TrainingRoom />;
}
