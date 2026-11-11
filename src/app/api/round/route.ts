import type { NextRequest } from "next/server";
import { roundSummary } from "@/lib/game";
import { respond } from "@/lib/http";

/** Public state of a round: pool, clock, leaderboard. Defaults to today's. */
export async function GET(request: NextRequest) {
  const roundId = request.nextUrl.searchParams.get("round") ?? undefined;
  return respond(() => roundSummary(roundId));
}
