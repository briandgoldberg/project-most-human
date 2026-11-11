import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { HUNT_LEVELS, clearHuntCache, freshFor, huntScore, huntingAvailable, nextHunt, seenKey } from "./hunt";
import { QUESTION_PLAN, gamePlan, nextQuestion } from "./interview";
import { debriefLessons, debriefQuestions, judgeEntry } from "./judge";
import { heuristicScore } from "./judge/heuristic";
import { isValidAddress } from "./payments/address";
import { MAX_ANSWER_CHARS, bankQuestionsFor } from "./questions";
import { appendHuntRecord, appendTraining, readPlayer, readRound, readTelemetry, saveTelemetry, updatePlayer, updateRound } from "./store";
import { aggregateFeatures, deviceOf, extractAnswerFeatures } from "./telemetry/features";
import { sanitizeTelemetry } from "./telemetry/sanitize";
import type { AgentKey, AnswerFeatures, ClientEnv, Entry, EntryPayment, Evidence, Hunt, JudgeResult, Kind, PaymentIntent, Question, RoundState, StepKind } from "./types";

/**
 * The game has two sides and one judge, and it never closes.
 *
 *   The human side (/). A player answers questions that show they are a
 *   person, and in between hunts bots: picking the real person's answer out of
 *   a pair, round after round. A wrong pick ends their game. Clear enough
 *   rounds and they win the hunter prize. If the judge takes a player for a bot, their game is
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
export const CONSENT_VERSION = "v4";

/** At or above this the judge takes a player for a person; below it, for a bot. */
export const HUMAN_AT = 50;
/** A player the judge scores at least this is taken to be human for training, and their answers may be hunted with. */
export const CONFIDENT_HUMAN_AT = 60;
/** Cohort names under which examples are filed. */
/** Hunters must explain their pick from this decoy level up, in at least this many characters. */
const REASON_FROM_LEVEL = 2;
const MIN_REASON_CHARS = 8;
const MAX_REASON_CHARS = 300;
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
  // An agent's prize waits until it has said how it fooled the judge.
  const owed = (await recentEntries(days)).filter((e) => e.prize && !e.prize.paid && !debriefDue(e)).reverse();
  // A player's prizes go wherever their account says, once it says anywhere. Until then they sit in their balance.
  const people = [...new Set(owed.flatMap((e) => (e.prizeEligible && personOf(e) ? [personOf(e)!] : [])))];
  const wallets = new Map(await Promise.all(people.map(async (id) => [id, (await readPlayer(id))?.wallet] as const)));
  return owed.map((e) => (e.prizeEligible && personOf(e) ? { ...e, wallet: wallets.get(personOf(e)!) ?? e.wallet } : e));
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
    // What a player has won after being judged human and clearing 0, 1, 2... hunting rounds.
    prizes: prizeLadder(),
    prizesPerPerson: cfg.prizesPerPerson,
    // Whether players must sign in with Google, and the public id the sign-in button needs.
    signIn: cfg.googleClientId ? { required: true as const, clientId: cfg.googleClientId } : { required: false as const },
    entryFee: cfg.entryFeeTokens,
    symbol: cfg.tokenSymbol,
    paymentMode: cfg.paymentMode,
    cluster: cfg.paymentMode === "solana" ? cfg.solana.cluster : undefined,
    sessionMinutes: cfg.sessionMinutes,
    players: recent.length,
    // How many games won a prize this week. A count, not a quota: there is no limit on winners.
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
  const settled = await updateRound(entry.roundId, (state) => {
    const paid = state.entries[entry.id];
    const prize = paid?.prize;
    if (!prize) throw new GameError(404, "no_prize", "That entry has no prize");
    const first = !prize.paid;
    prize.paid = true;
    prize.signature = signature;
    return first && paid.prizeEligible ? { person: personOf(paid), tokens: prize.tokens } : null;
  });
  // It leaves the player's balance.
  if (settled?.person) await updatePlayer(settled.person, (p) => void (p.paid = (p.paid ?? 0) + settled.tokens));
}

