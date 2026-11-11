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
    // Each record says which notice the player saw and which judge scored them.
    assert.equal(e.consent, "v2");
    assert.equal(e.judge.judgeVersion, "2");
  }
  // Nobody shares questions with anyone else.
  assert.notDeepEqual(examples[0].questions.map((q) => q.id), examples[1].questions.map((q) => q.id));

  // A reload mid-game or after it resumes where the player left off.
  const resumed = await game.sessionStatus(payer.token);
  assert.ok(resumed.done && resumed.result.score === payerResult.score);
});

test("every player is asked their own questions, written one at a time", async () => {
  const game = await import("../game");
  const { nextQuestion, QUESTION_PLAN } = await import("../interview");
  assert.deepEqual([...QUESTION_PLAN], ["fresh", "followup", "fresh", "followup", "draw"]);

  const a = await game.enter({ handle: "asker a" });
  const b = await game.enter({ handle: "asker b" });
  assert.equal(a.total, 5);
  assert.notEqual(a.question.id, b.question.id);

  // The next question doesn't exist until the current one is answered, and asking twice gives the same one.
  const store = await import("../store");
  const held = async () => (await store.readRound(a.roundId))!.entries[a.entryId].questions!.length;
  assert.equal(await held(), 1);
  const again = await game.sessionStatus(a.token);
  assert.ok(!again.done && again.question.id === a.question.id);

  const kinds = [a.question.kind];
  const prompts = [a.question.prompt];
  let question = a.question;
  for (let i = 0; i < 4; i++) {
    const out = await game.answer({ token: a.token, questionId: question.id, text: "the dishes obviously", telemetry: typed("the dishes obviously", [120, 90, 240]) });
    assert.ok(!out.done);
    assert.equal(out.index, i + 1);
    assert.equal(await held(), i + 2);
    question = out.question;
    kinds.push(question.kind);
    prompts.push(question.prompt);
  }
  assert.deepEqual(kinds, ["text", "text", "text", "text", "draw"]);
  assert.equal(new Set(prompts).size, 5, "a session never repeats a question");

  // Without the model, questions come from the bank and steer clear of what was already asked.
  const used = { question: { id: "x", kind: "text" as const, category: "petty", prompt: "What's a word or phrase you can't stand hearing?" }, answer: "moist" };
  for (let i = 0; i < 25; i++) {
    const q = await nextQuestion(1, [used]);
    assert.notEqual(q.prompt, used.question.prompt);
    assert.notEqual(q.category, "petty");
  }
  assert.equal((await nextQuestion(4, [])).kind, "draw");
});

const OWNER = { id: "owner", label: "ask" as const, password: "owner-dev", owner: true };

