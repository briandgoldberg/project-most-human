import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { agentKeysForOwner } from "./agents";
import { config, ownerPassword } from "./config";
import { CONSENT_VERSION, GameError, debriefDue, prizesOwed, recentAgents, roundIdFor } from "./game";
import { clearHuntCache, humanPool } from "./hunt";
import { nextQuestion, restockQuestions } from "./interview";
import { judgeEntry } from "./judge";
import { MIN_EXAMPLES_PER_CLASS, topWeights, trainModel, type BehaviorModel } from "./judge/model";
import { BANK } from "./questions";
import { checkAnswer } from "./rules";
import { appendTraining, readBans, readHuntRecords, readModelFile, readTraining, readUsage, updateBans, updatePlayer, writeModelFile, type UsageRecord } from "./store";
import { aggregateFeatures, deviceOf, extractAnswerFeatures, typingGaps } from "./telemetry/features";
import { sanitizeTelemetry } from "./telemetry/sanitize";
import type { Question } from "./types";

/**
 * The owner's page: who may open it, what it shows, and the judge's
 * self-retraining.
 */

export const OWNER_COOKIE = "pmh_owner";
const COOKIE_TTL_S = 12 * 60 * 60;

// --- Access ------------------------------------------------------------------

// The pass is signed with the password itself, so changing the password locks every browser out.
const sign = (password: string, expires: number) => createHmac("sha256", password).update(`owner.${expires}`).digest("base64url");

export function ownerPass(): { value: string; maxAge: number } {
  const expires = Math.floor(Date.now() / 1000) + COOKIE_TTL_S;
  return { value: `${expires}.${sign(ownerPassword()!, expires)}`, maxAge: COOKIE_TTL_S };
}