/** What a player judged human has won after clearing 0, 1, 2... hunting rounds. */
export function prizeLadder(): number[] {
  const cfg = config();
  const ladder = [cfg.humanPrizeTokens];
  for (const add of cfg.huntRoundPrizes.slice(0, HUNT_LEVELS.length)) ladder.push(ladder[ladder.length - 1] + add);
  return ladder;
}

// ---------------------------------------------------------------------------
// Keeping bots off the human side
// ---------------------------------------------------------------------------

/** A question as sent to whoever is answering: without the phrase its trap is listening for. */
const shown = ({ id, kind, category, prompt, hint, note }: Question): Question => ({ id, kind, category, prompt, hint, note });

const HEADLESS = /headless|phantomjs|puppeteer|playwright|python-requests|node-fetch|undici|curl\/|^node$/i;

/**
 * Evidence strong enough to end a player's game on the spot, without waiting
 * for the judge: things a person at a keyboard or phone cannot do, or that
 * only a machine reading the page would do. Returns what was found, or null.
 */
function hardTell(
  kind: "text" | "draw",
  text: string,
  f: AnswerFeatures,
  took: number,
  trapped: boolean,
  env: ClientEnv | undefined,
  userAgent: string | undefined,
): string | null {
  if (trapped) return "followed the instruction hidden from people";
  if (!env) return "no browser reported";
  if (env.webdriver) return "browser is under automation";
  if (HEADLESS.test(env.ua) || HEADLESS.test(userAgent ?? "")) return "scripted or headless client";
  if (f.untrustedRatio > 0.5) return "keystrokes generated by script";
  if (kind !== "text") return null;
  if (f.pastedChars > text.length * 0.5) return "answer was pasted";
  if (f.typedChars < text.length * 0.3) return "answer appeared without being typed";
  if (text.length >= 20 && took < 1500) return "answered faster than it could be read";
  if (f.ikiMedian !== null && f.ikiMedian < 25 && text.length >= 20) return "typed faster than fingers move";
  return null;
}

/** A short one-way hash, salted so the stored value can't be turned back into what it came from. */
const fingerprint = (kind: string, value: string | undefined) =>
  value ? createHash("sha256").update(`${kind}:${config().supabase.secret ?? ""}:${value}`).digest("hex").slice(0, 16) : undefined;

/** What makes one machine look different from another, as far as its browser says. */
const machineOf = (env: ClientEnv) =>
  fingerprint("machine", JSON.stringify([env.ua, env.screen, env.dpr, env.tz, env.languages, env.cores, env.touchPoints, env.plugins]));

/**
 * Whether two games were played by the same person, as far as can be told:
 * the same browser (by its cookie), or the same machine on the same network.
 * Neither a shared network nor an identical phone is enough alone, since those
 * are often different people.
 */
const samePlayer = (a: Entry, b: Entry) =>
  Boolean(a.player && a.player === b.player) ||
  Boolean(a.deviceHash && a.deviceHash === b.deviceHash) ||
  Boolean(a.addressHash && a.addressHash === b.addressHash && a.machineHash && a.machineHash === b.machineHash);

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
  /** How each option was produced, in the same order. */
  evidence?: [Evidence, Evidence];
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
const viewOf = ({ id, level, prompt, options, evidence }: Hunt, round: number): HuntView => ({ id, round, level, prompt, options, evidence });

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
    question: shown(questionsOf(state, entry)[entry.answers.length]),
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
  addressHash?: string;
  deviceHash?: string;
  player?: string;
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
    addressHash: input.addressHash,
    deviceHash: input.deviceHash,
    player: input.player,
    consent: CONSENT_VERSION,
  };
  const token = issueToken(entry);
  state.entries[entry.id] = entry;
  return sessionFor(state, entry, token);
}

/**
 * Who an entry's player is across their games: their Google account if they
 * signed in, or else the browser they played in.
 */
const personOf = (e: Pick<Entry, "player" | "deviceHash">) => e.player ?? e.deviceHash;

