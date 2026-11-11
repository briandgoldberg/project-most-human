import { requireAgentKey } from "@/lib/agents";
import { enterAgent } from "@/lib/game";
import { readJsonBody, respond } from "@/lib/http";

/**
 * Enter an agent for the bounty. Replies with a session and the first
 * question; from there the agent plays through /api/answer like any player.
 */
export async function POST(request: Request) {
  return respond(async () => {
    const body = await readJsonBody(request);
    const key = await requireAgentKey(body.key);
    return enterAgent({ key, handle: body.handle, userAgent: request.headers.get("user-agent") ?? undefined });
  });
}
