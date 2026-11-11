import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { MEMO_PROGRAM_ID, checkPayment, toRawAmount, type ParsedTxLike, type PaymentExpectation } from "../payments/solana";
import { bankQuestionsFor } from "../questions";
import type { Entry, Question, TrainingExample } from "../types";
import { drawing, humanlike } from "./fixtures";

// Each test file gets its own empty data directory.
const dataDir = mkdtempSync(path.join(tmpdir(), "pmh-test-"));
process.env.PMH_DATA_DIR = dataDir;
process.env.PAYMENT_MODE = "mock";
process.env.JUDGE_LLM = "off";
process.env.RETRAIN_EVERY = "3";

const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const TREASURY = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type Game = typeof import("../game");
type Outcome = Awaited<ReturnType<Game["answer"]>>;
const ANSWERS = [
  "my left knee, i sit on it like an idiot and then act surprised",
  "since college probably",
  "the neighbours dog. it has opinions about the bin lorry and shares them at 6am",
  "no",
];

/** The entry as the server holds it, including what the player is never shown. */
async function peek(session: { roundId: string; entryId: string }): Promise<Entry> {
  const { readRound } = await import("../store");
  return (await readRound(session.roundId))!.entries[session.entryId];
}

/**
 * Play a game to the end. `how` is how the answers are produced; `hunt` decides
 * each hunting round given the right answer (default: always right).
 */
async function play(
  game: Game,
  session: { token: string; roundId: string; entryId: string; question: Question },
  opts: { how?: "person" | "script"; hunt?: (round: number, right: 0 | 1) => 0 | 1 } = {},
) {
  const { updateRound } = await import("../store");
  let step: Outcome = { done: false, question: session.question, index: 0, total: 0 };
  let n = 0;
  const seen: string[] = [];
  for (;;) {
    const now = step;
    if (now.done) return { result: now.result, seen };
    if (now.hunt) {
      const hunt = now.hunt;
      const right = (await peek(session)).hunts!.find((h) => h.id === hunt.id)!.humanIndex;
      seen.push(`hunt${hunt.round}`);
      step = await game.pickHunt({ token: session.token, huntId: hunt.id, pick: (opts.hunt ?? ((_, r) => r))(hunt.round, right) });
      continue;
    }
    const q: Question = now.question!;
    seen.push(q.kind);
    const text = q.kind === "text" ? ANSWERS[n % ANSWERS.length] : "";
    if (opts.how === "script") {
      // No recording of a person producing anything; the drawing is the least that is accepted.
      step = await game.answer({ token: session.token, questionId: q.id, text, telemetry: q.kind === "draw" ? { strokes: [[[1, 1, 1, 0], [2, 9, 9, 0]]] } : {} });
    } else {
      const telemetry = q.kind === "draw" ? drawing() : humanlike(text, n);
      // A person takes as long as their recording says. Tests don't wait, so move the question's start back instead.
      await updateRound(session.roundId, (state) => {
        const e = state.entries[session.entryId];
        e.servedAt[e.answers.length] = Date.now() - (telemetry.submittedAt - telemetry.shownAt);
      });
      step = await game.answer({ token: session.token, questionId: q.id, text, telemetry });
    }
    n++;
  }
}

/** Put some confirmed-human answers in the hunting pool, as earlier players would have. */
async function seedPool(people = 3) {
  const { appendTraining } = await import("../store");
  const { clearHuntCache } = await import("../hunt");
  for (let p = 0; p < people; p++) {
    const questions: Question[] = [0, 1, 2, 3].map((i) => ({ id: `seed${p}-q${i}`, kind: "text", category: "seed", prompt: `Seed question ${p}.${i}?` }));
    await appendTraining({
      entryId: `seed-${p}`, roundId: "2026-01-01", recordedAt: 1, label: "human", cohortId: "players", source: "auto", consent: "v3",
      handle: `seed ${p}`, questions,
      answers: questions.map((q, i) => ({ questionId: q.id, text: `a real persons answer number ${p}.${i}, typed in a hurry`, serverLatencyMs: 9000 })),
      features: {}, judge: { score: 80, behaviorScore: 80, heuristicScore: 80, verdict: "human", quip: "", reasons: [], scoredAt: 1 },
      judgeCorrect: true, telemetry: {},
    } as unknown as TrainingExample);
  }
  clearHuntCache();
}