/**
 * Whether a person can start a game now, and whether it would include hunting.
 *
 * Hunting needs real answers the player hasn't judged yet, from other people.
 * With enough of those for a whole game, they play the full game. A newcomer
 * without them plays the questions alone, which is how the store of real
 * answers gets started. Someone who has played before and has been through
 * nearly everything there is has to wait for more people to play.
 */
export async function playStanding(person: string | undefined): Promise<{ ok: boolean; hunting: boolean }> {
  const cfg = config();
  const hunting = await huntingAvailable();
  if (!person || cfg.hunting === "off" || cfg.huntRepeats === "on") return { ok: true, hunting };
  const record = await readPlayer(person);
  const fresh = hunting ? (await freshFor({ entryId: "", person, seen: record?.seen ?? [] })).length : 0;
  if (fresh >= HUNT_LEVELS.length) return { ok: true, hunting: true };
  return { ok: !record || record.games === 0, hunting: false };
}

/** A first name, if it would do as a handle. */
function suggestedHandle(name: string | undefined): string | undefined {
  const handle = (name ?? "").trim().replace(/\s+/g, " ").slice(0, 20).trim();
  return HANDLE.test(handle) ? handle : undefined;
}

/** For the lobby: who is at the browser, and whether they can start a game now. */
export async function whoAmI(player: { id: string; name: string } | null, deviceId: string | undefined) {
  const person = personOf({ player: player?.id, deviceHash: fingerprint("device", deviceId) });
  const record = person ? await readPlayer(person) : null;
  return {
    signedIn: Boolean(player),
    name: player?.name,
    // What the board calls them: what they last played as, or failing that their first name from Google.
    handle: record?.handle ?? suggestedHandle(player?.name),
    // False once they have judged nearly every real answer there is: they wait for more people to play.
    canPlay: (await playStanding(person)).ok,
    // Prizes won and not yet sent, and where they have asked for them to go.
    balance: Math.max(0, (record?.won ?? 0) - (record?.paid ?? 0)),
    wallet: record?.wallet,
  };
}

/**
 * Save where a player wants their balance sent. It is kept with their account
 * (their Google sign-in, or their browser where sign-in is off), and what they
 * have won and will win goes there when prizes are next paid out.
 */
export async function saveWallet(player: { id: string; name: string } | null, deviceId: string | undefined, wallet: unknown) {
  if (config().googleClientId && !player) throw new GameError(401, "sign_in_needed", "Sign in with Google first");
  const person = personOf({ player: player?.id, deviceHash: fingerprint("device", deviceId) });
  if (!person) throw new GameError(400, "no_account", "Play a game first");
  const address = typeof wallet === "string" ? wallet.trim() : "";
  if (!isValidAddress(address)) throw new GameError(400, "bad_wallet", "That isn't a valid Solana address");
  await updatePlayer(person, (p) => void (p.wallet = address));
  return whoAmI(player, deviceId);
}

const COME_BACK = "You've been through nearly every real answer we have. Come back once more people have played.";

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
  if (tokens <= 0 || cfg.paymentMode === "mock") {
    // Nothing to pay, so nothing is lost by refusing here, before a question is written for them.
    const state = await readRound(roundIdFor());
    if (state) guard(state);
    return { kind: tokens <= 0 ? "free" : "mock" };
  }
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

/**
 * Create the entry a settled fee pays for, and mark the payment as spent in the same step.
 * `guard` has the last word on entries that cost nothing; one that was paid for
 * passed it when the payment was requested, and is not refused after the money has moved.
 */
function admit(
  settled: Exclude<Settled, { kind: "again" }>,
  tokens: number,
  entry: Omit<NewEntry, "payment">,
  guard: (state: RoundState) => void,
): Promise<Session> {
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
    guard(state);
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
  /** The network address the request came from, and the id in this browser's cookie, for limits per person. */
  clientAddress?: string;
  deviceId?: string;
  /** A form field people can't see. Anything in it was put there by a script. */
  website?: string;
  /** The signed-in player: a hash of their Google account id. Needed when the site requires sign-in. */
  player?: string;
}

