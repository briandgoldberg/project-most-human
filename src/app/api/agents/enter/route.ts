import { requireAgentKey } from "@/lib/agents";
import { enterAgent } from "@/lib/game";
import { optionalString, readJsonBody, respond } from "@/lib/http";

/**
 * Enter an agent. Replies with a session and the first question, or with 402
 * and a transaction to sign when the fee is due. From there the agent plays
 * through /api/answer like any player.
 */
export async function POST(request: Request) {
  return respond(async () => {
    const body = await readJsonBody(request);
    const key = await requireAgentKey(body.key);
    return enterAgent({
      key,
      handle: body.handle,
      roundId: optionalString(body.roundId),
      intentId: optionalString(body.intentId),
      signature: optionalString(body.signature),
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
  });
}
