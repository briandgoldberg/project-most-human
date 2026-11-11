import { enter } from "@/lib/game";
import { clientAddress, optionalString, readJsonBody, respond } from "@/lib/http";
import { currentPlayer, ensureDeviceId } from "@/lib/session";

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
      clientAddress: clientAddress(request),
      // Who is playing: their Google account if signed in, and the browser either way.
      player: (await currentPlayer())?.id,
      deviceId: await ensureDeviceId(),
      website: optionalString(body.website),
    });
  });
}