test("only the owner can say who a board player really was, and only the owner sees it", async () => {
  const game = await import("../game");
  const training = await import("../training");
  const before = await game.roundSummary();
  const board = await game.boardForLabelling();
  const payer = board.find((r) => r.handle === "payer one")!;
  assert.equal(payer.label, undefined);

  // Unfinished players and training sessions can't be labelled this way.
  const state = (await import("../store")).readRound(payer.roundId);
  const entries = Object.values((await state)!.entries);
  const sneaky = entries.find((e) => e.handle === "sneaky")!;
  const trainee = entries.find((e) => !e.prizeEligible)!;
  await assert.rejects(game.labelCompetitor({ roundId: payer.roundId, entryId: sneaky.id, label: "human", cohort: OWNER }), /hasn't been judged/);
  await assert.rejects(game.labelCompetitor({ roundId: payer.roundId, entryId: trainee.id, label: "human", cohort: OWNER }), /isn't on the public board/);
  await assert.rejects(game.labelCompetitor({ roundId: payer.roundId, entryId: payer.entryId, label: "robot", cohort: OWNER }), /human or agent/);

  const out = await game.labelCompetitor({ roundId: payer.roundId, entryId: payer.entryId, label: "human", cohort: OWNER });
  assert.equal(out.handle, "payer one");

  // It is training data now, with the judge's original blind verdict and the raw telemetry.
  const example = (await (await import("../store")).readTrainingFull()).find((e) => e.entryId === payer.entryId)!;
  assert.equal(example.label, "human");
  assert.equal(example.source, "board");
  assert.equal(example.judge.score, payer.score);
  assert.equal(Object.keys(example.telemetry).length, 5);

  // Nothing public changed, and the player's own result shows no label.
  assert.deepEqual(await game.roundSummary(), before);
  assert.ok(!JSON.stringify(before).includes("label"));

  // The owner sees the board and its labels. A friend with the training password sees neither.
  const forOwner = await training.trainingSummary(OWNER);
  assert.equal(forOwner.board.find((r) => r.entryId === payer.entryId)?.label, "human");
  assert.ok(forOwner.recent.some((r) => r.handle === "payer one" && r.fromBoard));
  const forFriend = await training.trainingSummary(TRAINERS);
  assert.equal(forFriend.owner, false);
  assert.deepEqual(forFriend.board, []);
  assert.ok(!JSON.stringify(forFriend.recent).includes("payer one"));
  // ...though it still counts toward the totals the model trains on.
  assert.equal(forFriend.human.total, forOwner.human.total);

  // Marking the same thing twice adds nothing; changing your mind replaces it.
  await game.labelCompetitor({ roundId: payer.roundId, entryId: payer.entryId, label: "human", cohort: OWNER });
  await game.labelCompetitor({ roundId: payer.roundId, entryId: payer.entryId, label: "agent", cohort: OWNER });
  const records = (await (await import("../store")).readTraining()).filter((e) => e.entryId === payer.entryId);
  assert.deepEqual(records.map((r) => r.label), ["agent"]);
  await game.labelCompetitor({ roundId: payer.roundId, entryId: payer.entryId, label: "human", cohort: OWNER });
});

test("the training room opens only with a valid password or an unexpired pass", async () => {
  const training = await import("../training");
  assert.equal(training.checkPassword("train-dev", "1.1.1.1").id, "trainers");
  assert.equal(training.checkPassword("housebot-dev", "1.1.1.1").label, "agent");
  assert.equal(training.checkPassword("owner-dev", "1.1.1.1").owner, true);
  assert.equal(training.checkPassword("train-dev", "1.1.1.1").owner, undefined);
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
  assert.equal(summary.human.total, 2); // one training session, one board player the owner vouched for
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

test("the device is read from what the browser reports", async () => {
  const { deviceOf } = await import("../telemetry/features");
  const env = (ua: string, touchPoints: number, screen: [number, number]) =>
    ({ ua, webdriver: false, languages: [], tz: "", screen, viewport: screen, dpr: 1, touchPoints, cores: 4, plugins: 0 });
  assert.equal(deviceOf(env("Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Mobile/15E148 Safari/604.1", 5, [393, 852])), "phone");
  assert.equal(deviceOf(env("Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/140.0 Mobile Safari/537.36", 5, [412, 915])), "phone");
  assert.equal(deviceOf(env("Mozilla/5.0 (Linux; Android 14; SM-X710) Chrome/140.0 Safari/537.36", 10, [800, 1280])), "tablet");
  assert.equal(deviceOf(env("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0 Safari/537.36", 0, [1512, 982])), "desktop");
  // A touchscreen laptop is still a desktop.
  assert.equal(deviceOf(env("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36", 10, [1920, 1080])), "desktop");
});

test("the agent bounty: keys, blind judging, automatic reveal, limits", async () => {
  const game = await import("../game");
  const agents = await import("../agents");
  const store = await import("../store");
  const before = await game.roundSummary();

  // One key per payout wallet, shown once, stored only as a hash.
  await assert.rejects(agents.issueAgentKey({ name: "x", wallet: WALLET }), /builder name/);
  await assert.rejects(agents.issueAgentKey({ name: "Acme Labs", wallet: "not-a-wallet" }), /Solana address/);
  const { key } = await agents.issueAgentKey({ name: "Acme Labs", wallet: WALLET });
  assert.match(key, /^mh_agent_[0-9a-f]{12}_.{20,}$/);
  await assert.rejects(agents.issueAgentKey({ name: "Other", wallet: WALLET }), /already has an agent key/);
  await assert.rejects(agents.issueAgentKey({ name: "acme labs", wallet: TREASURY }), /taken/);
  assert.ok(!JSON.stringify(await store.readAgentKeys()).includes(key.split("_").slice(3).join("_")), "the secret is not stored");

  // Only the real key works.
  const builder = await agents.requireAgentKey(key);
  assert.equal(builder.name, "Acme Labs");
  for (const bad of [undefined, "", "mh_agent_", key.slice(0, -1), key.replace(/_[^_]+$/, "_wrong"), key.replace("mh_agent_", "mh_agent_0")]) {
    await assert.rejects(agents.requireAgentKey(bad), /isn't valid/, String(bad));
  }

  // An agent plays the ordinary game. Its result says whether it fooled the judge, and where it ranks among agents.
  const session = await game.enterAgent({ key: builder, handle: "acme-run-1" });
  assert.equal(session.agent, true);
  assert.equal(session.training, false);
  const result = await playThrough(game, session);
  assert.equal(result.impostor?.fooled, result.score >= 50);
  assert.equal(result.impostor?.rank, 1);
  assert.equal(result.rank, undefined);

  // It never touches the players' board or pool...
  assert.deepEqual(await game.roundSummary(), before);
  // ...it is on the agents' board under its builder's name...
  const summary = await agents.bountySummary();
  assert.deepEqual(summary.board.map((r) => [r.handle, r.builder, r.fooled]), [["acme-run-1", "Acme Labs", result.score >= 50]]);
  assert.equal(summary.board[0].leading, result.score >= 50);
  assert.ok(!JSON.stringify(summary).includes(WALLET), "the public board doesn't show payout wallets");
  // ...and it was revealed as an agent the moment it was scored.
  const example = (await store.readTraining()).find((e) => e.handle === "acme-run-1")!;
  assert.equal(example.label, "agent");
  assert.equal(example.cohortId, "agents");

  // The bounty goes only to an agent the judge took for human.
  const state = (await store.readRound(session.roundId))!;
  assert.equal(game.bountyLeader(state)?.id, result.score >= 50 ? session.entryId : undefined);
  const entry = state.entries[session.entryId];
  entry.result!.score = 49.9;
  assert.equal(game.bountyLeader(state), undefined);
  entry.result!.score = 50;
  assert.equal(game.bountyLeader(state)?.id, session.entryId);

  // A key gets a fixed number of runs a day, and the owner can switch a key off.
  for (let i = 2; i <= 5; i++) await game.enterAgent({ key: builder, handle: `acme-run-${i}` });
  await assert.rejects(game.enterAgent({ key: builder, handle: "acme-run-6" }), /used its 5 entries/);
  const owner = await agents.agentKeysForOwner();
  assert.deepEqual(owner.map((k) => [k.name, k.wallet, k.entriesToday, k.disabled]), [["Acme Labs", WALLET, 5, false]]);
  await agents.setAgentKeyDisabled(builder.id, true);
  await assert.rejects(agents.requireAgentKey(key), /switched off/);
  await agents.setAgentKeyDisabled(builder.id, false);
  assert.equal((await agents.requireAgentKey(key)).id, builder.id);
});
