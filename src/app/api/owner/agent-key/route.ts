import type { NextRequest } from "next/server";
import { setAgentKey } from "@/lib/agents";
import { readJsonBody, respond } from "@/lib/http";
import { OWNER_COOKIE, requireOwner } from "@/lib/owner";

/** Switch a builder's agent key off or on, or mark it as the house's own. */
export async function POST(request: NextRequest) {
  return respond(async () => {
    requireOwner(request.cookies.get(OWNER_COOKIE)?.value);
    const body = await readJsonBody(request);
    await setAgentKey(body.id, { disabled: body.disabled, house: body.house });
    return { ok: true };
  });
}