function validPass(value: string | undefined): boolean {
  const password = ownerPassword();
  const [expiresRaw, mac] = (value ?? "").split(".");
  const expires = Number(expiresRaw);
  if (!password || !mac || !Number.isFinite(expires) || expires < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(password, expires));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// Slow down password guessing: a handful of wrong tries per address, then a wait.
const MAX_FAILURES = 8;
const WINDOW_MS = 10 * 60 * 1000;
const failures = new Map<string, { count: number; resetAt: number }>();

export function checkOwnerPassword(password: unknown, clientAddress: string): void {
  const now = Date.now();
  const record = failures.get(clientAddress);
  if (record && record.resetAt > now && record.count >= MAX_FAILURES) {
    throw new GameError(429, "too_many_attempts", "Too many wrong passwords. Try again in a few minutes.");
  }
  const expected = ownerPassword();
  const given = typeof password === "string" ? password : "";
  const a = createHmac("sha256", "compare").update(given).digest();
  const b = createHmac("sha256", "compare").update(expected ?? "").digest();
  if (!expected || !given || !timingSafeEqual(a, b)) {
    const current = record && record.resetAt > now ? record : { count: 0, resetAt: now + WINDOW_MS };
    current.count++;
    failures.set(clientAddress, current);
    throw new GameError(403, "bad_password", "That password isn't right");
  }
  failures.delete(clientAddress);
}

export function requireOwner(pass: string | undefined): void {
  if (!validPass(pass)) throw new GameError(401, "locked", "This page is locked");
}

// --- What the page shows -----------------------------------------------------

function modelSummary(model: BehaviorModel | null) {
  if (!model) return null;
  return { trainedAt: model.trainedAt, examples: model.examples, accuracy: model.looAccuracy, signals: topWeights(model, 6) };
}

export async function ownerSummary() {
  const cfg = config();
  const [examples, model, hunts, pool, owed, keys] = await Promise.all([
    readTraining(),
    readModelFile<BehaviorModel>(),
    readHuntRecords(),
    humanPool(),
    prizesOwed(),
    agentKeysForOwner(),
  ]);
  const count = (label: "human" | "agent") => {
    const of = examples.filter((e) => e.label === label);
    return { total: of.length, judgedRight: of.filter((e) => e.judgeCorrect).length };
  };
  const trainedOn = model ? model.examples.human + model.examples.agent : 0;
  return {
    human: count("human"),
    agent: count("agent"),
    model: modelSummary(model),
    retrainEvery: cfg.retrainEvery,
    retrainAfterLosses: cfg.retrainAfterLosses,
    lossesSinceTraining: model ? examples.filter((e) => e.recordedAt > model.trainedAt && e.label === "agent" && !e.judgeCorrect).length : 0,
    runsUntilRetrain: Math.max(0, cfg.retrainEvery - (examples.length - trainedOn)),
    neededPerKind: MIN_EXAMPLES_PER_CLASS,
    llmJudge: cfg.judge.llmEnabled,
    googleSignIn: Boolean(cfg.googleClientId),
    // How often real players pick the person, by how good the decoy was.
    hunting: [1, 2, 3].map((level) => {
      const at = hunts.filter((h) => h.level === level);
      return { level, picks: at.length, correct: at.filter((h) => h.correct).length };
    }),
    huntPool: { answers: pool.length, people: new Set(pool.map((a) => a.sourceEntryId)).size },
    symbol: cfg.tokenSymbol,
    prizesOwed: owed.map((e) => ({
      id: e.id,
      handle: e.handle,
      reason: e.prize!.reason,
      tokens: e.prize!.tokens,
      wallet: e.wallet ?? null,
      wonAt: e.prize!.wonAt,
    })),
    agentKeys: keys,
    usage: await usageSummary(),
    banned: Object.entries(await readBans())
      .map(([id, ban]) => ({ id, ...ban }))
      .sort((x, y) => y.at - x.at),
    banAfterStrikes: cfg.banAfterStrikes,
    seeds: examples.filter((e) => e.source === "seed").length,
    // What agents that fooled the judge said about how, newest first, and the ones still to answer.
    debriefs: (await recentAgents(30))
      .filter((e) => e.debrief)
      .slice(0, 30)
      .map((e) => ({
        id: e.id,
        handle: e.handle,
        builder: keys.find((k) => k.id === e.agentKeyId)?.name ?? "unknown",
        house: Boolean(e.house),
        score: e.result!.score,
        at: e.debrief!.askedAt,
        due: debriefDue(e),
        questions: e.debrief!.questions,
        explanation: e.debrief!.explanation,
        answers: e.debrief!.answers,
        code: e.debrief!.code,
        lessons: e.debrief!.lessons,
      })),
  };
}

/** The chores done after a response has gone out: retrain if it is time, and top up the store of questions. */
export async function housekeeping(): Promise<void> {
  await retrainIfDue().catch((err) => console.error("[retrain] failed:", err));
  await restockQuestions().catch((err) => console.error("[questions] could not restock:", err));
}

// --- What the game spends on Claude ---------------------------------------------

/** Dollars per million tokens, in and out, for the models the game is usually run on. Cache reads cost a twentieth of input; writes a quarter more. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

function tally(calls: UsageRecord[]) {
  const by = new Map<string, { calls: number; input: number; output: number; cached: number; dollars: number | null }>();
  for (const u of calls) {
    const row = by.get(u.purpose) ?? { calls: 0, input: 0, output: 0, cached: 0, dollars: 0 };
    const price = Object.entries(PRICES).find(([id]) => u.model.startsWith(id))?.[1];
    const cost = price ? (u.input * price[0] + u.output * price[1] + u.cacheRead * price[0] * 0.05 + u.cacheWrite * price[0] * 1.25) / 1e6 : null;
    by.set(u.purpose, {
      calls: row.calls + 1,
      input: row.input + u.input + u.cacheWrite,
      output: row.output + u.output,
      cached: row.cached + u.cacheRead,
      dollars: row.dollars === null || cost === null ? null : row.dollars + cost,
    });
  }
  return [...by].map(([purpose, row]) => ({ purpose, ...row })).sort((a, b) => b.input + b.output - (a.input + a.output));
}

/** What the game has used of the model, today and over the last week, by what it was for. */
async function usageSummary() {
  const week = await readUsage(7);
  const startOfToday = new Date(new Date().toISOString().slice(0, 10)).getTime();
  return { today: tally(week.filter((u) => u.at >= startOfToday)), week: tally(week), ceiling: config().llmDailyTokens };
}

// --- Bans ---------------------------------------------------------------------

/** Lift a ban and wipe the strikes behind it. */
export async function liftBan(id: unknown): Promise<void> {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new GameError(400, "bad_id", "Unknown account");
  await updatePlayer(id, (p) => {
    p.banned = undefined;
    p.strikes = [];
  });
  await updateBans((bans) => void delete bans[id]);
}

// --- The training area: seeding real answers ------------------------------------

/** How the trainer is asked to answer, so the store of real answers has the range real players have. */
const DEPTHS = [
  { id: "long", ask: "Go long on this one: three or four sentences, with detail." },
  { id: "normal", ask: "Answer how you normally would." },
  { id: "short", ask: "Keep this one short and lazy: a few words." },
] as const;
type Depth = (typeof DEPTHS)[number]["id"];

/**
 * The next question for whoever is training. The built-in bank is worked
 * through first, then questions are drawn from the same store the game uses,
 * so there is always another one.
 */
export async function nextSeedQuestion() {
  const seeds = (await readTraining()).filter((e) => e.source === "seed");
  const answered = new Set(seeds.flatMap((e) => e.questions.map((q) => q.prompt)));
  const style = seeds.length % 3 === 2 ? "wild" : "you";
  const unused = BANK[style].filter((q) => !answered.has(q.prompt));
  const question = unused.length
    ? unused[Math.floor(Math.random() * unused.length)]
    : await nextQuestion(style === "wild" ? "wild" : "fresh", []);
  // Mostly ordinary answers, with a good share of long and of lazy ones.
  const roll = Math.random();
  const depth = DEPTHS[roll < 0.3 ? 0 : roll < 0.7 ? 1 : 2];
  return {
    question: { prompt: question.prompt, category: question.category, style },
    depth: { id: depth.id, ask: depth.ask },
    answered: seeds.length,
    pool: (await humanPool()).length,
  };
}

/**
 * Take one answer from the training area: a real person's answer, typed and
 * recorded like a player's. It joins the answers players hunt with and the
 * human examples the judge learns from. `person` keeps the trainer from being
 * shown their own answers when they play.
 */
export async function saveSeedAnswer(input: { prompt: unknown; category: unknown; depth: unknown; text: unknown; telemetry: unknown; person?: string }) {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 300) : "";
  if (prompt.length < 8) throw new GameError(400, "bad_question", "That question didn't come through. Skip to the next one.");
  const depth: Depth = DEPTHS.some((d) => d.id === input.depth) ? (input.depth as Depth) : "normal";
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const telemetry = sanitizeTelemetry(input.telemetry);
  const question: Question = { id: `seed-${randomBytes(6).toString("base64url")}`, kind: "text", category: typeof input.category === "string" ? input.category.slice(0, 24) : "seed", prompt, shortOk: depth === "short" };
  const broken = checkAnswer(question, text);
  if (broken) throw new GameError(400, "answer_rejected", broken);
  const features = extractAnswerFeatures("text", text, telemetry);
  // The recording is the point: an answer that wasn't typed here teaches the judge the wrong thing about people.
  if (features.pastedChars > text.length * 0.2 || features.typedChars < text.length * 0.5) {
    throw new GameError(400, "not_typed", "Type it out here rather than pasting. How it is typed is what the game learns from.");
  }
  const took = Math.max(0, telemetry.submittedAt - telemetry.shownAt);
  const answer = { questionId: question.id, text, answeredAt: Date.now(), serverLatencyMs: took, features };
  const all = aggregateFeatures([answer], telemetry.env, telemetry.env?.ua);
  // What the judge would have made of it, from behaviour alone. No model call: training costs nothing.
  const judge = await judgeEntry([question], { id: question.id, answers: [answer] }, all, { useLlm: false });
  const gaps = typingGaps(telemetry);
  await appendTraining({
    entryId: question.id,
    roundId: roundIdFor(),
    recordedAt: Date.now(),
    label: "human",
    cohortId: "trainers",
    source: "seed",
    handle: "trainer",
    player: input.person,
    device: telemetry.env ? deviceOf(telemetry.env) : undefined,
    consent: CONSENT_VERSION,
    questions: [question],
    answers: [{ questionId: question.id, text, serverLatencyMs: took, features, gaps: gaps.length ? gaps : undefined }],
    features: all,
    env: telemetry.env,
    judge,
    judgeCorrect: judge.verdict === "human",
    telemetry: { [question.id]: telemetry },
  });
  clearHuntCache();
  return { saved: true as const, judged: judge.score, next: await nextSeedQuestion() };
}

