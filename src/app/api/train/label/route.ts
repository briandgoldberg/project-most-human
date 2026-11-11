import type { NextRequest } from "next/server";
import { GameError, labelCompetitor } from "@/lib/game";
import { readJsonBody, respond } from "@/lib/http";
import { TRAINING_COOKIE, requireCohort } from "@/lib/training";

/** Record what a player on the public board really was. The owner only. */
export async function POST(request: NextRequest) {
  return respond(async () => {
    const cohort = requireCohort(request.cookies.get(TRAINING_COOKIE)?.value, undefined, "");
    if (!cohort.owner) throw new GameError(403, "owner_only", "Only the owner can label players on the board");
    const body = await readJsonBody(request);
    return labelCompetitor({ roundId: body.roundId, entryId: body.entryId, label: body.label, cohort });
  });
}
