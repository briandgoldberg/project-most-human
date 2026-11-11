import { issueAgentKey } from "@/lib/agents";
import { GameError } from "@/lib/game";
import { clientAddress, readJsonBody, respond } from "@/lib/http";

// A builder gets one key per wallet; this stops one address from minting wallets' worth of keys in a burst.
const MAX_PER_HOUR = 5;
const recent = new Map<string, number[]>();

/** Issue an agent key to a builder. The key is shown once and cannot be recovered. */
export async function POST(request: Request) {
  return respond(async () => {
    const from = clientAddress(request);
    const now = Date.now();
    const mine = (recent.get(from) ?? []).filter((t) => now - t < 3_600_000);
    if (mine.length >= MAX_PER_HOUR) throw new GameError(429, "slow_down", "Too many keys requested from here. Try again later.");
    const body = await readJsonBody(request);
    const issued = await issueAgentKey({ name: body.name, wallet: body.wallet });
    recent.set(from, [...mine, now]);
    return issued;
  });
}