export async function enter(input: EnterInput): Promise<Session> {
  const cfg = config();
  const handle = cleanHandle(input.handle);
  const wallet = input.wallet?.trim() || undefined;
  if (wallet && !isValidAddress(wallet)) throw new GameError(400, "bad_wallet", "That isn't a valid Solana address");

  if (input.website) throw new GameError(400, "not_allowed", "This side is for people. Agents play on the other side.");
  if (cfg.googleClientId && !input.player) throw new GameError(401, "sign_in_needed", "Sign in with Google to play");
  const deviceHash = fingerprint("device", input.deviceId);
  const person = personOf({ player: input.player, deviceHash });
  const standing = await playStanding(person);
  // Someone coming back with a payment already made is past this point.
  if (!standing.ok && !input.signature) throw new GameError(409, "come_back", COME_BACK);
  const from = fingerprint("address", input.clientAddress);
  const guard = (state: RoundState) => {
    if (from && cfg.gamesPerAddress > 0 && Object.values(state.entries).filter((e) => e.prizeEligible && e.addressHash === from).length >= cfg.gamesPerAddress) {
      throw new GameError(429, "too_many_games", "That's enough games from here for today. Come back tomorrow.");
    }
  };

  const settled = await settleFee(cfg.entryFeeTokens, { wallet, handle }, input, guard);
  if (settled.kind === "again") return settled.session;
  const first = await nextQuestion(0, []);
  const session = await admit(
    settled,
    cfg.entryFeeTokens,
    { handle, wallet, userAgent: input.userAgent, addressHash: from, deviceHash, player: input.player, first, plan: gamePlan(standing.hunting) },
    guard,
  );
  if (person) {
    await updatePlayer(person, (p) => {
      p.games++;
      p.handle = handle;
    });
  }
  return session;
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
  return admit(settled, fee, { handle, wallet: key.wallet, first, plan: gamePlan(false), agent: key, userAgent: input.userAgent }, guard);
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
  /** Players: how many hunting rounds they cleared, and whether a miss ended their game. */
  hunt?: { cleared: number; fooled: boolean };
  /** Players: they would have won this, but gave no address to send it to, or had already won today. */
  missedPrize?: { tokens: number; why: "no_address" | "already_won" };
  /** Players: the judge took them for a bot, so the game doesn't count. */
  cancelled?: boolean;
  /** Agents: whether the judge took it for human. */
  impostor?: { fooled: boolean };
  /**
   * What they won, if anything, and whether there is somewhere to send it.
   * `held`: not released until the agent's debrief is in. `banked`: added to the player's balance, to withdraw when they like.
   */
  prize?: { tokens: number; symbol: string; payable: boolean; held?: boolean; banked?: boolean };
  /** Agents that fooled the judge: what it wants to know, and whether they have answered. */
  debrief?: { questions: string[]; done: boolean };
}

/** Whether an agent that fooled the judge still owes its account of how. */
export const debriefDue = (e: Entry) => Boolean(e.debrief && !e.debrief.answeredAt);

