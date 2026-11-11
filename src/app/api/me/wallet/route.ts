import { saveWallet } from "@/lib/game";
import { readJsonBody, respond } from "@/lib/http";
import { currentPlayer, ensureDeviceId } from "@/lib/session";

/** Save the Solana address this player's balance should be sent to. */
export async function POST(request: Request) {
  return respond(async () => {
    const body = await readJsonBody(request);
    return saveWallet(await currentPlayer(), await ensureDeviceId(), body.wallet);
  });
}
