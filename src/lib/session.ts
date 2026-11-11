import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { PLAYER_COOKIE, playerPass, readPlayerPass, type Player } from "./auth";

/**
 * The cookies that say who is at the browser on the human side: a signed-in
 * player's pass, and a long-lived id that tells one browser from another.
 */

const DEVICE_COOKIE = "pmh_device";
const base = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/" };

/** The signed-in player, if this browser carries a valid pass. */
export async function currentPlayer(): Promise<Player | null> {
  return readPlayerPass((await cookies()).get(PLAYER_COOKIE)?.value);
}

export async function signIn(player: Player): Promise<void> {
  const pass = playerPass(player);
  (await cookies()).set(PLAYER_COOKIE, pass.value, { ...base, maxAge: pass.maxAge });
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(PLAYER_COOKIE);
}

/** This browser's id, if it has one. */
export async function deviceId(): Promise<string | undefined> {
  const id = (await cookies()).get(DEVICE_COOKIE)?.value;
  return id && /^[A-Za-z0-9_-]{16,64}$/.test(id) ? id : undefined;
}

/** This browser's id, giving it one if it has none. */
export async function ensureDeviceId(): Promise<string> {
  const existing = await deviceId();
  if (existing) return existing;
  const id = randomBytes(18).toString("base64url");
  (await cookies()).set(DEVICE_COOKIE, id, { ...base, maxAge: 365 * 24 * 60 * 60 });
  return id;
}
