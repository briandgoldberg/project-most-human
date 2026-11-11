import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { HUNT_LEVELS, clearHuntCache, huntScore, huntingAvailable, nextHunt } from "./hunt";
import { QUESTION_PLAN, gamePlan, nextQuestion } from "./interview";
import { judgeEntry } from "./judge";
import { isValidAddress } from "./payments/address";
import { MAX_ANSWER_CHARS, bankQuestionsFor } from "./questions";
import { appendHuntRecord, appendTraining, readRound, readTelemetry, saveTelemetry, updateRound } from "./store";
import { aggregateFeatures, deviceOf, extractAnswerFeatures } from "./telemetry/features";
import { sanitizeTelemetry } from "./telemetry/sanitize";
import type { AgentKey, Entry, EntryPayment, Hunt, JudgeResult, Kind, PaymentIntent, Question, RoundState, StepKind } from "./types";

/**
 * The game has two sides and one judge, and it never closes.
 *
 *   The human side (/). A player answers questions that show they are a
 *   person, and in between hunts bots: picking the real person's answer out of
 *   a pair, round after round, until they miss. Clear enough rounds and they
 *   win the hunter prize. If the judge takes a player for a bot, their game is
 *   cancelled: no board, no prize.
 *
 *   The bot side (/agents). Builders send agents, with a key and for a fee,
 *   to pass as people. An agent the judge takes for human wins a prize.
 *
 * The judge scores everyone the same way and is never told which side they
 * came in on. What it learns from, it learns afterwards:
 *   - an agent is known to be an agent, because it holds a key;
 *   - a player it was confident about is taken to be human.
 * Both are saved as training examples once the score is final, and players'
 * answers become the material other players hunt with.
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

/**
 * The wording of the data notice shown at entry. Change this when the notice
 * changes, so every session records which one its player saw.
 *   v2: recordings may be kept and used for research and datasets.
 *   v3: answers may also be shown, without a name, to other players.
 */
export const CONSENT_VERSION = "v3";

/** At or above this the judge takes a player for a person; below it, for a bot. */
export const HUMAN_AT = 50;
/** A player the judge scores at least this is taken to be human for training, and their answers may be hunted with. */
export const CONFIDENT_HUMAN_AT = 60;
/** Cohort names under which examples are filed. */
export const AGENT_COHORT = "agents";
export const PLAYER_COHORT = "players";

const DAY_MS = 24 * 60 * 60 * 1000;
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,19}$/;

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/**
 * The game is continuous, but its records are kept one document per UTC day
 * so no single document grows without end. ("Round" in the names below is
 * left over from when each day was a separate contest.)
 */