// --- The judge teaching itself -----------------------------------------------

/**
 * Refit the behaviour model if enough new labelled runs have come in since it
 * was last trained, or if agents have fooled the judge several times since. Agents are labelled by their keys; players by the judge's
 * own confident verdicts. Safe to call often: it does nothing until due.
 */
export async function retrainIfDue(): Promise<boolean> {
  const examples = await readTraining();
  const human = examples.filter((e) => e.label === "human").length;
  const agent = examples.length - human;
  if (human < MIN_EXAMPLES_PER_CLASS || agent < MIN_EXAMPLES_PER_CLASS) return false;
  const model = await readModelFile<BehaviorModel>();
  const trainedOn = model ? model.examples.human + model.examples.agent : 0;
  // Due when enough new runs have come in, or sooner if the judge has been fooled several times since it last trained.
  const losses = model ? examples.filter((e) => e.recordedAt > model.trainedAt && e.label === "agent" && !e.judgeCorrect).length : 0;
  const cfg = config();
  if (model && examples.length - trainedOn < cfg.retrainEvery && losses < cfg.retrainAfterLosses) return false;
  // Recent behaviour matters most, and this keeps training quick however much has been collected.
  const recent = examples.slice(-3000);
  await writeModelFile(trainModel(recent.map((e) => ({ features: e.features, label: e.label }))));
  return true;
}
