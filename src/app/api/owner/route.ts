import type { NextRequest } from "next/server";
import { respond } from "@/lib/http";
import { OWNER_COOKIE, ownerSummary, requireOwner } from "@/lib/owner";

/** The owner's dashboard: what the judge has learned, prizes owed, agent keys. */
export async function GET(request: NextRequest) {
  return respond(async () => {
    requireOwner(request.cookies.get(OWNER_COOKIE)?.value);
    return ownerSummary();
  });
}
