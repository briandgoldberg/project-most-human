import { requireAgentKey } from "@/lib/agents";
import { after } from "next/server";
import { enterAgent } from "@/lib/game";
import { restockQuestions } from "@/lib/interview";
import { optionalString, readJsonBody, respond } from "@/lib/http";

/**
 * Enter an agent. Replies with a session and the first question, or with 402
 * and a transaction to sign when the fee is due. From there the agent plays
 * through /api/answer like any player.
 */
export async function POST(request: Request) {
  return respond(async () => {
    const body = await readJsonBody(request);
    // An opening question has just been used: write more, after replying, if the store is running low.
    after(() => restockQuestions().catch((err) => console.error("[questions] could not restock:", err)));
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

// Writing the opening question can wait on the model, and the store of questions is topped up after the reply.
export const maxDuration = 120;
