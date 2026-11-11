import { cookies } from "next/headers";
import { clientAddress, readJsonBody, respond } from "@/lib/http";
import { OWNER_COOKIE, checkOwnerPassword, ownerPass } from "@/lib/owner";

/** Unlock the owner's page with its password. */
export async function POST(request: Request) {
  return respond(async () => {
    checkOwnerPassword((await readJsonBody(request)).password, clientAddress(request));
    const pass = ownerPass();
    (await cookies()).set(OWNER_COOKIE, pass.value, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: pass.maxAge,
    });
    return { ok: true };
  });
}