test("a day's bank questions are stable, and different from the next day's", () => {
  const today = bankQuestionsFor("2026-11-11");
  assert.deepEqual(today, bankQuestionsFor("2026-11-11"));
  assert.equal(today.filter((q) => q.kind === "draw").length, 1);
  assert.notDeepEqual(today.map((q) => q.prompt), bankQuestionsFor("2026-11-12").map((q) => q.prompt));
});

test("before anyone has played there is nothing to hunt with, so a game is the questions alone", async () => {
  const game = await import("../game");
  const summary = await game.humanSummary();
  assert.equal(summary.hunting, false);
  const session = await game.enter({ handle: "first ever" });
  assert.equal(session.total, 5);
  const { result, seen } = await play(game, session);
  assert.deepEqual(seen, ["text", "text", "text", "text", "draw"]);
  assert.equal(result.hunt, undefined);
  assert.equal(result.prize, undefined);
  assert.ok(result.score >= 60, `a human-like recording should pass with confidence, scored ${result.score}`);
  await assert.rejects(game.enter({ handle: "x" }), /2 to 20/);
});

test("a full game: questions and hunting interleaved, the ladder climbed, the prize won", async () => {
  await seedPool();
  const game = await import("../game");
  assert.equal((await game.humanSummary()).hunting, true);

  const session = await game.enter({ handle: "sharp eyes", wallet: WALLET });
  assert.equal(session.total, 11);
  const { result, seen } = await play(game, session);
  assert.deepEqual(seen, ["text", "text", "hunt1", "hunt2", "hunt3", "text", "text", "hunt4", "hunt5", "hunt6", "draw"]);
  assert.deepEqual(result.hunt, { cleared: 6, rounds: 6, prizeRound: 6 });
  assert.deepEqual(result.prize, { tokens: 500, symbol: "PLAY", payable: true });
  assert.equal(result.cancelled, undefined);

  // What the player was shown never said which answer was the person's, and never repeated one.
  const entry = await peek(session);
  assert.equal(new Set(entry.hunts!.map((h) => `${h.sourceEntryId}:${h.prompt}`)).size, 6);
  assert.deepEqual(entry.hunts!.map((h) => h.level), [1, 2, 2, 3, 3, 3]);
  for (const h of entry.hunts!) {
    const person = h.options[h.humanIndex];
    assert.ok(/^a real persons answer/.test(person) || ANSWERS.includes(person), `the marked answer should be a real one: ${person}`);
    assert.ok(h.sourceEntryId !== entry.id, "a player never hunts their own answers");
  }

  // They are on the board as a winner, and the prize is owed to the address they gave.
  const row = (await game.humanSummary()).board.find((r) => r.handle === "sharp eyes")!;
  assert.deepEqual([row.cleared, row.rounds, row.won], [6, 6, 500]);
  const owed = await game.prizesOwed();
  assert.deepEqual(owed.map((e) => [e.handle, e.prize!.reason, e.wallet]), [["sharp eyes", "hunter", WALLET]]);
  await game.markPrizePaid(owed[0], "sig123");
  assert.deepEqual(await game.prizesOwed(), []);
});

test("one wrong pick ends the climb, and the rest of the game is the questions", async () => {
  const game = await import("../game");
  const session = await game.enter({ handle: "fooled at three" });
  const { result, seen } = await play(game, session, { hunt: (round, right) => (round === 3 ? ((1 - right) as 0 | 1) : right) });
  assert.deepEqual(seen, ["text", "text", "hunt1", "hunt2", "hunt3", "text", "text", "draw"]);
  assert.deepEqual(result.hunt, { cleared: 2, rounds: 6, prizeRound: 6 });
  assert.equal(result.prize, undefined);

  // Each pick, right or wrong, was kept as a judgement on a pair whose truth is known.
  const { readHuntRecords } = await import("../store");
  const mine = (await readHuntRecords()).filter((r) => r.hunterEntryId === session.entryId);
  assert.deepEqual(mine.map((r) => [r.level, r.correct]), [[1, true], [2, true], [2, false]]);

  // Moves are refused out of turn.
  const other = await game.enter({ handle: "out of turn" });
  await assert.rejects(game.pickHunt({ token: other.token, huntId: "h-x", pick: 0 }), (e: { code?: string }) => e.code === "wrong_hunt");
  await assert.rejects(game.answer({ token: other.token, questionId: "nope", text: "hi", telemetry: {} }), (e: { code?: string }) => e.code === "wrong_question");
  await assert.rejects(game.answer({ token: other.token.slice(0, -2) + "zz", questionId: other.question.id, text: "hi", telemetry: {} }), (e: { code?: string }) => e.code === "bad_token");
});