export function roundIdFor(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function createRound(roundId: string): Promise<RoundState> {
  const startsAt = Date.parse(`${roundId}T00:00:00Z`);
  return {
    round: {
      id: roundId,
      startsAt,
      endsAt: startsAt + DAY_MS,
      // Players each get their own questions (see interview.ts). This shared set
      // is kept only so entries from before that change can still be read.
      questions: bankQuestionsFor(roundId, config().questionSalt),
      questionSource: "bank",
      createdAt: Date.now(),
    },
    entries: {},
    intents: {},
    signatures: {},
  };
}

function withRound<T>(roundId: string, fn: (state: RoundState) => T | Promise<T>): Promise<T> {
  return updateRound(roundId, fn, () => createRound(roundId));
}

/** The questions this entry has been asked so far. */
const questionsOf = (state: RoundState, entry: Entry): Question[] => entry.questions ?? state.round.questions;

/** The steps of this entry's game, in order. */
function planOf(state: RoundState, entry: Entry): StepKind[] {
  if (entry.plan) return entry.plan;
  if (entry.adaptive) return [...QUESTION_PLAN];
  return questionsOf(state, entry).map((q) => (q.kind === "draw" ? "draw" : "fresh"));
}

/** How many steps this entry has completed. */
const stepOf = (entry: Entry): number => entry.answers.length + (entry.hunts ?? []).filter((h) => h.pick !== undefined).length;

/** Everything finished in the last `days` days, most recent first. */
async function recentEntries(days: number): Promise<Entry[]> {
  const states = await Promise.all(Array.from({ length: days }, (_, i) => readRound(roundIdFor(Date.now() - i * DAY_MS))));
  return states
    .flatMap((s) => Object.values(s?.entries ?? {}))
    .filter((e) => e.status === "scored" && e.result)
    .sort((a, b) => b.result!.scoredAt - a.result!.scoredAt);
}

/** Players whose games stand, most recent first. */
export async function recentPlayers(days = 7): Promise<Entry[]> {
  return (await recentEntries(days)).filter((e) => e.prizeEligible && !e.cancelled);
}

/** Every prize won and not yet paid, oldest first. */
export async function prizesOwed(days = 30): Promise<Entry[]> {
  return (await recentEntries(days)).filter((e) => e.prize && !e.prize.paid).reverse();
}

// ---------------------------------------------------------------------------
// Public view of the human side
// ---------------------------------------------------------------------------

const shortWallet = (w?: string) => (w ? `${w.slice(0, 4)}…${w.slice(-4)}` : undefined);

export async function humanSummary() {
  const cfg = config();
  const hunting = await huntingAvailable();
  const plan = gamePlan(hunting);
  const recent = await recentPlayers();
  return {
    hunting,
    questionCount: plan.filter((k) => k !== "hunt").length,
    huntRounds: plan.filter((k) => k === "hunt").length,
    prizeRound: Math.min(cfg.hunterPrizeRound, HUNT_LEVELS.length),
    prize: cfg.hunterPrizeTokens,
    entryFee: cfg.entryFeeTokens,
    symbol: cfg.tokenSymbol,
    paymentMode: cfg.paymentMode,
    cluster: cfg.paymentMode === "solana" ? cfg.solana.cluster : undefined,
    sessionMinutes: cfg.sessionMinutes,
    players: recent.length,
    winners: recent.filter((e) => e.prize).length,
    board: recent.slice(0, 50).map((e) => ({
      handle: e.handle,
      cleared: huntScore(e.hunts).cleared,
      rounds: (e.hunts ?? []).length ? HUNT_LEVELS.length : 0,
      score: e.result!.score,
      quip: e.result!.quip,
      won: e.prize?.tokens,
      wallet: shortWallet(e.wallet),
    })),
  };
}

/** Record that a prize has been paid. */
export async function markPrizePaid(entry: Pick<Entry, "roundId" | "id">, signature?: string): Promise<void> {
  await updateRound(entry.roundId, (state) => {
    const prize = state.entries[entry.id]?.prize;
    if (!prize) throw new GameError(404, "no_prize", "That entry has no prize");
    prize.paid = true;
    prize.signature = signature;
  });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** A hunt as the player sees it: without which answer is the person's. */
export interface HuntView {
  id: string;
  /** Which rung of the ladder this is, from 1. */
  round: number;
  level: number;
  prompt: string;
  options: [string, string];
}

/** What the player is facing now: a question to answer, or a pair to pick from. */
interface Facing {
  question?: Question;
  hunt?: HuntView;
  index: number;
  total: number;
}

export interface Session extends Facing {
  question: Question;
  token: string;
  roundId: string;
  entryId: string;
  handle: string;
  /** Entered with an agent key, competing for the bounty. */
  agent: boolean;
  expiresAt: number;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const randomId = (bytes: number) => randomBytes(bytes).toString("base64url");
const viewOf = ({ id, level, prompt, options }: Hunt, round: number): HuntView => ({ id, round, level, prompt, options });

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
  return {
    token,
    roundId: entry.roundId,
    entryId: entry.id,
    handle: entry.handle,
    agent: Boolean(entry.agentKeyId),
    // A game always opens with a question.
    question: questionsOf(state, entry)[entry.answers.length],
    index: stepOf(entry),
    total: planOf(state, entry).length,
    expiresAt: entry.createdAt + config().sessionMinutes * 60_000,
  };
}

interface NewEntry {
  handle: string;
  wallet?: string;
  payment: EntryPayment;
  /** Present for agents: the key they came in on. */
  agent?: AgentKey;
  userAgent?: string;
  /** The opening question, written before the entry is created, and the shape of the game. */
  first: Question;
  plan: StepKind[];
}

function addEntry(state: RoundState, input: NewEntry): Session {
  const now = Date.now();
  const entry: Entry = {
    id: randomId(9),
    roundId: state.round.id,
    handle: input.handle,
    wallet: input.wallet,
    createdAt: now,
    tokenHash: "",
    payment: input.payment,
    // An agent is known to be one from the start. A player's label, if any, comes after judging.
    cohortId: input.agent ? AGENT_COHORT : undefined,
    label: input.agent ? "agent" : undefined,
    agentKeyId: input.agent?.id,
    house: input.agent?.house || undefined,
    questions: [input.first],
    adaptive: true,
    plan: input.plan,
    hunts: [],
    // Only players are on the board and in line for the pool.
    prizeEligible: !input.agent,
    status: "playing",
    progress: 0,
    servedAt: [now],
    answers: [],
    userAgent: input.userAgent?.slice(0, 300),
    consent: CONSENT_VERSION,
  };
  const token = issueToken(entry);
  state.entries[entry.id] = entry;
  return sessionFor(state, entry, token);
}

/** What a new player's game starts with: an opening question, and hunting if there is material for it. */
async function openGame(): Promise<{ first: Question; plan: StepKind[] }> {
  const [first, hunting] = await Promise.all([nextQuestion(0, []), huntingAvailable()]);
  return { first, plan: gamePlan(hunting) };
}

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

/** What someone sends when they come back after paying. */
export interface PaymentProof {
  roundId?: string;
  intentId?: string;
  signature?: string;
}

type Settled =
  | { kind: "free" }
  | { kind: "mock" }
  | { kind: "paid"; roundId: string; intentId: string; signature: string; receivedRaw: string }
  /** The same payment presented again, e.g. after a lost response: here is the session it already bought. */
  | { kind: "again"; session: Session };

/**
 * Make sure a fee has been paid before someone is let in.
 *
 * In test mode nothing is collected. With real tokens it takes two calls: the
 * first reserves a payment and throws a 402 carrying a transaction to sign;
 * the second arrives with the signature, which is checked on-chain. `guard`
 * runs under the day's lock before a payment is requested, so nobody is asked
 * to pay for an entry that would then be refused.
 */
async function settleFee(
  tokens: number,
  who: { wallet?: string; handle: string },
  proof: PaymentProof,
  guard: (state: RoundState) => void,
): Promise<Settled> {
  const cfg = config();
  if (tokens <= 0) return { kind: "free" };
  if (cfg.paymentMode === "mock") return { kind: "mock" };
  const wallet = who.wallet;
  if (!wallet) throw new GameError(400, "wallet_required", "Connect a wallet to pay the fee");

  if (!proof.signature) {
    const { solanaSetup, toRawAmount, buildEntryTransaction } = await solana();
    const { decimals } = await solanaSetup();
    const amountRaw = toRawAmount(tokens, decimals);
    const roundId = roundIdFor();
    const intent = await withRound(roundId, (state) => {
      guard(state);
      const id = randomId(9);
      const created: PaymentIntent = {
        id,
        wallet,
        handle: who.handle,
        memo: `pmh:${roundId}:${id}`,
        amountRaw: amountRaw.toString(),
        createdAt: Date.now(),
      };
      state.intents[id] = created;
      return created;
    });
    const transaction = await buildEntryTransaction(wallet, intent.memo, amountRaw);
    throw new GameError(402, "payment_required", "Pay the fee to play", {
      payment: {
        roundId,
        intentId: intent.id,
        transaction,
        memo: intent.memo,
        amount: tokens,
        symbol: cfg.tokenSymbol,
        cluster: cfg.solana.cluster,
        mint: cfg.solana.mint,
        treasury: cfg.solana.treasury,
      },
    });
  }

  // They say they paid. Check the chain before believing it.
  const roundId = proof.roundId ?? roundIdFor();
  const signature = proof.signature.trim();
  const before = await readRound(roundId);
  const intent = proof.intentId ? before?.intents[proof.intentId] : undefined;
  if (!before || !intent || intent.wallet !== wallet) {
    throw new GameError(400, "bad_intent", "That payment request isn't known. Start again.");
  }
  const bought = before.entries[before.signatures[signature] ?? ""];
  if (bought) {
    // Hand back a fresh token for the entry this payment already bought, as long as play hasn't started.
    if (bought.payment.intentId !== intent.id || stepOf(bought) > 0 || bought.status !== "playing") {
      throw new GameError(409, "payment_used", "That payment has already been used");
    }
    return {
      kind: "again",
      session: await withRound(roundId, (state) => sessionFor(state, state.entries[bought.id], issueToken(state.entries[bought.id]))),
    };
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
  return { kind: "paid", roundId, intentId: intent.id, signature, receivedRaw: check.receivedRaw.toString() };
}

/** Create the entry a settled fee pays for, and mark the payment as spent in the same step. */
function admit(settled: Exclude<Settled, { kind: "again" }>, tokens: number, entry: Omit<NewEntry, "payment">): Promise<Session> {
  const payment: EntryPayment =
    settled.kind === "paid"
      ? { mode: "solana", amountTokens: tokens, amountRaw: settled.receivedRaw, signature: settled.signature, intentId: settled.intentId }
      : settled.kind === "mock"
        ? { mode: "mock", amountTokens: tokens }
        : { mode: "waived", amountTokens: 0 };
  return withRound(settled.kind === "paid" ? settled.roundId : roundIdFor(), (state) => {
    if (settled.kind === "paid") {
      const intent = state.intents[settled.intentId];
      if (!intent || intent.usedByEntry || state.signatures[settled.signature]) {
        throw new GameError(409, "payment_used", "That payment has already been used");
      }
      const session = addEntry(state, { ...entry, payment });
      intent.usedByEntry = session.entryId;
      state.signatures[settled.signature] = session.entryId;
      return session;
    }
    return addEntry(state, { ...entry, payment });
  });
}

// ---------------------------------------------------------------------------
// Entering on the human side
// ---------------------------------------------------------------------------

export interface EnterInput extends PaymentProof {
  handle: string;
  /** Where a prize would be sent. Needed to pay a fee; optional otherwise. */
  wallet?: string;
  userAgent?: string;
}

export async function enter(input: EnterInput): Promise<Session> {
  const cfg = config();
  const handle = cleanHandle(input.handle);
  const wallet = input.wallet?.trim() || undefined;
  if (wallet && !isValidAddress(wallet)) throw new GameError(400, "bad_wallet", "That isn't a valid Solana address");

  const settled = await settleFee(cfg.entryFeeTokens, { wallet, handle }, input, () => undefined);
  if (settled.kind === "again") return settled.session;
  const opening = await openGame();
  return admit(settled, cfg.entryFeeTokens, { handle, wallet, userAgent: input.userAgent, ...opening });
}

// ---------------------------------------------------------------------------
// Entering on the bot side
// ---------------------------------------------------------------------------

/** Agents that have finished, most recent first, from the last `days` days. */
export async function recentAgents(days = 7): Promise<Entry[]> {
  return (await recentEntries(days)).filter((e) => e.agentKeyId);
}

/**
 * Enter an agent. The caller has already checked the key. The agent pays the
 * fee from its builder's wallet. The judge scores it exactly like anyone else,
 * without being told it is an agent.
 * Agents answer questions only; hunting is for people.
 */
export async function enterAgent(input: { key: AgentKey; handle: unknown; userAgent?: string } & PaymentProof): Promise<Session> {
  const cfg = config();
  const { key } = input;
  const handle = cleanHandle(input.handle ?? key.name);
  // The house's own agents test the judge; they neither pay nor win.
  const fee = key.house ? 0 : cfg.agentFeeTokens;
  const guard = (state: RoundState) => {
    if (Object.values(state.entries).filter((e) => e.agentKeyId).length >= cfg.agentDailyCap) {
      throw new GameError(429, "agents_full", "No more agent runs can be taken today");
    }
  };

  const settled = await settleFee(fee, { wallet: key.wallet, handle }, input, guard);
  if (settled.kind === "again") return settled.session;
  const first = await nextQuestion(0, []);
  return admit(settled, fee, {
    handle,
    wallet: key.wallet,
    first,
    plan: gamePlan(false),
    agent: key,
    userAgent: input.userAgent,
  });
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

/** Checks common to every move: the session is real, still being played, and in time. */
function playing(state: RoundState, entryId: string, secret: string, now: number): Entry {
  const entry = authorise(state, entryId, secret);
  if (entry.status !== "playing") throw new GameError(409, "already_finished", "This entry is already finished");
  if (now > entry.createdAt + config().sessionMinutes * 60_000) {
    throw new GameError(410, "session_expired", "Time ran out on this entry");
  }
  return entry;
}

const unknownRound = (err: unknown): never => {
  if (err instanceof GameError) throw err;
  if (/does not exist|Invalid round/.test(String(err))) throw new GameError(401, "bad_token", "Invalid session");
  throw err;
};

export interface PlayerResult {
  /** How human the judge found them, 0-100. */
  score: number;
  verdict: Kind;
  quip: string;
  handle: string;
  /** Players: how far up the hunting ladder they got, and the round that wins the prize. */
  hunt?: { cleared: number; rounds: number; prizeRound: number };
  /** Players: the judge took them for a bot, so the game doesn't count. */
  cancelled?: boolean;
  /** Agents: whether the judge took it for human. */
  impostor?: { fooled: boolean };
  /** What they won, if anything, and whether there is somewhere to send it. */
  prize?: { tokens: number; symbol: string; payable: boolean };
}

function playerResult(entry: Entry): PlayerResult {
  const cfg = config();
  const result = entry.result!;
  const prize = entry.prize ? { tokens: entry.prize.tokens, symbol: cfg.tokenSymbol, payable: Boolean(entry.wallet) } : undefined;
  const base = { score: result.score, verdict: result.verdict, quip: result.quip, handle: entry.handle, prize };
  if (entry.agentKeyId) return { ...base, impostor: { fooled: result.score >= HUMAN_AT } };
  const hunted = (entry.hunts ?? []).length > 0 || (entry.plan ?? []).includes("hunt");
  const hunt = hunted
    ? { cleared: huntScore(entry.hunts).cleared, rounds: HUNT_LEVELS.length, prizeRound: Math.min(cfg.hunterPrizeRound, HUNT_LEVELS.length) }
    : undefined;
  return { ...base, hunt, cancelled: entry.cancelled || undefined };
}

/**
 * Judge a finished entry and record the result. Then, and only then, attach
 * what is known about who it was and file it as a training example.
 */
async function score(roundId: string, entryId: string): Promise<PlayerResult> {
  const state = await readRound(roundId);
  const entry = state?.entries[entryId];
  if (!state || !entry) throw new GameError(404, "no_entry", "Entry not found");

  // The judge gets the questions, the answers and the behaviour readings.
  // It is not given the side the entry came in on, the handle or the wallet.
  const features = aggregateFeatures(entry.answers, entry.env, entry.userAgent);
  const result: JudgeResult = await judgeEntry(questionsOf(state, entry), { id: entry.id, answers: entry.answers }, features);

  const cfg = config();
  const { finalState, scoredNow } = await withRound(roundId, (s) => {
    const e = s.entries[entryId];
    // Two requests can race to score the same entry; the first result stands.
    const first = e.status !== "scored";
    if (first) {
      e.features = features;
      e.result = result;
      e.status = "scored";
      if (e.prizeEligible) {
        // A player the judge takes for a bot loses their game.
        if (result.score < HUMAN_AT) e.cancelled = true;
        else {
          // A player it is confident about is taken to be human from here on.
          if (result.score >= CONFIDENT_HUMAN_AT) {
            e.label = "human";
            e.cohortId = PLAYER_COHORT;
          }
          if (huntScore(e.hunts).cleared >= Math.min(cfg.hunterPrizeRound, HUNT_LEVELS.length)) {
            e.prize = { tokens: cfg.hunterPrizeTokens, reason: "hunter", wonAt: Date.now() };
          }
        }
      } else if (e.agentKeyId && !e.house && result.score >= HUMAN_AT) {
        // An agent the judge took for human wins the agents' prize. The house's own agents don't.
        e.prize = { tokens: cfg.agentPrizeTokens, reason: "fooled", wonAt: Date.now() };
      }
    }
    return { finalState: s, scoredNow: first };
  });
  const scored = finalState.entries[entryId];

  if (scoredNow && scored.label && scored.cohortId) {
    await recordExample(finalState, scored, scored.label, scored.cohortId, scored.agentKeyId ? "session" : "auto");
    clearHuntCache();
  }
  return playerResult(scored);
}

/** File a scored entry, with what is known about who it was, as a training example. */
async function recordExample(
  state: RoundState,
  entry: Entry,
  label: Kind,
  cohortId: string,
  source: "session" | "auto",
): Promise<void> {
  await appendTraining({
    entryId: entry.id,
    roundId: entry.roundId,
    recordedAt: Date.now(),
    label,
    cohortId,
    source,
    handle: entry.handle,
    device: entry.device,
    consent: entry.consent,
    questions: questionsOf(state, entry),
    answers: entry.answers.map(({ questionId, text, serverLatencyMs, features }) => ({
      questionId,
      text,
      serverLatencyMs,
      features,
    })),
    features: entry.features ?? aggregateFeatures(entry.answers, entry.env, entry.userAgent),
    env: entry.env,
    judge: entry.result!,
    judgeCorrect: entry.result!.verdict === label,
    telemetry: await readTelemetry(entry.roundId, entry.id),
  });
}

/** How the last hunt went, shown to the player before they move on. */
export interface HuntReveal {
  correct: boolean;
  humanIndex: 0 | 1;
  level: number;
}

export type AnswerOutcome = (({ done: false } & Facing) | { done: true; result: PlayerResult }) & { lastHunt?: HuntReveal };

/** Answer the question the player is on. */
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
    const entry = playing(state, entryId, secret, now);
    const plan = planOf(state, entry);
    const asked = entry.answers.length;
    const question = plan[stepOf(entry)] === "hunt" ? undefined : questionsOf(state, entry)[asked];
    if (!question || input.questionId !== question.id) {
      throw new GameError(409, "wrong_question", "That isn't the current question");
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
      serverLatencyMs: now - entry.servedAt[asked],
      features: extractAnswerFeatures(question.kind, answerText, telemetry),
    });
    if (telemetry.env) {
      entry.env = telemetry.env;
      entry.device = deviceOf(telemetry.env);
    }
    entry.progress = entry.answers.length;
    // Older entries already hold their whole list; start the next question's clock now.
    if (questionsOf(state, entry)[entry.answers.length]) entry.servedAt[entry.answers.length] = Date.now();

    const finished = stepOf(entry) >= plan.length;
    if (finished) entry.status = "scoring";
    return { finished, questionId: question.id };
  }).catch(unknownRound);

  await saveTelemetry(roundId, entryId, step.questionId, telemetry);
  if (step.finished) return { done: true, result: await score(roundId, entryId) };
  return serveStep(roundId, entryId);
}

