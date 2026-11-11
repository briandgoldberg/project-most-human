import { createHash, createHmac, createPublicKey, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { config, sessionSecret } from "./config";
import { GameError } from "./game";

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
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const CLOCK_SKEW_S = 120;
const CERTS_TTL_MS = 60 * 60 * 1000;

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

let certs: { at: number; keys: Jwk[] } | undefined;

/** Google's current signing keys. They rotate, so an unknown key id is worth one fresh look. */
async function googleKeys(fresh = false): Promise<Jwk[]> {
  // For running the sign-in flow locally without Google. Never read in production.
  const test = process.env.NODE_ENV !== "production" ? process.env.GOOGLE_TEST_JWKS : undefined;
  if (test) return (JSON.parse(test) as { keys: Jwk[] }).keys;
  if (!fresh && certs && Date.now() - certs.at < CERTS_TTL_MS) return certs.keys;
  const res = await fetch(GOOGLE_CERTS);
  if (!res.ok) throw new Error(`Could not fetch Google's signing keys (${res.status})`);
  certs = { at: Date.now(), keys: ((await res.json()) as { keys: Jwk[] }).keys };
  return certs.keys;
}

const refuse = (why: string): never => {
  console.warn(`[auth] Google sign-in refused: ${why}`);
  throw new GameError(401, "bad_sign_in", "Google sign-in didn't check out. Try again.");
};

const decode = (part: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  return refuse("token is not readable");
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
  const parts = typeof credential === "string" && credential.length < 4096 ? credential.split(".") : [];
  if (parts.length !== 3) return refuse("not a token");
  const [head, body, signature] = parts;
  const header = decode(head);
  if (header.alg !== "RS256" || typeof header.kid !== "string") return refuse("unexpected algorithm or no key id");

  let key = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!key) key = (await googleKeys(true)).find((k) => k.kid === header.kid);
  if (!key || key.kty !== "RSA") return refuse("signed with a key Google doesn't list");
  const signed = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${head}.${body}`),
    createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: "jwk" }),
    Buffer.from(signature, "base64url"),
  );
  if (!signed) return refuse("signature doesn't match");

  const claims = decode(body);
  const seconds = now / 1000;
  if (typeof claims.iss !== "string" || !ISSUERS.has(claims.iss)) return refuse("not issued by Google");
  if (claims.aud !== clientId) return refuse("issued for a different site");
  if (typeof claims.exp !== "number" || claims.exp < seconds - CLOCK_SKEW_S) return refuse("expired");
  if (typeof claims.iat !== "number" || claims.iat > seconds + CLOCK_SKEW_S) return refuse("dated in the future");
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