test("a player the judge takes for a bot is cancelled: no board, no prize, not learned from as human", async () => {
  const game = await import("../game");
  const session = await game.enter({ handle: "definitely human", wallet: WALLET });
  // Perfect hunting, but answers that arrive with no sign of a person producing them.
  const { result } = await play(game, session, { how: "script" });
  assert.ok(result.score < 50, `a script should not pass, scored ${result.score}`);
  assert.equal(result.cancelled, true);
  assert.equal(result.prize, undefined);
  assert.equal(result.hunt?.cleared, 6, "they did clear the ladder; it just doesn't count");

  assert.ok(!(await game.humanSummary()).board.some((r) => r.handle === "definitely human"));
  assert.ok(!(await game.prizesOwed()).some((e) => e.handle === "definitely human"));
  const { readTraining } = await import("../store");
  assert.ok(!(await readTraining()).some((e) => e.handle === "definitely human"));
});

test("players the judge is confident about become human examples, and their answers join the hunt", async () => {
  const { readTraining } = await import("../store");
  const { humanPool, clearHuntCache } = await import("../hunt");
  const examples = (await readTraining()).filter((e) => e.cohortId === "players" && !e.entryId.startsWith("seed-"));
  assert.deepEqual(examples.map((e) => e.handle).sort(), ["first ever", "fooled at three", "sharp eyes"]);
  for (const e of examples) {
    assert.deepEqual([e.label, e.source, e.consent, e.device], ["human", "auto", "v3", "desktop"]);
    assert.ok(e.judge.score >= 60);
  }
  clearHuntCache();
  const pool = await humanPool();
  assert.ok(pool.some((a) => a.text === ANSWERS[0]), "a passing player's answers are now hunting material");
  assert.ok(!pool.some((a) => a.text === "no"), "answers too short to be worth showing are left out");
});