/** Pick which of a hunt's two answers the person wrote. */
export async function pickHunt(input: { token: unknown; huntId: unknown; pick: unknown }): Promise<AnswerOutcome> {
  const { roundId, entryId, secret } = parseToken(input.token);
  if (input.pick !== 0 && input.pick !== 1) throw new GameError(400, "bad_pick", "Pick one of the two answers");
  const pick = input.pick;
  const now = Date.now();

  const step = await updateRound(roundId, (state) => {
    const entry = playing(state, entryId, secret, now);
    const hunt = (entry.hunts ?? []).find((h) => h.pick === undefined);
    if (!hunt || hunt.id !== input.huntId) throw new GameError(409, "wrong_hunt", "That isn't the current round");
    hunt.pick = pick;
    hunt.correct = pick === hunt.humanIndex;
    hunt.answeredAt = now;
    // A miss ends the climb: the rest of the game is the remaining questions.
    if (!hunt.correct) entry.plan = planOf(state, entry).filter((kind, i) => i < stepOf(entry) || kind !== "hunt");
    const finished = stepOf(entry) >= planOf(state, entry).length;
    if (finished) entry.status = "scoring";
    return { finished, hunt: { ...hunt } };
  }).catch(unknownRound);

  // Every pick is a person's judgement on a pair whose truth is known: keep it.
  const { hunt } = step;
  await appendHuntRecord({
    at: now,
    roundId,
    hunterEntryId: entryId,
    sourceEntryId: hunt.sourceEntryId,
    level: hunt.level,
    prompt: hunt.prompt,
    human: hunt.options[hunt.humanIndex],
    decoy: hunt.options[hunt.humanIndex === 0 ? 1 : 0],
    correct: hunt.correct!,
    ms: now - hunt.servedAt,
  });

  const lastHunt: HuntReveal = { correct: hunt.correct!, humanIndex: hunt.humanIndex, level: hunt.level };
  const next: AnswerOutcome = step.finished
    ? { done: true, result: await score(roundId, entryId) }
    : await serveStep(roundId, entryId);
  return { ...next, lastHunt };
}

