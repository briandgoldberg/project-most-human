import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config, sessionSecret } from "./config";
import { GameError } from "./game";
import { TokenRefused, verifyToken } from "./jwt";

/**
 * Who a player on the human side is: a Google account.
 *
 * The browser gets an ID token from Google's sign-in button and sends it here.
 * The server checks Google's signature on it and that it was issued for this
 * site, then hands the browser its own signed pass. The game keeps a one-way
 * hash of the account's id, never the email address.
 */

export const PLAYER_COOKIE = "pmh_player";
const PASS_TTL_S = 30 * 24 * 60 * 60;
const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const refuse = (why: string): never => {
  console.warn(`[auth] Google sign-in refused: ${why}`);
  throw new GameError(401, "bad_sign_in", "Google sign-in didn't check out. Try again.");
};

export interface Player {
  /** One-way hash of the Google account id. What the game stores. */
  id: string;
  /** What to call them on their own screen. Kept in their browser's pass, not by the game. */
  name: string;
}

/** A stable id for a Google account that can't be turned back into the account. */
const playerId = (sub: string) => createHash("sha256").update(`player:${sessionSecret()}:${sub}`).digest("hex").slice(0, 24);

/**
 * Check an ID token from Google's sign-in button: signed by Google, issued for
 * this site, in date, and for an account whose email Google has verified.
 */
export async function verifyGoogleCredential(credential: unknown, now = Date.now()): Promise<Player> {
  const clientId = config().googleClientId;
  if (!clientId) throw new GameError(400, "sign_in_off", "Google sign-in isn't set up on this site");
  const claims = await verifyToken(
    credential,
    {
      keysUrl: GOOGLE_CERTS,
      // For running the sign-in flow locally without Google. Never read in production.
      testKeys: process.env.NODE_ENV !== "production" ? process.env.GOOGLE_TEST_JWKS : undefined,
      issuers: ISSUERS,
      audience: clientId,
    },
    now,
  ).catch((err) => (err instanceof TokenRefused ? refuse(err.message) : Promise.reject(err)));
  if (typeof claims.sub !== "string" || !claims.sub) return refuse("no account id");
  if (claims.email_verified === false) return refuse("email not verified");

  const given = typeof claims.given_name === "string" ? claims.given_name : typeof claims.name === "string" ? claims.name : "";
  return { id: playerId(claims.sub), name: given.replace(/\s+/g, " ").trim().slice(0, 40) || "player" };
}

const sign = (id: string, expires: number, name: string) =>
  createHmac("sha256", sessionSecret()).update(`player.${id}.${expires}.${name}`).digest("base64url");

/** The pass a signed-in browser carries. */
export function playerPass(player: Player, now = Date.now()): { value: string; maxAge: number } {
  const expires = Math.floor(now / 1000) + PASS_TTL_S;
  const name = Buffer.from(player.name).toString("base64url");
  return { value: `${player.id}.${expires}.${name}.${sign(player.id, expires, name)}`, maxAge: PASS_TTL_S };
}

/** Who a pass belongs to, or null if it is missing, forged or out of date. */
export function readPlayerPass(value: string | undefined, now = Date.now()): Player | null {
  const [id, expiresRaw, name, mac] = (value ?? "").split(".");
  const expires = Number(expiresRaw);
  if (!id || !name || !mac || !/^[0-9a-f]{24}$/.test(id) || !Number.isFinite(expires) || expires < now / 1000) return null;
  const expected = Buffer.from(sign(id, expires, name));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { id, name: Buffer.from(name, "base64url").toString("utf8") };
}
