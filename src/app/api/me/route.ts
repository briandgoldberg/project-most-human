import { whoAmI } from "@/lib/game";
import { respond } from "@/lib/http";
import { currentPlayer, deviceId } from "@/lib/session";

/** Who is at this browser, and whether they can start a game now. */
export async function GET() {
  return respond(async () => whoAmI(await currentPlayer(), await deviceId()));
}
