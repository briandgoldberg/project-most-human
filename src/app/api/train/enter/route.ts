import type { NextRequest } from "next/server";
import { enterTraining } from "@/lib/game";
import { clientAddress, readJsonBody, respond } from "@/lib/http";
import { TRAINING_COOKIE, requireCohort } from "@/lib/training";

/**
 * Start a labelled training session. Trainers arrive signed in; the house bots
 * have no browser and present the password with the request instead.
 */
export async function POST(request: NextRequest) {
  return respond(async () => {
    const body = await readJsonBody(request);
    const cohort = requireCohort(request.cookies.get(TRAINING_COOKIE)?.value, body.password, clientAddress(request));
    return enterTraining({
      cohort,
      handle: body.handle,
      declaredKind: body.declaredKind,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
  });
}