/**
 * What the player is facing now, preparing it first if it doesn't exist yet.
 * Questions and decoys are written outside the round's lock (the model takes a
 * few seconds), and a step's clock starts only once it is stored.
 */
async function serveStep(roundId: string, entryId: string): Promise<AnswerOutcome> {
  for (;;) {
    const state = await readRound(roundId);
    const entry = state?.entries[entryId];
    if (!state || !entry) throw new GameError(404, "no_entry", "Entry not found");
    if (entry.status !== "playing") return { done: true, result: await score(roundId, entryId) };
    const plan = planOf(state, entry);
    const index = stepOf(entry);
    const facing = { index, total: plan.length };

    if (plan[index] === "hunt") {
      const waiting = (entry.hunts ?? []).find((h) => h.pick === undefined);
      if (waiting) return { done: false, hunt: viewOf(waiting, (entry.hunts ?? []).indexOf(waiting) + 1), ...facing };
      const hunt = await nextHunt(entry).catch((err) => {
        console.error("[hunt] could not prepare a round; skipping the rest of this player's hunts:", err);
        return null;
      });
      await updateRound(roundId, (s) => {
        const e = s.entries[entryId];
        if ((e.hunts ?? []).some((h) => h.pick === undefined)) return; // another request got there first
        if (hunt) {
          (e.hunts ??= []).push({ ...hunt, servedAt: Date.now() });
        } else {
          // Nothing left to show this player: carry on with the questions alone.
          e.plan = planOf(s, e).filter((kind, i) => i < stepOf(e) || kind !== "hunt");
          if (stepOf(e) >= e.plan.length) e.status = "scoring";
        }
      });
      continue;
    }

    const asked = questionsOf(state, entry);
    const number = entry.answers.length;
    if (asked[number]) return { done: false, question: asked[number], ...facing };
    const written = await nextQuestion(
      number,
      entry.answers.map((a, i) => ({ question: asked[i], answer: a.text })),
    );
    await updateRound(roundId, (s) => {
      const e = s.entries[entryId];
      e.questions ??= [];
      // If two requests raced to write this question, the first one stored is the question.
      if (!e.questions[number]) {
        e.questions[number] = written;
        e.servedAt[number] = Date.now();
      }
    });
  }
}

/** Where a session stands: the current step, or the result. Also finishes anything that was interrupted. */
export async function sessionStatus(token: unknown): Promise<AnswerOutcome> {
  const { roundId, entryId, secret } = parseToken(token);
  const state = await readRound(roundId);
  const entry = authorise(state, entryId, secret);
  if (entry.status === "scored") return { done: true, result: playerResult(entry) };
  return serveStep(roundId, entryId);
}
