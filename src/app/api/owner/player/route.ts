import type { NextRequest } from "next/server";
import { readJsonBody, respond } from "@/lib/http";
import { OWNER_COOKIE, liftBan, requireOwner } from "@/lib/owner";

/** Lift a ban on a player's account. */
export async function POST(request: NextRequest) {
  return respond(async () => {
    requireOwner(request.cookies.get(OWNER_COOKIE)?.value);
    const body = await readJsonBody(request);
    await liftBan(body.id);
    return { ok: true };
  });
}
