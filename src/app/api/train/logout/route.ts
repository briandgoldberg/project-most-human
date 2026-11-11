import { cookies } from "next/headers";
import { respond } from "@/lib/http";
import { TRAINING_COOKIE } from "@/lib/training";

/** Lock the training room again on this browser. */
export async function POST() {
  return respond(async () => {
    (await cookies()).delete(TRAINING_COOKIE);
    return { ok: true };
  });
}
