import type { NextRequest } from "next/server";
import { personFor } from "@/lib/game";
import { readJsonBody, respond } from "@/lib/http";
import { OWNER_COOKIE, nextSeedQuestion, requireOwner, saveSeedAnswer } from "@/lib/owner";
import { currentPlayer, ensureDeviceId } from "@/lib/session";

/** The training area: the next question to answer. */
export async function GET(request: NextRequest) {
  return respond(async () => {
    requireOwner(request.cookies.get(OWNER_COOKIE)?.value);
    return nextSeedQuestion();
  });
}

/** The training area: save one typed answer as a real person's, and hand back the next question. */
export async function POST(request: NextRequest) {
  return respond(async () => {
    requireOwner(request.cookies.get(OWNER_COOKIE)?.value);
    const body = await readJsonBody(request);
    // Whoever is training is remembered the way a player is, so they are never shown their own answers in a game.
    const person = personFor((await currentPlayer())?.id, await ensureDeviceId());
    return saveSeedAnswer({ prompt: body.prompt, category: body.category, depth: body.depth, text: body.text, telemetry: body.telemetry, person });
  });
}

// When the bank runs out, the next question is written by the model.
export const maxDuration = 60;
