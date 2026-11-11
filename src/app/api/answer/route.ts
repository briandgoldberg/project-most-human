import { after } from "next/server";
import { answer } from "@/lib/game";
import { readJsonBody, respond } from "@/lib/http";
import { retrainIfDue } from "@/lib/owner";

/** Submit the answer to the current question. Replies with the next step, or the verdict after the last one. */
export async function POST(request: Request) {
  return respond(async () => {
    const body = await readJsonBody(request);
    const outcome = await answer({ token: body.token, questionId: body.questionId, text: body.text, telemetry: body.telemetry });
    // Each finished game may tip the judge over its retraining threshold. That happens after the reply is sent.
    if (outcome.done) after(() => retrainIfDue().catch((err) => console.error("[retrain] failed:", err)));
    return outcome;
  });
}

// The last answer waits on the judge.
export const maxDuration = 120;
