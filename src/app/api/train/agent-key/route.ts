import type { NextRequest } from "next/server";
import { setAgentKeyDisabled } from "@/lib/agents";
import { GameError } from "@/lib/game";
import { readJsonBody, respond } from "@/lib/http";
import { TRAINING_COOKIE, requireCohort } from "@/lib/training";

/** Switch a builder's agent key off or back on. The owner only. */
export async function POST(request: NextRequest) {
  return respond(async () => {
    const cohort = requireCohort(request.cookies.get(TRAINING_COOKIE)?.value, undefined, "");
    if (!cohort.owner) throw new GameError(403, "owner_only", "Only the owner can manage agent keys");
    const body = await readJsonBody(request);
    await setAgentKeyDisabled(body.id, body.disabled);
    return { ok: true };
  });
}