test("the bot side: keys, the fee, the prize for fooling the judge, and the house's own agents", async () => {
  const game = await import("../game");
  const agents = await import("../agents");
  const store = await import("../store");
  const humansBefore = await game.humanSummary();

  // One key per wallet, shown once, stored only as a hash.
  await assert.rejects(agents.issueAgentKey({ name: "x", wallet: WALLET }), /builder name/);
  await assert.rejects(agents.issueAgentKey({ name: "Acme Labs", wallet: "not-a-wallet" }), /Solana address/);
  const { key } = await agents.issueAgentKey({ name: "Acme Labs", wallet: WALLET });
  assert.match(key, /^mh_agent_[0-9a-f]{12}_.{20,}$/);
  await assert.rejects(agents.issueAgentKey({ name: "Other", wallet: WALLET }), /already has an agent key/);
  assert.ok(!JSON.stringify(await store.readAgentKeys()).includes(key.slice(22)), "the secret is not stored");
  const builder = await agents.requireAgentKey(key);
  for (const bad of [undefined, "", "mh_agent_", key.slice(0, -1), key.replace(/_[^_]+$/, "_wrong"), key.replace("mh_agent_", "mh_agent_0")]) {
    await assert.rejects(agents.requireAgentKey(bad), /isn't valid/, String(bad));
  }

  // A crude agent pays its fee, answers questions only (no hunting), and is caught.
  const crude = await game.enterAgent({ key: builder, handle: "acme-crude" });
  assert.deepEqual([crude.agent, crude.total], [true, 5]);
  assert.deepEqual((await peek(crude)).payment, { mode: "mock", amountTokens: 100 });
  const caught = await play(game, crude, { how: "script" });
  assert.deepEqual(caught.result.impostor, { fooled: false });
  assert.equal(caught.result.prize, undefined);

  // A convincing one fools the judge and wins the prize, payable to its builder's wallet.
  const slick = await game.enterAgent({ key: builder, handle: "acme-slick" });
  const fooled = await play(game, slick);
  assert.deepEqual(fooled.result.impostor, { fooled: true });
  assert.deepEqual(fooled.result.prize, { tokens: 1000, symbol: "PLAY", payable: true });
  assert.deepEqual((await game.prizesOwed()).map((e) => [e.handle, e.prize!.reason, e.wallet]), [["acme-slick", "fooled", WALLET]]);

  // Both runs were revealed as agents the moment they were scored, whatever the judge thought.
  const runs = (await store.readTraining()).filter((e) => e.cohortId === "agents");
  assert.deepEqual(runs.map((e) => [e.handle, e.label, e.judgeCorrect]), [["acme-crude", "agent", true], ["acme-slick", "agent", false]]);

  // The agents' page shows them; the humans' page is untouched; payout wallets aren't public.
  const summary = await agents.agentSummary();
  assert.deepEqual([summary.fee, summary.prize, summary.runs, summary.fooled], [100, 1000, 2, 1]);
  assert.deepEqual(summary.board.map((r) => [r.handle, r.builder, r.fooled, r.won]), [["acme-slick", "Acme Labs", true, 1000], ["acme-crude", "Acme Labs", false, undefined]]);
  assert.ok(!JSON.stringify(summary).includes(WALLET));
  assert.deepEqual((await game.humanSummary()).board, humansBefore.board);

  // The house's own key: free runs that can't win, however well they do.
  const house = await agents.issueAgentKey({ name: "House", wallet: TREASURY });
  const houseKey = await agents.requireAgentKey(house.key);
  await agents.setAgentKey(houseKey.id, { house: true });
  const run = await game.enterAgent({ key: await agents.requireAgentKey(house.key), handle: "house-mimic" });
  assert.deepEqual((await peek(run)).payment, { mode: "waived", amountTokens: 0 });
  const houseResult = await play(game, run);
  assert.deepEqual([houseResult.result.impostor?.fooled, houseResult.result.prize], [true, undefined]);
  assert.equal((await agents.agentSummary()).board[0].house, true);

  // The owner can switch a key off.
  await agents.setAgentKey(builder.id, { disabled: true });
  await assert.rejects(agents.requireAgentKey(key), /switched off/);
});

test("the judge retrains itself once enough new runs have come in", async () => {
  const owner = await import("../owner");
  const store = await import("../store");
  const game = await import("../game");
  const agents = await import("../agents");

  // Not enough agents have been seen yet for a model.
  assert.equal(await owner.retrainIfDue(), false);
  const houseKey = Object.values(await store.readAgentKeys()).find((k) => k.house)!;
  for (let i = 0; i < 2; i++) await play(game, await game.enterAgent({ key: houseKey, handle: `house-early-${i}` }), { how: "script" });
  // Now there are five of each kind: a first model.
  assert.equal(await owner.retrainIfDue(), true);
  const first = (await store.readModelFile<{ trainedAt: number; examples: { human: number; agent: number } }>())!;
  assert.ok(first.examples.human >= 5 && first.examples.agent === 5);
  assert.equal(await owner.retrainIfDue(), false, "nothing new, so nothing to do");

  // Three more runs (RETRAIN_EVERY=3 here) and it is due again.
  for (let i = 0; i < 3; i++) await play(game, await game.enterAgent({ key: houseKey, handle: `house-${i}` }), { how: "script" });
  assert.equal(await owner.retrainIfDue(), true);
  const second = (await store.readModelFile<{ examples: { human: number; agent: number } }>())!;
  assert.equal(second.examples.agent, first.examples.agent + 3);

  const summary = await owner.ownerSummary();
  assert.equal(summary.runsUntilRetrain, 3);
  assert.deepEqual(summary.hunting.map((h) => h.level), [1, 2, 3]);
  assert.ok(summary.agentKeys.some((k) => k.house));
  void agents;
});

test("the owner's page opens only with the password or an unexpired pass", async () => {
  const owner = await import("../owner");
  owner.checkOwnerPassword("owner-dev", "1.1.1.1");
  assert.throws(() => owner.checkOwnerPassword("guess", "1.1.1.1"), /isn't right/);
  assert.throws(() => owner.checkOwnerPassword("", "1.1.1.1"), /isn't right/);
  assert.throws(() => owner.requireOwner(undefined), /locked/);

  const pass = owner.ownerPass().value;
  owner.requireOwner(pass);
  assert.throws(() => owner.requireOwner(pass.slice(0, -3) + "abc"), /locked/);
  const [, mac] = pass.split(".");
  assert.throws(() => owner.requireOwner(`${Math.floor(Date.now() / 1000) + 9_999_999}.${mac}`), /locked/, "expiry can't be extended");

  for (let i = 0; i < 8; i++) assert.throws(() => owner.checkOwnerPassword(`guess-${i}`, "9.9.9.9"), /isn't right/);
  assert.throws(() => owner.checkOwnerPassword("owner-dev", "9.9.9.9"), /Too many/);
});

// --- Payment verification ------------------------------------------------------

const MEMO = "pmh:2026-11-11:abc123";
const FEE = toRawAmount(1000, 6);
const expectation: PaymentExpectation = { wallet: WALLET, treasury: TREASURY, mint: MINT, memo: MEMO, amountRaw: FEE, notBefore: 1_000_000 };

function payment(overrides: { received?: bigint; memo?: string; signer?: string; err?: unknown; blockTime?: number; mint?: string; owner?: string } = {}): ParsedTxLike {
  const key = (s: string) => ({ toBase58: () => s });
  const mint = overrides.mint ?? MINT;
  const owner = overrides.owner ?? TREASURY;
  return {
    blockTime: overrides.blockTime ?? 1_000_500,
    meta: {
      err: overrides.err ?? null,
      preTokenBalances: [{ mint, owner, uiTokenAmount: { amount: "5000000" } }, { mint, owner: WALLET, uiTokenAmount: { amount: "9000000000" } }],
      postTokenBalances: [{ mint, owner, uiTokenAmount: { amount: (BigInt(5000000) + (overrides.received ?? FEE)).toString() } }],
    },
    transaction: {
      message: {
        accountKeys: [{ pubkey: key(overrides.signer ?? WALLET), signer: true }, { pubkey: key(TREASURY), signer: false }],
        instructions: [{ programId: key(MEMO_PROGRAM_ID.toBase58()), parsed: overrides.memo ?? MEMO }],
      },
    },
  };
}

test("whole tokens convert to base units exactly", () => {
  assert.equal(toRawAmount(1000, 6), BigInt("1000000000"));
  assert.equal(toRawAmount(0.5, 9), BigInt("500000000"));
  assert.equal(toRawAmount(1234567, 0), BigInt("1234567"));
});

test("a payment is accepted only if it is the right amount, token, payer, recipient and memo", () => {
  assert.deepEqual(checkPayment(payment(), expectation), { ok: true, receivedRaw: FEE });
  assert.equal(checkPayment(payment({ received: FEE + BigInt(5) }), expectation).ok, true);
  const rejected: [string, ParsedTxLike][] = [
    ["underpaid", payment({ received: FEE - BigInt(1) })],
    ["someone else's memo", payment({ memo: "pmh:2026-11-11:other" })],
    ["signed by another wallet", payment({ signer: TREASURY })],
    ["failed on-chain", payment({ err: { InstructionError: [1, "Custom"] } })],
    ["older than the entry request", payment({ blockTime: 999_000 })],
    ["a different token", payment({ mint: "So11111111111111111111111111111111111111112" })],
    ["paid to someone else", payment({ owner: WALLET })],
  ];
  for (const [what, tx] of rejected) assert.equal(checkPayment(tx, expectation).ok, false, `accepted a payment that was ${what}`);
});

test("wallet addresses are checked by shape, agreeing with the Solana library", async () => {
  const { isValidAddress } = await import("../payments/address");
  const library = (address: string) => {
    try {
      return new PublicKey(address).toBase58() === address;
    } catch {
      return false;
    }
  };
  const good = [WALLET, TREASURY, MINT, "11111111111111111111111111111111", "So11111111111111111111111111111111111111112"];
  const bad = ["", "nope", WALLET.slice(0, 20), WALLET + "1", WALLET.replace("4", "0"), "0x52908400098527886E0F7030069857D2E4169EE7"];
  for (const address of good) assert.equal(isValidAddress(address), true, address);
  for (const address of bad) assert.equal(isValidAddress(address), false, address);
  for (const address of [...good, ...bad, WALLET.slice(1), WALLET.slice(2), "1" + WALLET, TREASURY.slice(0, -1)]) {
    assert.equal(isValidAddress(address), library(address), address);
  }
});

test("the device is read from what the browser reports", async () => {
  const { deviceOf } = await import("../telemetry/features");
  const env = (ua: string, touchPoints: number, screen: [number, number]) =>
    ({ ua, webdriver: false, languages: [], tz: "", screen, viewport: screen, dpr: 1, touchPoints, cores: 4, plugins: 0 });
  assert.equal(deviceOf(env("Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Mobile/15E148 Safari/604.1", 5, [393, 852])), "phone");
  assert.equal(deviceOf(env("Mozilla/5.0 (Linux; Android 14; SM-X710) Chrome/140.0 Safari/537.36", 10, [800, 1280])), "tablet");
  assert.equal(deviceOf(env("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36", 10, [1920, 1080])), "desktop");
});
