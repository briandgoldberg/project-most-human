import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config, type Cohort } from "./config";
import { judgeEntry } from "./judge";
import { llmWriteQuestions } from "./judge/llm";
import { isValidAddress } from "./payments/address";
import { MAX_ANSWER_CHARS, TEXT_QUESTIONS_PER_ROUND, bankQuestionsFor, drawQuestionFor } from "./questions";
import { appendTraining, readRound, readTelemetry, saveTelemetry, updateRound } from "./store";
import { aggregateFeatures, extractAnswerFeatures } from "./telemetry/features";
import { sanitizeTelemetry } from "./telemetry/sanitize";
import type { Entry, EntryPayment, JudgeResult, Kind, PaymentIntent, Question, Round, RoundState } from "./types";

/**
 * The game has two doors into the same judge:
 *
 *   The daily competition (public). Players pay the entry fee, answer the
 *   day's questions, and the top score takes the pool. Nobody here is labelled.
 *
 *   The training room (private, password-gated). The owner, their friends and
 *   the house bots play free sessions whose truth (human or agent) is known.
 *   The judge scores them exactly as it scores the public, without being told
 *   which they are; the truth is attached only after the score is final, and
 *   the pair is saved as training data.
 */

export class GameError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// The Solana libraries are large and only needed when real fees are switched on,
// so they are loaded on first use rather than with every request.
const solana = () => import("./payments/solana");

const DAY_MS = 24 * 60 * 60 * 1000;
const INTENT_TTL_MS = 20 * 60 * 1000;
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,19}$/;

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

