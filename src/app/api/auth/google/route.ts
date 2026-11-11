import { verifyGoogleCredential } from "@/lib/auth";
import { whoAmI } from "@/lib/game";
import { readJsonBody, respond } from "@/lib/http";
import { deviceId, signIn } from "@/lib/session";

/** Sign in with the ID token Google's button hands the browser. */
export async function POST(request: Request) {
  return respond(async () => {
    const body = await readJsonBody(request);
    const player = await verifyGoogleCredential(body.credential);
    await signIn(player);
    return whoAmI(player, await deviceId());
  });
}
