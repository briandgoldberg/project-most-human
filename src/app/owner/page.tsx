import type { Metadata } from "next";
import { OwnerRoom } from "@/components/OwnerRoom";

export const metadata: Metadata = {
  title: "Owner · Spot the Bot",
  robots: { index: false, follow: false },
};

export default function Owner() {
  return <OwnerRoom />;
}
