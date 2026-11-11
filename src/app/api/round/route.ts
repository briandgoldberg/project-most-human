import { humanSummary } from "@/lib/game";
import { respond } from "@/lib/http";

/** The human side at a glance: the prize, how the game is laid out, and recent hunters. */
export async function GET() {
  return respond(() => humanSummary());
}
