import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { enter } from "@/lib/game";
import { clientAddress, optionalString, readJsonBody, respond } from "@/lib/http";

const DEVICE_COOKIE = "pmh_device";

/**
 * Start a game on the human side. Replies with a session and the first
 * question, or with 402 and a transaction to sign if a fee is due.
 */
export async function POST(request: Request) {
  return respond(async () => {
    const body = await readJsonBody(request);
    // A long-lived cookie tells one browser from another, so prizes can be limited per person.
    const jar = await cookies();
    let deviceId = jar.get(DEVICE_COOKIE)?.value;
    if (!deviceId || !/^[A-Za-z0-9_-]{16,64}$/.test(deviceId)) {
      deviceId = randomBytes(18).toString("base64url");
      jar.set(DEVICE_COOKIE, deviceId, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 365 * 24 * 60 * 60,
      });
    }
    return enter({
      handle: optionalString(body.handle) ?? "",
      wallet: optionalString(body.wallet),
      roundId: optionalString(body.roundId),
      intentId: optionalString(body.intentId),
      signature: optionalString(body.signature),
      userAgent: request.headers.get("user-agent") ?? undefined,
      clientAddress: clientAddress(request),
      deviceId,
      website: optionalString(body.website),
    });
  });
}
