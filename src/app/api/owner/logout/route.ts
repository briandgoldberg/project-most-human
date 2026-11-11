import { cookies } from "next/headers";
import { respond } from "@/lib/http";
import { OWNER_COOKIE } from "@/lib/owner";

/** Lock the owner's page again on this browser. */
export async function POST() {
  return respond(async () => {
    (await cookies()).delete(OWNER_COOKIE);
    return { ok: true };
  });
}
