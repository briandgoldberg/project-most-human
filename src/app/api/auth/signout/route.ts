import { respond } from "@/lib/http";
import { signOut } from "@/lib/session";

export async function POST() {
  return respond(async () => {
    await signOut();
    return { ok: true };
  });
}
