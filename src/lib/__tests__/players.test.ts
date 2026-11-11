import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { play, peek, seedPool, type Game } from "./helpers";

// Each test file gets its own empty data directory.
process.env.PMH_DATA_DIR = mkdtempSync(path.join(tmpdir(), "pmh-players-"));
process.env.PAYMENT_MODE = "mock";
process.env.JUDGE_LLM = "off";

// --- Signing in with Google ----------------------------------------------------

const CLIENT_ID = "1234-test.apps.googleusercontent.com";
const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.GOOGLE_TEST_JWKS = JSON.stringify({ keys: [{ ...google.publicKey.export({ format: "jwk" }), kid: "key-1" }] });

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** An ID token as Google would issue it, except as changed by `claims`, `header` or `key`. */
function idToken(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key = google.privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "1122334455", email: "ada@example.com", email_verified: true, given_name: "Ada", name: "Ada L", iat: now - 5, exp: now + 3600, ...claims };
  const unsigned = `${b64({ alg: "RS256", kid: "key-1", typ: "JWT", ...header })}.${b64(body)}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url")}`;
}

test("a Google sign-in is believed only if Google signed it, for this site, in date", async () => {
  const auth = await import("../auth");
  await assert.rejects(auth.verifyGoogleCredential(idToken()), /isn't set up/, "nothing is accepted until the site has a client id");
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;

  const ada = await auth.verifyGoogleCredential(idToken());
  assert.match(ada.id, /^[0-9a-f]{24}$/);
  assert.equal(ada.name, "Ada");
  assert.ok(!JSON.stringify(ada).includes("1122334455") && !JSON.stringify(ada).includes("example.com"), "neither the account id nor the email is kept");
  assert.equal((await auth.verifyGoogleCredential(idToken({ given_name: undefined }))).id, ada.id, "the same account is the same player every time");
  assert.notEqual((await auth.verifyGoogleCredential(idToken({ sub: "999" }))).id, ada.id);

  const bad: [string, string][] = [
    ["for another site", idToken({ aud: "someone-else.apps.googleusercontent.com" })],
    ["from another issuer", idToken({ iss: "https://accounts.example.com" })],
    ["expired", idToken({ exp: Math.floor(Date.now() / 1000) - 600 })],
    ["dated in the future", idToken({ iat: Math.floor(Date.now() / 1000) + 600 })],
    ["unverified email", idToken({ email_verified: false })],
    ["no account id", idToken({ sub: "" })],
    ["signed by someone else", idToken({}, {}, stranger.privateKey)],
    ["a key Google doesn't list", idToken({}, { kid: "key-9" })],
    ["unsigned", `${b64({ alg: "none", kid: "key-1" })}.${b64({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "1", exp: 9e9, iat: 1 })}.`],
    ["claims changed after signing", (() => { const [h, , sig] = idToken().split("."); return `${h}.${b64({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "666", exp: 9e9, iat: 1 })}.${sig}`; })()],
    ["not a token", "hello"],
  ];
  for (const [what, token] of bad) await assert.rejects(auth.verifyGoogleCredential(token), /didn't check out/, what);
  await assert.rejects(auth.verifyGoogleCredential(undefined), /didn't check out/);

  // The browser's pass: signed by the server, good for a month, useless if altered.
  const pass = auth.playerPass(ada).value;
  assert.deepEqual(auth.readPlayerPass(pass), ada);
  const [id, expires, name, mac] = pass.split(".");
  assert.equal(auth.readPlayerPass(`${"0".repeat(24)}.${expires}.${name}.${mac}`), null, "someone else's id");
  assert.equal(auth.readPlayerPass(`${id}.${Number(expires) + 9999}.${name}.${mac}`), null, "a later expiry");
  assert.equal(auth.readPlayerPass(`${id}.${expires}.${Buffer.from("Eve").toString("base64url")}.${mac}`), null, "another name");
  assert.equal(auth.readPlayerPass(pass, Date.now() + 31 * 86_400_000), null, "out of date");
  assert.equal(auth.readPlayerPass(undefined), null);

  // With sign-in on, the human side needs it.
  const game = await import("../game");
  assert.deepEqual((await game.humanSummary()).signIn, { required: true, clientId: CLIENT_ID });
  await assert.rejects(game.enter({ handle: "nobody" }), /Sign in with Google/);
  delete process.env.GOOGLE_CLIENT_ID;
  assert.deepEqual((await game.humanSummary()).signIn, { required: false });
});

// --- Running out of real answers -------------------------------------------------

const P0 = "0".repeat(24);
const P1 = "1".repeat(24);
const P2 = "2".repeat(24);
const P3 = "3".repeat(24);

/** Play one whole game as this player, clearing every round, and report what they were shown. */
async function gameAs(game: Game, player: string, handle: string) {
  const session = await game.enter({ handle, player });
  const { seen, result } = await play(game, session);
  const hunts = (await peek(session)).hunts ?? [];
  return { seen, result, hunts, entryId: session.entryId };
}

test("a player who has judged nearly every real answer is asked to come back when more people have played", async () => {
  const game = await import("../game");
  const { seenKey } = await import("../hunt");
  const me = (player: string) => game.whoAmI({ id: player, name: "x" }, undefined);

  // Before anyone has played there is nothing to hunt. A newcomer still gets a game: the questions alone.
  assert.deepEqual(await game.playStanding(P0), { ok: true, hunting: false });
  const first = await gameAs(game, P0, "the first");
  assert.ok(!first.seen.some((s) => s.startsWith("hunt")) && first.result.prize?.tokens === 20);
  // Having played, they wait for other people rather than play the same thing again.
  assert.equal((await me(P0)).canPlay, false);
  await assert.rejects(game.enter({ handle: "the first", player: P0 }), /Come back once more people have played/);
  // Someone playing without an account is known by their browser instead, and gets the same.
  await play(game, await game.enter({ handle: "no account", deviceId: "a-browser-cookie-id-1" }));
  await assert.rejects(game.enter({ handle: "no account", deviceId: "a-browser-cookie-id-1" }), /Come back/);
  assert.equal((await game.whoAmI(null, "a-browser-cookie-id-1")).canPlay, false);
  assert.equal((await game.whoAmI(null, "a-browser-cookie-id-2")).canPlay, true);
  assert.equal((await game.whoAmI(null, undefined)).canPlay, true);

  // Twelve real answers from three other people arrive. Now there is a full game's worth for everyone.
  await seedPool();
  assert.equal((await me(P0)).canPlay, true);
  // With the four answers each of the first two players left, that is twenty for anyone new.

  // A full game uses six of them: one easy round, two medium, three hard.
  const one = await gameAs(game, P1, "keen");
  assert.deepEqual(one.hunts.map((h) => h.level), [1, 2, 2, 3, 3, 3]);
  assert.equal(one.result.prize?.tokens, 500);
  assert.equal((await me(P1)).canPlay, true, "six they haven't seen are left");
  const two = await gameAs(game, P1, "keen");
  assert.equal((await me(P1)).canPlay, true, "and six more after that");
  const three = await gameAs(game, P1, "keen");
  assert.deepEqual([two.hunts.length, three.hunts.length], [6, 6]);

  // Across three games they never saw the same answer twice, and never one of their own.
  const shown = [...one.hunts, ...two.hunts, ...three.hunts];
  const mine = [one.entryId, two.entryId, three.entryId];
  assert.equal(new Set(shown.map(seenKey)).size, 18);
  assert.ok(shown.every((h) => !mine.includes(h.sourceEntryId)));
  const { readPlayer, readHuntRecords, readTraining } = await import("../store");
  assert.deepEqual([(await readPlayer(P1))!.games, (await readPlayer(P1))!.seen.length], [3, 18]);
  assert.equal((await readHuntRecords()).filter((r) => r.hunter === P1).length, 18);
  assert.equal((await readTraining()).filter((e) => e.player === P1).length, 3, "their own answers are on file under their id");

  // That was nearly everything. They are told to come back, on the page and if they try anyway.
  assert.equal((await me(P1)).canPlay, false);
  await assert.rejects(game.enter({ handle: "keen", player: P1 }), (err: Error & { status?: number; code?: string }) => err.status === 409 && err.code === "come_back");

  // Nobody else is held up, and P1's own answers are now material for them.
  assert.equal((await me(P2)).canPlay, true);
  // P1 had two answers left unseen. One more person's four make a game's worth again.
  await gameAs(game, P2, "second");
  assert.equal((await me(P1)).canPlay, true);
  const four = await gameAs(game, P1, "keen");
  assert.ok(four.hunts.length === 6 && four.hunts.every((h) => !shown.some((old) => seenKey(old) === seenKey(h))));
  // Now nothing is left, and one more person's four answers are not enough for a game.
  assert.equal((await me(P1)).canPlay, false);
  await gameAs(game, P3, "third");
  assert.equal((await me(P1)).canPlay, false);

  // The owner can switch the rule off, for testing: then answers may come round again.
  process.env.HUNT_REPEATS = "on";
  assert.equal((await me(P1)).canPlay, true);
  delete process.env.HUNT_REPEATS;
});

test("prizes build up in a player's balance, and are sent once they say where", async () => {
  const game = await import("../game");
  const { readPlayer } = await import("../store");
  const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
  const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const P5 = { id: "5".repeat(24), name: "Eve" };
  const before = (await game.prizesOwed()).length;

  // Before they have played, their first name from Google will do as a handle, if it fits. After, it is what they last played as.
  assert.equal((await game.whoAmI(P5, undefined)).handle, "Eve");
  assert.equal((await game.whoAmI({ id: "6".repeat(24), name: "J" }, undefined)).handle, undefined);
  assert.equal((await game.whoAmI({ id: "6".repeat(24), name: "Zoë" }, undefined)).handle, undefined);
  assert.equal((await game.whoAmI(null, "a-browser-with-no-history")).handle, undefined);

  // Real tokens, and nobody is asked for an address to play.
  process.env.PAYMENT_MODE = "solana";
  try {
    const miss = { hunt: (_: number, right: 0 | 1) => (1 - right) as 0 | 1 };
    const first = await play(game, await game.enter({ handle: "saver", player: P5.id }), miss);
    const { symbol, ...won } = first.result.prize!;
    assert.deepEqual([won, typeof symbol, first.result.missedPrize], [{ tokens: 20, payable: false, banked: true }, "string", undefined]);
    const second = await play(game, await game.enter({ handle: "saver", player: P5.id }), { hunt: (round, right) => (round === 3 ? ((1 - right) as 0 | 1) : right) });
    assert.equal(second.result.prize?.tokens, 80);
    assert.deepEqual([(await game.whoAmI(P5, undefined)).balance, (await game.whoAmI(P5, undefined)).wallet], [100, undefined]);

    // Nothing can be sent yet: it waits in their balance.
    const waiting = (await game.prizesOwed()).filter((e) => e.handle === "saver");
    assert.deepEqual(waiting.map((e) => [e.prize!.tokens, e.wallet]), [[20, undefined], [80, undefined]]);

    // They say where. It has to be a real address, and theirs to set.
    await assert.rejects(game.saveWallet(P5, undefined, "not-an-address"), /valid Solana address/);
    await assert.rejects(game.saveWallet(P5, undefined, ""), /valid Solana address/);
    await assert.rejects(game.saveWallet(null, undefined, WALLET), /Play a game first/);
    process.env.GOOGLE_CLIENT_ID = "x.apps.googleusercontent.com";
    await assert.rejects(game.saveWallet(null, "some-browser-cookie-id", WALLET), /Sign in with Google first/);
    delete process.env.GOOGLE_CLIENT_ID;
    assert.deepEqual(await game.saveWallet(P5, undefined, ` ${WALLET} `), { signedIn: true, name: "Eve", handle: "saver", canPlay: (await game.whoAmI(P5, undefined)).canPlay, banned: false, strikes: 0, balance: 100, wallet: WALLET });
    assert.equal((await readPlayer(P5.id))!.wallet, WALLET);

    // Now everything they have won is owed to that address, and so is what they win next.
    const owed = (await game.prizesOwed()).filter((e) => e.handle === "saver");
    assert.deepEqual(owed.map((e) => [e.prize!.tokens, e.wallet]), [[20, WALLET], [80, WALLET]]);
    await game.markPrizePaid(owed[0], "sig-1");
    await game.markPrizePaid(owed[0], "sig-1");
    assert.equal((await game.whoAmI(P5, undefined)).balance, 80, "paying one twice takes it off the balance once");
    // They can change their mind about where before the rest goes out.
    await game.saveWallet(P5, undefined, OTHER);
    assert.deepEqual((await game.prizesOwed()).filter((e) => e.handle === "saver").map((e) => [e.prize!.tokens, e.wallet]), [[80, OTHER]]);
    await game.markPrizePaid(owed[1], "sig-2");
    assert.equal((await game.whoAmI(P5, undefined)).balance, 0);
    assert.equal((await game.prizesOwed()).length, before);

    // Without sign-in the browser is the account: same balance, same rules.
    const anon = await play(game, await game.enter({ handle: "anon", deviceId: "a-browser-cookie-id-9" }), miss);
    assert.equal(anon.result.prize?.banked, true);
    assert.equal((await game.whoAmI(null, "a-browser-cookie-id-9")).balance, 20);
    assert.equal((await game.saveWallet(null, "a-browser-cookie-id-9", WALLET)).wallet, WALLET);
    assert.equal((await game.whoAmI(null, "another-browser-cookie")).balance, 0);
  } finally {
    process.env.PAYMENT_MODE = "mock";
  }
});
