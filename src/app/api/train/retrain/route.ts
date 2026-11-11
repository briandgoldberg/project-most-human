import type { NextRequest } from "next/server";
import { respond } from "@/lib/http";
import { TRAINING_COOKIE, requireCohort, retrain } from "@/lib/training";

/** Refit the behaviour model on all labelled sessions. Signed-in trainers only. */
export async function POST(request: NextRequest) {
  return respond(async () => {
    requireCohort(request.cookies.get(TRAINING_COOKIE)?.value, undefined, "");
    return retrain();
  });
}