function playerResult(entry: Entry): PlayerResult {
  const cfg = config();
  const result = entry.result!;
  const prize = entry.prize
    ? {
        tokens: entry.prize.tokens,
        symbol: cfg.tokenSymbol,
        payable: Boolean(entry.wallet),
        ...(debriefDue(entry) ? { held: true } : {}),
        ...(entry.prizeEligible && personOf(entry) ? { banked: true } : {}),
      }
    : undefined;
  const base = { score: result.score, verdict: result.verdict, quip: result.quip, handle: entry.handle, prize };
  if (entry.agentKeyId) {
    const debrief = entry.debrief ? { questions: entry.debrief.questions, done: !debriefDue(entry) } : undefined;
    return { ...base, impostor: { fooled: result.score >= HUMAN_AT }, debrief };
  }
  const hunted = (entry.hunts ?? []).length > 0 || (entry.plan ?? []).includes("hunt");
  const hunt = hunted ? { cleared: huntScore(entry.hunts).cleared, fooled: huntScore(entry.hunts).fell } : undefined;
  return { ...base, hunt, cancelled: entry.cancelled || undefined, missedPrize: entry.missedPrize };
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
  // A player's explanations of their hunting picks are judged too: they are more of the player's own typing.
  const judged = judgedMaterial(state, entry);
  const features = aggregateFeatures(judged.answers, entry.env, entry.userAgent);
  const result: JudgeResult = await judgeEntry(judged.questions, { id: entry.id, answers: judged.answers }, features);

  // An agent the judge took for a person has some explaining to do. The judge writes its questions now.
  const fooledBy = Boolean(entry.agentKeyId) && result.score >= HUMAN_AT && entry.status !== "scored";
  const asking = fooledBy
    ? await debriefQuestions({ questions: judged.questions, answers: judged.answers, features, reasons: result.reasons, reasoning: result.llmReasoning })
    : null;

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
        if (result.score < HUMAN_AT && !e.cancelled) {
          e.cancelled = true;
          e.cancelReason = "the judge";
        }
        if (!e.cancelled) {
          // A player it is confident about is taken to be human from here on.
          if (result.score >= CONFIDENT_HUMAN_AT) {
            e.label = "human";
            e.cohortId = PLAYER_COHORT;
          }
          // The further they got, the more they win: something for being judged human, more per round cleared.
          const tokens = prizeLadder()[Math.min(huntScore(e.hunts).cleared, HUNT_LEVELS.length)];
          // If there is a daily limit, it is per person, whatever address they want prizes sent to.
          const wonToday = Object.values(s.entries).filter((o) => o.id !== e.id && o.prizeEligible && o.prize && samePlayer(o, e)).length;
          if (tokens > 0) {
            if (cfg.prizesPerPerson > 0 && wonToday >= cfg.prizesPerPerson) e.missedPrize = { tokens, why: "already_won" };
            // With real tokens a prize needs somewhere to go: the player's balance, or failing that an address.
            else if (cfg.paymentMode !== "mock" && !e.wallet && !personOf(e)) e.missedPrize = { tokens, why: "no_address" };
            else e.prize = { tokens, reason: "hunter", wonAt: Date.now() };
          }
        }
      } else if (e.agentKeyId && result.score >= HUMAN_AT) {
        // An agent the judge took for human wins the agents' prize, once it has said how. The house's own agents don't win.
        if (!e.house) e.prize = { tokens: cfg.agentPrizeTokens, reason: "fooled", wonAt: Date.now() };
        if (asking) e.debrief = { questions: asking, askedAt: Date.now() };
      }
    }
    return { finalState: s, scoredNow: first };
  });
  const scored = finalState.entries[entryId];

  // A player's prize goes into their balance.
  const winner = scoredNow && scored.prizeEligible && scored.prize ? personOf(scored) : undefined;
  if (winner) await updatePlayer(winner, (p) => void (p.won = (p.won ?? 0) + scored.prize!.tokens));

  if (scoredNow && scored.label && scored.cohortId) {
    await recordExample(finalState, scored, scored.label, scored.cohortId, scored.agentKeyId ? "session" : "auto");
    clearHuntCache();
  }
  return playerResult(scored);
}

/**
 * Everything of a player's that the judge reads: their answers, and their
 * explanations of the hunting picks they made, each with how it was typed.
 */
function judgedMaterial(state: RoundState, entry: Entry) {
  const questions = [...questionsOf(state, entry).slice(0, entry.answers.length)];
  const answers = [...entry.answers];
  for (const h of entry.hunts ?? []) {
    if (!h.reason || !h.reasonFeatures) continue;
    const id = `${h.id}-why`;
    questions.push({ id, kind: "text", category: "hunt", prompt: "Shown two answers to a question and asked to pick the one a person wrote, the player was then asked why. They wrote:" });
    answers.push({ questionId: id, text: h.reason, answeredAt: h.answeredAt ?? 0, serverLatencyMs: (h.answeredAt ?? 0) - h.servedAt, features: h.reasonFeatures });
  }
  return { questions, answers };
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
    // When it was judged, so that filing it again (with a debrief) doesn't make it look like a new run.
    recordedAt: entry.result!.scoredAt,
    label,
    cohortId,
    source,
    handle: entry.handle,
    player: personOf(entry),
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
    debrief: entry.debrief?.answeredAt ? entry.debrief : undefined,
    telemetry: await readTelemetry(entry.roundId, entry.id),
  });
}

