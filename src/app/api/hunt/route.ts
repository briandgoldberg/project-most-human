import { after } from "next/server";
import { pickHunt } from "@/lib/game";
import { readJsonBody, respond } from "@/lib/http";
import { retrainIfDue } from "@/lib/owner";

/** Pick which of a hunting round's two answers the person wrote, and say why. Replies with how it went and what comes next. */
export async function POST(request: Request) {
  return respond(async () => {
    const body = await readJsonBody(request);
    const outcome = await pickHunt({ token: body.token, huntId: body.huntId, pick: body.pick, reason: body.reason, telemetry: body.telemetry });
    if (outcome.done) after(() => retrainIfDue().catch((err) => console.error("[retrain] failed:", err)));
    return outcome;
  });
}

// A game can end on a hunt, in which case this waits on the judge.
export const maxDuration = 120;
