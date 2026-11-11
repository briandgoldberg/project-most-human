import { enter } from "@/lib/game";
import { optionalString, readJsonBody, respond } from "@/lib/http";

/**
 * Start a game on the human side. Replies with a session and the first
 * question, or with 402 and a transaction to sign if a fee is due.
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
