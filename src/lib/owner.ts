import { createHmac, timingSafeEqual } from "node:crypto";
import { agentKeysForOwner } from "./agents";
import { config, ownerPassword } from "./config";
import { GameError, debriefDue, prizesOwed, recentAgents } from "./game";
import { humanPool } from "./hunt";
import { MIN_EXAMPLES_PER_CLASS, topWeights, trainModel, type BehaviorModel } from "./judge/model";
import { readHuntRecords, readModelFile, readTraining, writeModelFile } from "./store";

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
