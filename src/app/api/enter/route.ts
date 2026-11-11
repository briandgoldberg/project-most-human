import { enter } from "@/lib/game";
import { optionalString, readJsonBody, respond } from "@/lib/http";

/**
 * Enter today's competition. Replies with a session and the first question, or
 * with 402 and a transaction to sign when an entry fee is due.
 *
 * This is the public door. It takes no password and creates no labelled
 * sessions; those come only from the training room (/api/train/enter).
 */
export async function POST(request: Request) {
  return respond(async () => {
    const body = await readJsonBody(request);
    return enter({
      handle: optionalString(body.handle) ?? "",
      wallet: optionalString(body.wallet),
      roundId: optionalString(body.roundId),
      intentId: optionalString(body.intentId),
      signature: optionalString(body.signature),
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
  });
}
