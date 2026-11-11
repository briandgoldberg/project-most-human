import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { MEMO_PROGRAM_ID, checkPayment, toRawAmount, type ParsedTxLike, type PaymentExpectation } from "../payments/solana";
import { bankQuestionsFor } from "../questions";
import type { AnswerTelemetry, Question, TrainingExample } from "../types";
import { typed } from "./fixtures";

// Each test file gets its own empty data directory.
const dataDir = mkdtempSync(path.join(tmpdir(), "pmh-test-"));
process.env.PMH_DATA_DIR = dataDir;
process.env.PAYMENT_MODE = "mock";
process.env.JUDGE_LLM = "off";
process.env.ENTRY_FEE_TOKENS = "1000";

test("a day's questions are stable, and different from the next day's", () => {
  const today = bankQuestionsFor("2026-11-11");
  assert.deepEqual(today, bankQuestionsFor("2026-11-11"));
  assert.equal(today.length, 5);
  assert.equal(today.filter((q) => q.kind === "draw").length, 1);
  assert.equal(new Set(today.map((q) => q.category)).size, 5);
  assert.notDeepEqual(today.map((q) => q.prompt), bankQuestionsFor("2026-11-12").map((q) => q.prompt));
});

function drawing(): AnswerTelemetry {
  const raw = typed("", [100]);
  raw.strokes = [Array.from({ length: 30 }, (_, i) => [3000 + i * (12 + (i % 5) * 4), 100 + 60 * Math.cos(i / 5), 100 + 60 * Math.sin(i / 5), 0.5] as [number, number, number, number])];
  raw.submittedAt = 4500;
  return raw;
}

async function playThrough(game: typeof import("../game"), session: { token: string; question: Question }) {
  let question = session.question;
  for (;;) {
    const telemetry = question.kind === "draw" ? drawing() : typed("the dishes obviously", [120, 90, 240, 150, 1700, 110]);
    const out = await game.answer({ token: session.token, questionId: question.id, text: "the dishes obviously", telemetry });
    if (out.done) return out.result;
    question = out.question;
  }
}

const TRAINERS = { id: "trainers", label: "ask" as const, password: "train-dev" };
const HOUSE_BOTS = { id: "house-bots", label: "agent" as const, password: "housebot-dev" };