/** A round is one UTC day. */
export function roundIdFor(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function createRound(roundId: string): Promise<RoundState> {
  const cfg = config();
  const startsAt = Date.parse(`${roundId}T00:00:00Z`);
  let questions = bankQuestionsFor(roundId, cfg.questionSalt);
  let questionSource: Round["questionSource"] = "bank";

  if (cfg.questionSource === "llm" && cfg.judge.llmEnabled) {
    try {
      const yesterday = await readRound(roundIdFor(startsAt - DAY_MS));
      const avoid = yesterday?.round.questions.filter((q) => q.kind === "text").map((q) => q.prompt) ?? [];
      const written = await llmWriteQuestions(roundId, TEXT_QUESTIONS_PER_ROUND, avoid);
      questions = [
        ...written.map((q, i): Question => ({ ...q, id: `${roundId}-q${i + 1}`, kind: "text" })),
        drawQuestionFor(roundId, cfg.questionSalt),
      ];
      questionSource = "llm";
    } catch (err) {
      console.error(`[round ${roundId}] question writer failed; using the question bank:`, err);
    }
  }

  return {
    round: { id: roundId, startsAt, endsAt: startsAt + DAY_MS, questions, questionSource, createdAt: Date.now() },
    entries: {},
    intents: {},
    signatures: {},
  };
}

function withRound<T>(roundId: string, fn: (state: RoundState) => T | Promise<T>): Promise<T> {
  return updateRound(roundId, fn, () => createRound(roundId));
}

/** The questions this entry is answering: its own draw in the training room, otherwise the day's set. */
const questionsOf = (state: RoundState, entry: Entry): Question[] => entry.questions ?? state.round.questions;

/** Competition entries only. Training sessions never count toward the pool or the board. */
const competitors = (state: RoundState): Entry[] => Object.values(state.entries).filter((e) => e.prizeEligible);

export function poolTokens(state: RoundState): number {
  const gross = competitors(state).reduce((sum, e) => sum + e.payment.amountTokens, 0);
  return Math.floor(gross * (1 - config().rakeBps / 10_000) * 1e6) / 1e6;
}

/** Scored competition entries, best first. Ties go to whoever finished earlier. */
export function ranked(state: RoundState): Entry[] {
  return competitors(state)
    .filter((e) => e.status === "scored" && e.result)
    .sort((a, b) => b.result!.score - a.result!.score || a.result!.scoredAt - b.result!.scoredAt);
}

/** The entry currently in line for the pool. */
export function leader(state: RoundState): Entry | undefined {
  return ranked(state)[0];
}

// ---------------------------------------------------------------------------
// Public view of the competition
// ---------------------------------------------------------------------------

const shortWallet = (w?: string) => (w ? `${w.slice(0, 4)}…${w.slice(-4)}` : undefined);

export async function roundSummary(roundId = roundIdFor()) {
  const cfg = config();
  let state = await readRound(roundId);
  if (!state && roundId === roundIdFor()) state = await withRound(roundId, (s) => s);
  if (!state) throw new GameError(404, "no_round", "No such round");
  const board = ranked(state);
  return {
    roundId,
    endsAt: state.round.endsAt,
    open: Date.now() < state.round.endsAt,
    questionCount: state.round.questions.length,
    entrants: competitors(state).length,
    scored: board.length,
    pool: poolTokens(state),
    entryFee: cfg.entryFeeTokens,
    symbol: cfg.tokenSymbol,
    paymentMode: cfg.paymentMode,
    cluster: cfg.paymentMode === "solana" ? cfg.solana.cluster : undefined,
    sessionMinutes: cfg.sessionMinutes,
    payout: state.payout,
    leaderboard: board.slice(0, 100).map((e, i) => ({
      rank: i + 1,
      handle: e.handle,
      score: e.result!.score,
      quip: e.result!.quip,
      wallet: shortWallet(e.wallet),
    })),
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface Session {
  token: string;
  roundId: string;
  entryId: string;
  handle: string;
  training: boolean;
  question: Question;
  index: number;
  total: number;
  expiresAt: number;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const randomId = (bytes: number) => randomBytes(bytes).toString("base64url");
const sameHandle = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function cleanHandle(raw: unknown): string {
  const handle = (typeof raw === "string" ? raw : "").trim().replace(/\s+/g, " ");
  if (!HANDLE.test(handle)) {
    throw new GameError(400, "bad_handle", "Pick a name of 2 to 20 letters, numbers, spaces, or . _ -");
  }
  return handle;
}

function issueToken(entry: Entry): string {
  const secret = randomId(24);
  entry.tokenHash = sha256(secret);
  return `${entry.roundId}.${entry.id}.${secret}`;
}

function sessionFor(state: RoundState, entry: Entry, token: string): Session {
  const questions = questionsOf(state, entry);
  return {
    token,
    roundId: entry.roundId,
    entryId: entry.id,
    handle: entry.handle,
    training: !entry.prizeEligible,
    question: questions[entry.progress],
    index: entry.progress,
    total: questions.length,
    expiresAt: entry.createdAt + config().sessionMinutes * 60_000,
  };
}

interface NewEntry {
  handle: string;
  wallet?: string;
  payment: EntryPayment;
  training?: { cohort: Cohort; label: Kind };
  userAgent?: string;
}

function addEntry(state: RoundState, input: NewEntry): Session {
  const now = Date.now();
  const id = randomId(9);
  const entry: Entry = {
    id,
    roundId: state.round.id,
    handle: input.handle,
    wallet: input.wallet,
    createdAt: now,
    tokenHash: "",
    payment: input.payment,
    cohortId: input.training?.cohort.id,
    label: input.training?.label,
    // Trainers play many sessions a day, so each gets a fresh draw from the bank.
    questions: input.training ? bankQuestionsFor(`${state.round.id}:${id}`, config().questionSalt) : undefined,
    prizeEligible: !input.training,
    status: "playing",
    progress: 0,
    servedAt: [now],
    answers: [],
    userAgent: input.userAgent?.slice(0, 300),
  };
  const token = issueToken(entry);
  state.entries[entry.id] = entry;
  return sessionFor(state, entry, token);
}

// ---------------------------------------------------------------------------
// Entering the daily competition
// ---------------------------------------------------------------------------

export interface EnterInput {
  handle: string;
  wallet?: string;
  /** Paid path: the round and intent the payment was made for, and its signature. */
  roundId?: string;
  intentId?: string;
  signature?: string;
  userAgent?: string;
}

function handleTaken(state: RoundState, handle: string, exceptWallet?: string): boolean {
  if (competitors(state).some((e) => sameHandle(e.handle, handle))) return true;
  // A handle is also held while someone else is mid-payment for it.
  return Object.values(state.intents).some(
    (i) =>
      !i.usedByEntry &&
      i.wallet !== exceptWallet &&
      sameHandle(i.handle, handle) &&
      Date.now() - i.createdAt < INTENT_TTL_MS,
  );
}

export async function enter(input: EnterInput): Promise<Session> {
  const cfg = config();
  const handle = cleanHandle(input.handle);
  const wallet = input.wallet?.trim() || undefined;
  if (wallet && !isValidAddress(wallet)) throw new GameError(400, "bad_wallet", "That isn't a valid Solana address");

  const base = { handle, wallet, userAgent: input.userAgent };
  const guard = (state: RoundState, exceptWallet?: string) => {
    if (Date.now() >= state.round.endsAt + INTENT_TTL_MS) throw new GameError(410, "round_closed", "This round has closed");
    if (handleTaken(state, handle, exceptWallet)) throw new GameError(409, "handle_taken", "That handle is taken today");
    if (wallet && competitors(state).some((e) => e.wallet === wallet)) {
      throw new GameError(409, "wallet_entered", "This wallet has already entered today's round");
    }
  };

  // --- Test mode: play tokens, nothing to pay --------------------------------
  if (cfg.paymentMode === "mock") {
    return withRound(roundIdFor(), (state) => {
      guard(state);
      return addEntry(state, { ...base, payment: { mode: "mock", amountTokens: cfg.entryFeeTokens } });
    });
  }

  // --- Solana ---------------------------------------------------------------
  if (!wallet) throw new GameError(400, "wallet_required", "Connect a wallet to pay the entry fee");

  if (!input.signature) {
    // Step 1: reserve the handle and hand back a transaction to sign.
    const { solanaSetup, toRawAmount, buildEntryTransaction } = await solana();
    const { decimals } = await solanaSetup();
    const amountRaw = toRawAmount(cfg.entryFeeTokens, decimals);
    const roundId = roundIdFor();
    const intent = await withRound(roundId, (state) => {
      guard(state, wallet);
      const id = randomId(9);
      const created: PaymentIntent = {
        id,
        wallet,
        handle,
        memo: `pmh:${roundId}:${id}`,
        amountRaw: amountRaw.toString(),
        createdAt: Date.now(),
      };
      state.intents[id] = created;
      return created;
    });
    const transaction = await buildEntryTransaction(wallet, intent.memo, amountRaw);
    throw new GameError(402, "payment_required", "Pay the entry fee to play", {
      payment: {
        roundId,
        intentId: intent.id,
        transaction,
        memo: intent.memo,
        amount: cfg.entryFeeTokens,
        symbol: cfg.tokenSymbol,
        cluster: cfg.solana.cluster,
        mint: cfg.solana.mint,
        treasury: cfg.solana.treasury,
      },
    });
  }

  // Step 2: the player says they paid. Check the chain before believing it.
  const roundId = input.roundId ?? roundIdFor();
  const signature = input.signature.trim();
  const before = await readRound(roundId);
  const intent = input.intentId ? before?.intents[input.intentId] : undefined;
  if (!before || !intent || intent.wallet !== wallet) {
    throw new GameError(400, "bad_intent", "That payment request isn't known. Start the entry again.");
  }

  const reissue = (state: RoundState): Session | null => {
    // The same payment presented again (e.g. the first response was lost):
    // hand back a fresh token as long as play hasn't started.
    const existing = state.entries[state.signatures[signature] ?? ""];
    if (!existing) return null;
    if (existing.wallet !== wallet || existing.payment.intentId !== intent.id || existing.progress > 0 || existing.status !== "playing") {
      throw new GameError(409, "payment_used", "That payment has already been used for an entry");
    }
    return sessionFor(state, existing, issueToken(existing));
  };

  if (before.signatures[signature]) {
    return withRound(roundId, (state) => {
      const again = reissue(state);
      if (!again) throw new GameError(409, "payment_used", "That payment has already been used for an entry");
      return again;
    });
  }
  if (intent.usedByEntry) throw new GameError(409, "intent_used", "That payment request was already completed");

  const { verifyEntryPayment } = await solana();
  const check = await verifyEntryPayment(signature, {
    wallet,
    memo: intent.memo,
    amountRaw: BigInt(intent.amountRaw),
    notBefore: Math.floor(intent.createdAt / 1000) - 120,
  });
  if (!check.ok) throw new GameError(402, "payment_unverified", check.reason);

  return withRound(roundId, (state) => {
    const again = reissue(state);
    if (again) return again;
    const live = state.intents[intent.id];
    if (!live || live.usedByEntry) throw new GameError(409, "intent_used", "That payment request was already completed");
    const session = addEntry(state, {
      ...base,
      handle: live.handle,
      payment: {
        mode: "solana",
        amountTokens: cfg.entryFeeTokens,
        amountRaw: check.receivedRaw.toString(),
        signature,
        intentId: live.id,
      },
    });
    live.usedByEntry = session.entryId;
    state.signatures[signature] = session.entryId;
    return session;
  });
}

// ---------------------------------------------------------------------------
// Starting a training session
// ---------------------------------------------------------------------------

/**
 * Start a free, labelled session in the training room. The caller has already
 * proved membership of `cohort`. Names can repeat: trainers play many times.
 */
export async function enterTraining(input: {
  cohort: Cohort;
  handle: unknown;
  declaredKind?: unknown;
  userAgent?: string;
}): Promise<Session> {
  const handle = cleanHandle(input.handle);
  let label: Kind;
  if (input.cohort.label === "ask") {
    if (input.declaredKind !== "human" && input.declaredKind !== "agent") {
      throw new GameError(400, "declare_kind", "Say whether this session is a human or an AI agent");
    }
    label = input.declaredKind;
  } else {
    label = input.cohort.label;
  }
  return withRound(roundIdFor(), (state) =>
    addEntry(state, {
      handle,
      payment: { mode: "waived", amountTokens: 0 },
      training: { cohort: input.cohort, label },
      userAgent: input.userAgent,
    }),
  );
}

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

function parseToken(token: unknown): { roundId: string; entryId: string; secret: string } {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) throw new GameError(401, "bad_token", "Invalid session");
  return { roundId: parts[0], entryId: parts[1], secret: parts[2] };
}

function authorise(state: RoundState | null, entryId: string, secret: string): Entry {
  const entry = state?.entries[entryId];
  const given = Buffer.from(sha256(secret), "hex");
  const stored = Buffer.from(entry?.tokenHash ?? "", "hex");
  if (!entry || stored.length !== given.length || !timingSafeEqual(given, stored)) {
    throw new GameError(401, "bad_token", "Invalid session");
  }
  return entry;
}

export interface PlayerResult {
  score: number;
  verdict: Kind;
  quip: string;
  roundId: string;
  handle: string;
  /** Competition entries: place on today's board. */
  rank?: number;
  scored?: number;
  /** Training sessions: what the player really was, shown to them once the judge has committed. */
  training?: { truth: Kind; judgeCorrect: boolean };
}

function playerResult(state: RoundState, entry: Entry): PlayerResult {
  const result = entry.result!;
  const base = { score: result.score, verdict: result.verdict, quip: result.quip, roundId: entry.roundId, handle: entry.handle };
  if (entry.label) return { ...base, training: { truth: entry.label, judgeCorrect: result.verdict === entry.label } };
  const board = ranked(state);
  return { ...base, rank: board.findIndex((e) => e.id === entry.id) + 1, scored: board.length };
}

/** Judge a finished entry, record the result, and file it as training data if its truth is known. */
async function score(roundId: string, entryId: string): Promise<PlayerResult> {
  const state = await readRound(roundId);
  const entry = state?.entries[entryId];
  if (!state || !entry) throw new GameError(404, "no_entry", "Entry not found");

  // The judge gets the questions, the answers and the behaviour readings.
  // It is not given the label, the cohort, the handle or the wallet.
  const features = aggregateFeatures(entry.answers, entry.env, entry.userAgent);
  const result: JudgeResult = await judgeEntry(questionsOf(state, entry), { id: entry.id, answers: entry.answers }, features);

  const { finalState, scoredNow } = await withRound(roundId, (s) => {
    const e = s.entries[entryId];
    // Two requests can race to score the same entry; the first result stands.
    const first = e.status !== "scored";
    if (first) {
      e.features = features;
      e.result = result;
      e.status = "scored";
    }
    return { finalState: s, scoredNow: first };
  });
  const scored = finalState.entries[entryId];

  // The reveal: only now that the verdict is locked in does the truth meet it.
  if (scoredNow && scored.label && scored.cohortId) {
    await appendTraining({
      entryId,
      roundId,
      recordedAt: Date.now(),
      label: scored.label,
      cohortId: scored.cohortId,
      handle: scored.handle,
      questions: questionsOf(finalState, scored),
      answers: scored.answers.map(({ questionId, text, serverLatencyMs, features: f }) => ({
        questionId,
        text,
        serverLatencyMs,
        features: f,
      })),
      features,
      env: scored.env,
      judge: scored.result!,
      judgeCorrect: scored.result!.verdict === scored.label,
      telemetry: await readTelemetry(roundId, entryId),
    });
  }
  return playerResult(finalState, scored);
}

export type AnswerOutcome =
  | { done: false; question: Question; index: number; total: number }
  | { done: true; result: PlayerResult };

export async function answer(input: {
  token: unknown;
  questionId: unknown;
  text: unknown;
  telemetry: unknown;
}): Promise<AnswerOutcome> {
  const { roundId, entryId, secret } = parseToken(input.token);
  const telemetry = sanitizeTelemetry(input.telemetry);
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const now = Date.now();

  const step = await updateRound(roundId, (state) => {
    const entry = authorise(state, entryId, secret);
    if (entry.status !== "playing") throw new GameError(409, "already_finished", "This entry is already finished");
    if (now > entry.createdAt + config().sessionMinutes * 60_000) {
      throw new GameError(410, "session_expired", "Time ran out on this entry");
    }
    const questions = questionsOf(state, entry);
    const question = questions[entry.progress];
    if (input.questionId !== question.id) {
      throw new GameError(409, "wrong_question", "That isn't the current question", {
        question,
        index: entry.progress,
        total: questions.length,
      });
    }
    if (question.kind === "text") {
      if (!text) throw new GameError(400, "empty_answer", "Say something");
      if (text.length > MAX_ANSWER_CHARS) {
        throw new GameError(400, "too_long", `Keep it under ${MAX_ANSWER_CHARS} characters`);
      }
    } else if (!telemetry.strokes?.length) {
      throw new GameError(400, "empty_drawing", "Draw something first");
    }

    const answerText = question.kind === "text" ? text : "";
    entry.answers.push({
      questionId: question.id,
      text: answerText,
      answeredAt: now,
      serverLatencyMs: now - entry.servedAt[entry.progress],
      features: extractAnswerFeatures(question.kind, answerText, telemetry),
    });
    if (telemetry.env) entry.env = telemetry.env;
    entry.progress++;

    if (entry.progress < questions.length) {
      entry.servedAt.push(Date.now());
      return {
        done: false as const,
        question: questions[entry.progress],
        index: entry.progress,
        total: questions.length,
        questionId: question.id,
      };
    }
    entry.status = "scoring";
    return { done: true as const, questionId: question.id };
  }).catch((err) => {
    if (err instanceof GameError) throw err;
    if (/does not exist|Invalid round/.test(String(err))) throw new GameError(401, "bad_token", "Invalid session");
    throw err;
  });

  await saveTelemetry(roundId, entryId, step.questionId, telemetry);
  if (!step.done) return { done: false, question: step.question, index: step.index, total: step.total };
  return { done: true, result: await score(roundId, entryId) };
}

/** Where a session stands: the current question, or the result. Also finishes scoring that was interrupted. */
export async function sessionStatus(token: unknown): Promise<AnswerOutcome> {
  const { roundId, entryId, secret } = parseToken(token);
  const state = await readRound(roundId);
  const entry = authorise(state, entryId, secret);
  if (entry.status === "scored") return { done: true, result: playerResult(state!, entry) };
  if (entry.status === "scoring") return { done: true, result: await score(roundId, entryId) };
  const questions = questionsOf(state!, entry);
  return { done: false, question: questions[entry.progress], index: entry.progress, total: questions.length };
}
