import type { NextRequest } from "next/server";
import { respond } from "@/lib/http";
import { TRAINING_COOKIE, requireCohort, trainingSummary } from "@/lib/training";

/** The training room's dashboard. Signed-in trainers only. */
export async function GET(request: NextRequest) {
  return respond(async () => trainingSummary(requireCohort(request.cookies.get(TRAINING_COOKIE)?.value, undefined, "")));
}