const MIN_EXPLANATION_CHARS = 40;
const MAX_EXPLANATION_CHARS = 4000;
const MAX_DEBRIEF_ANSWER_CHARS = 1500;
const MIN_CODE_CHARS = 20;
const MAX_CODE_CHARS = 30_000;

/**
 * An agent that fooled the judge says how: what it did, answers to the judge's
 * questions, and its code. That releases its prize, goes on file with the run,
 * and is distilled into notes the judge reads from then on.
 */
export async function submitDebrief(input: { token: unknown; explanation: unknown; answers: unknown; code: unknown }): Promise<PlayerResult> {
  const { roundId, entryId, secret } = parseToken(input.token);
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const explanation = text(input.explanation, MAX_EXPLANATION_CHARS);
  const code = text(input.code, MAX_CODE_CHARS);
  const answers = Array.isArray(input.answers) ? input.answers.map((a) => text(a, MAX_DEBRIEF_ANSWER_CHARS)) : [];

  const before = authorise(await readRound(roundId).catch(unknownRound), entryId, secret);
  if (before.status !== "scored" || !before.debrief) throw new GameError(409, "no_debrief", "There is nothing to debrief: this run didn't fool the judge");
  if (before.debrief.answeredAt) throw new GameError(409, "debrief_done", "This run's debrief is already in");
  if (explanation.length < MIN_EXPLANATION_CHARS) {
    throw new GameError(400, "explanation_needed", `Explain what your agent did to pass, in at least ${MIN_EXPLANATION_CHARS} characters`);
  }
  const { questions } = before.debrief;
  if (answers.length !== questions.length || answers.some((a) => a.length < 2)) {
    throw new GameError(400, "answers_needed", `Answer each of the judge's ${questions.length} questions, in order`);
  }
  if (code.length < MIN_CODE_CHARS) throw new GameError(400, "code_needed", "Include your agent's code, or a link to where it can be read");

  const lessons = await debriefLessons({ questions, explanation, answers, code });
  const state = await updateRound(roundId, (s) => {
    const e = authorise(s, entryId, secret);
    if (!e.debrief || e.debrief.answeredAt) throw new GameError(409, "debrief_done", "This run's debrief is already in");
    e.debrief = { ...e.debrief, answeredAt: Date.now(), explanation, answers, code, lessons };
    return s;
  });
  const entry = state.entries[entryId];
  if (entry.label && entry.cohortId) await recordExample(state, entry, entry.label, entry.cohortId, "session");
  return playerResult(entry);
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
    const took = now - entry.servedAt[asked];
    const features = extractAnswerFeatures(question.kind, answerText, telemetry);
    const trapped = Boolean(question.canary) && answerText.toLowerCase().includes(question.canary!.toLowerCase());
    entry.answers.push({ questionId: question.id, text: answerText, answeredAt: now, serverLatencyMs: took, trapped: trapped || undefined, features });
    if (telemetry.env) {
      entry.env = telemetry.env;
      entry.device = deviceOf(telemetry.env);
      entry.machineHash = machineOf(telemetry.env);
    }
    entry.progress = entry.answers.length;

    // On the human side, some things end the game at once rather than waiting for the judge.
    if (entry.prizeEligible) {
      let tell = hardTell(question.kind, answerText, features, took, trapped, telemetry.env, entry.userAgent);
      // Before the first hunt, and so before any prize, the behaviour so far gets a first look.
      if (!tell && plan[stepOf(entry)] === "hunt" && entry.answers.length <= 2) {
        const early = heuristicScore(aggregateFeatures(entry.answers, entry.env, entry.userAgent));
        if (early.score <= 15) tell = "behaviour unlike a person's";
      }
      if (tell) {
        entry.cancelled = true;
        entry.cancelReason = tell;
        entry.plan = plan.slice(0, stepOf(entry));
        entry.status = "scoring";
        return { finished: true, questionId: question.id };
      }
    }
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
export async function pickHunt(input: {
  token: unknown;
  huntId: unknown;
  pick: unknown;
  /** What the player says gave the machine away. Required once the decoys stop being obvious. */
  reason?: unknown;
  /** How the explanation was typed. */
  telemetry?: unknown;
}): Promise<AnswerOutcome> {
  const { roundId, entryId, secret } = parseToken(input.token);
  if (input.pick !== 0 && input.pick !== 1) throw new GameError(400, "bad_pick", "Pick one of the two answers");
  const pick = input.pick;
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, MAX_REASON_CHARS) : "";
  const telemetry = sanitizeTelemetry(input.telemetry);
  const now = Date.now();

  const step = await updateRound(roundId, (state) => {
    const entry = playing(state, entryId, secret, now);
    const hunt = (entry.hunts ?? []).find((h) => h.pick === undefined);
    if (!hunt || hunt.id !== input.huntId) throw new GameError(409, "wrong_hunt", "That isn't the current round");
    if (hunt.level >= REASON_FROM_LEVEL && reason.length < MIN_REASON_CHARS) {
      throw new GameError(400, "reason_needed", "Say what made you think the other one was the machine");
    }
    if (reason) {
      hunt.reason = reason;
      hunt.reasonFeatures = extractAnswerFeatures("text", reason, telemetry);
      // An explanation that wasn't typed is the same giveaway as an answer that wasn't.
      const tell = hardTell("text", reason, hunt.reasonFeatures, now - hunt.servedAt, false, telemetry.env ?? entry.env, entry.userAgent);
      if (tell && reason.length >= MIN_REASON_CHARS) {
        entry.cancelled = true;
        entry.cancelReason = `${tell} (explanation)`;
      }
    }
    hunt.pick = pick;
    hunt.correct = pick === hunt.humanIndex;
    hunt.answeredAt = now;
    // A miss, or being caught, ends the game there and then. The judge still gives its read on what was answered.
    if (!hunt.correct || entry.cancelled) entry.plan = planOf(state, entry).slice(0, stepOf(entry));
    const finished = stepOf(entry) >= planOf(state, entry).length;
    if (finished) entry.status = "scoring";
    return { finished, hunt: { ...hunt }, person: personOf(entry) };
  }).catch(unknownRound);

  // Every pick is a person's judgement on a pair whose truth is known: keep it.
  const { hunt } = step;
  await appendHuntRecord({
    at: now,
    roundId,
    hunterEntryId: entryId,
    hunter: step.person,
    sourceEntryId: hunt.sourceEntryId,
    level: hunt.level,
    prompt: hunt.prompt,
    human: hunt.options[hunt.humanIndex],
    decoy: hunt.options[hunt.humanIndex === 0 ? 1 : 0],
    correct: hunt.correct!,
    ms: now - hunt.servedAt,
    reason: hunt.reason,
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
      const person = personOf(entry);
      const seen = person && config().huntRepeats !== "on" ? ((await readPlayer(person))?.seen ?? []) : [];
      const hunt = await nextHunt(entry, { person, seen }).catch((err) => {
        console.error("[hunt] could not prepare a round; skipping the rest of this player's hunts:", err);
        return null;
      });
      const stored = await updateRound(roundId, (s) => {
        const e = s.entries[entryId];
        if ((e.hunts ?? []).some((h) => h.pick === undefined)) return false; // another request got there first
        if (hunt) {
          (e.hunts ??= []).push({ ...hunt, servedAt: Date.now() });
          return true;
        } else {
          // Nothing left to show this player: carry on with the questions alone.
          e.plan = planOf(s, e).filter((kind, i) => i < stepOf(e) || kind !== "hunt");
          if (stepOf(e) >= e.plan.length) e.status = "scoring";
          return false;
        }
      });
      // Remembered from the moment it is shown, whether or not they go on to pick.
      if (hunt && stored && person) await updatePlayer(person, (p) => void (p.seen.includes(seenKey(hunt)) || p.seen.push(seenKey(hunt))));
      continue;
    }

    const asked = questionsOf(state, entry);
    const number = entry.answers.length;
    if (asked[number]) return { done: false, question: shown(asked[number]), ...facing };
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
