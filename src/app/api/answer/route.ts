import { answer } from "@/lib/game";
import { readJsonBody, respond } from "@/lib/http";

/** Submit the answer to the current question. Replies with the next question, or the verdict after the last one. */
export async function POST(request: Request) {
  return respond(async () => {
    const body = await readJsonBody(request);
    return answer({ token: body.token, questionId: body.questionId, text: body.text, telemetry: body.telemetry });
  });
}

// The last answer waits on the judge.
export const maxDuration = 120;
