import { createPublicKey, verify as verifySignature } from "node:crypto";

/**
 * Checking a signed token (a JWT) from an identity provider: Google, for
 * players signing in, and GitHub, for the payout job saying who it is. The
 * provider publishes its public keys; a token is believed only if one of them
 * signed it, it was issued by that provider for this site, and it is in date.
 */

export interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

const CLOCK_SKEW_S = 120;
const KEYS_TTL_MS = 60 * 60 * 1000;

const cache = new Map<string, { at: number; keys: Jwk[] }>();

/** A provider's current signing keys. They rotate, so an unknown key id is worth one fresh look. */
async function providerKeys(url: string, fresh: boolean): Promise<Jwk[]> {
  const held = cache.get(url);
  if (!fresh && held && Date.now() - held.at < KEYS_TTL_MS) return held.keys;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch signing keys from ${new URL(url).host} (${res.status})`);
  const keys = ((await res.json()) as { keys: Jwk[] }).keys;
  cache.set(url, { at: Date.now(), keys });
  return keys;
}

/** Why a token was turned down. The message is for the server's log, not for whoever sent the token. */
export class TokenRefused extends Error {}

function decode(part: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new TokenRefused("token is not readable");
}

export interface TokenRules {
  /** Where the provider publishes its keys. */
  keysUrl: string;
  /** Keys to use instead, for running locally without the provider. Callers must never pass this in production. */
  testKeys?: string;
  issuers: string[];
  /** Who the token must have been issued for. */
  audience: string;
}

/**
 * Verify a token's signature, issuer, audience and dates, and return its
 * claims. Throws TokenRefused otherwise. What the claims must say beyond that
 * is the caller's business.
 */
export async function verifyToken(token: unknown, rules: TokenRules, now = Date.now()): Promise<Record<string, unknown>> {
  const parts = typeof token === "string" && token.length < 8192 ? token.split(".") : [];
  if (parts.length !== 3) throw new TokenRefused("not a token");
  const [head, body, signature] = parts;
  const header = decode(head);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new TokenRefused("unexpected algorithm or no key id");

  const keys = async (fresh: boolean) => (rules.testKeys ? (JSON.parse(rules.testKeys) as { keys: Jwk[] }).keys : providerKeys(rules.keysUrl, fresh));
  let key = (await keys(false)).find((k) => k.kid === header.kid);
  if (!key) key = (await keys(true)).find((k) => k.kid === header.kid);
  if (!key || key.kty !== "RSA") throw new TokenRefused("signed with a key the provider doesn't list");
  const signed = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${head}.${body}`),
    createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: "jwk" }),
    Buffer.from(signature, "base64url"),
  );
  if (!signed) throw new TokenRefused("signature doesn't match");

  const claims = decode(body);
  const seconds = now / 1000;
  if (typeof claims.iss !== "string" || !rules.issuers.includes(claims.iss)) throw new TokenRefused("not issued by the provider");
  if (claims.aud !== rules.audience) throw new TokenRefused("issued for a different site");
  if (typeof claims.exp !== "number" || claims.exp < seconds - CLOCK_SKEW_S) throw new TokenRefused("expired");
  if (typeof claims.iat !== "number" || claims.iat > seconds + CLOCK_SKEW_S) throw new TokenRefused("dated in the future");
  return claims;
}
