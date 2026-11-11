import { cookies } from "next/headers";
import { clientAddress, readJsonBody, respond } from "@/lib/http";
import { TRAINING_COOKIE, checkPassword, trainingPass } from "@/lib/training";

/** Unlock the training room with its password. */
export async function POST(request: Request) {
  return respond(async () => {
    const body = await readJsonBody(request);
    const cohort = checkPassword(body.password, clientAddress(request));
    const pass = trainingPass(cohort);
    (await cookies()).set(TRAINING_COOKIE, pass.value, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: pass.maxAge,
    });
    return { ok: true };
  });
}
