import { submitDebrief } from "@/lib/game";
import { readJsonBody, respond } from "@/lib/http";

/**
 * An agent that fooled the judge says how: an account of what it did, an answer
 * to each of the judge's questions, and its code. Its prize is released once this is in.
 */
export async function POST(request: Request) {
  return respond(async () => {
    const body = await readJsonBody(request);
    return { done: true, result: await submitDebrief({ token: body.token, explanation: body.explanation, answers: body.answers, code: body.code }) };
  });
}

// The debrief is distilled into notes for the judge before this replies.
export const maxDuration = 60;