test("the competition and the training room share a judge but nothing else", async () => {
  const game = await import("../game");

  // One paying player in the public competition; a human and two agent sessions in the training room.
  const payer = await game.enter({ handle: "payer one" });
  const human = await game.enterTraining({ cohort: TRAINERS, handle: "brian", declaredKind: "human" });
  const friendBot = await game.enterTraining({ cohort: TRAINERS, handle: "brian", declaredKind: "agent" });
  const houseBot = await game.enterTraining({ cohort: HOUSE_BOTS, handle: "mimic", declaredKind: "human" });
  assert.equal(payer.training, false);
  assert.equal(human.training, true);

  await assert.rejects(game.enter({ handle: "PAYER ONE" }), /taken/);
  await assert.rejects(game.enter({ handle: "x" }), /2 to 20/);
  await assert.rejects(game.enterTraining({ cohort: TRAINERS, handle: "someone" }), /human or an AI agent/);
  // The public door has no way to create a labelled or free session.
  const sneaky = await game.enter({ handle: "sneaky", code: "train-dev", password: "train-dev", declaredKind: "human" } as never);
  assert.equal(sneaky.training, false);

  // Questions must be answered in the order served, with a valid token.
  await assert.rejects(
    game.answer({ token: payer.token, questionId: "not-the-question", text: "hi", telemetry: {} }),
    (err: { code?: string }) => err.code === "wrong_question",
  );
  await assert.rejects(
    game.answer({ token: payer.token.slice(0, -2) + "zz", questionId: payer.question.id, text: "hi", telemetry: {} }),
    (err: { code?: string }) => err.code === "bad_token",
  );

  const payerResult = await playThrough(game, payer);
  const humanResult = await playThrough(game, human);
  await playThrough(game, friendBot);
  const houseResult = await playThrough(game, houseBot);
  assert.ok(payerResult.score >= 0 && payerResult.score <= 100);
  await assert.rejects(
    game.answer({ token: payer.token, questionId: payer.question.id, text: "again", telemetry: {} }),
    (err: { code?: string }) => err.code === "already_finished",
  );

  // Competitors get a rank and no reveal; trainers get the reveal and no rank.
  assert.equal(payerResult.rank, 1);
  assert.equal(payerResult.training, undefined);
  assert.equal(humanResult.rank, undefined);
  assert.equal(humanResult.training?.truth, "human");
  // The house-bot password always means agent, whatever the session claims.
  assert.equal(houseResult.training?.truth, "agent");

  // The public board and pool see only the competition.
  const summary = await game.roundSummary();
  assert.equal(summary.entrants, 2);
  assert.equal(summary.pool, 2000);
  assert.deepEqual(summary.leaderboard.map((r) => r.handle), ["payer one"]);
  const publicView = JSON.stringify(summary);
  for (const hidden of ["brian", "mimic", "label", "cohort", "trainers"]) {
    assert.ok(!publicView.includes(hidden), `public round data mentions "${hidden}"`);
  }

  // The reveal: every training session, and only those, is now a labelled example with its raw telemetry.
  const file = path.join(dataDir, "training", readdirSync(path.join(dataDir, "training"))[0]);
  const examples = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as TrainingExample);
  assert.deepEqual(examples.map((e) => `${e.handle}:${e.label}`).sort(), ["brian:agent", "brian:human", "mimic:agent"]);
  for (const e of examples) {
    assert.equal(Object.keys(e.telemetry).length, 5);
    assert.equal(e.judgeCorrect, e.judge.verdict === e.label);
  }
  // Training sessions draw their own questions, so repeat sessions don't see the same set.
  assert.notDeepEqual(examples[0].questions.map((q) => q.id), examples[1].questions.map((q) => q.id));

  // A reload mid-game or after it resumes where the player left off.
  const resumed = await game.sessionStatus(payer.token);
  assert.ok(resumed.done && resumed.result.score === payerResult.score);
});

test("the training room opens only with a valid password or an unexpired pass", async () => {
  const training = await import("../training");
  assert.equal(training.checkPassword("train-dev", "1.1.1.1").id, "trainers");
  assert.equal(training.checkPassword("housebot-dev", "1.1.1.1").label, "agent");
  assert.throws(() => training.checkPassword("guess", "1.1.1.1"), /isn't right/);
  assert.throws(() => training.requireCohort(undefined, undefined, "1.1.1.1"), /locked/);

  const pass = training.trainingPass(TRAINERS).value;
  assert.equal(training.cohortFromPass(pass)?.id, "trainers");
  assert.equal(training.cohortFromPass(pass.replace("trainers", "house-bots")), undefined, "pass can't be moved to another cohort");
  assert.equal(training.cohortFromPass(pass.slice(0, -3) + "abc"), undefined);
  const [id, , mac] = pass.split(".");
  assert.equal(training.cohortFromPass(`${id}.${Math.floor(Date.now() / 1000) + 9_999_999}.${mac}`), undefined, "expiry can't be extended");

  // Guessing is cut off after a handful of misses from one address.
  for (let i = 0; i < 8; i++) assert.throws(() => training.checkPassword(`guess-${i}`, "9.9.9.9"), /isn't right/);
  assert.throws(() => training.checkPassword("train-dev", "9.9.9.9"), /Too many/);

  const summary = await training.trainingSummary(TRAINERS);
  assert.equal(summary.human.total, 1);
  assert.equal(summary.agent.total, 2);
  assert.equal(summary.canTrain, false);
  await assert.rejects(training.retrain(), /Need at least 5/);
});

// --- Payment verification ------------------------------------------------------

const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const TREASURY = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
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
  for (const [what, tx] of rejected) {
    assert.equal(checkPayment(tx, expectation).ok, false, `accepted a payment that was ${what}`);
  }
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
  // Including near-misses whose validity isn't obvious by eye.
  for (const address of [...good, ...bad, WALLET.slice(1), WALLET.slice(2), "1" + WALLET, TREASURY.slice(0, -1)]) {
    assert.equal(isValidAddress(address), library(address), address);
  }
});
