import { createHmac, timingSafeEqual } from "node:crypto";
import { cohortForPassword, cohorts, config, type Cohort } from "./config";
import { GameError, boardForLabelling } from "./game";
import { MIN_EXAMPLES_PER_CLASS, topWeights, trainModel, type BehaviorModel } from "./judge/model";
import { readModelFile, readTraining, writeModelFile } from "./store";

/**
 * The private training room: who may enter it, what they see there, and
 * retraining the behaviour model from what has been collected.
 */

export const TRAINING_COOKIE = "pmh_train";
const COOKIE_TTL_S = 12 * 60 * 60;

// --- Access ------------------------------------------------------------------

// The pass is signed with the cohort's own password, so changing the password locks everyone out.
const sign = (cohort: Cohort, expires: number) =>
  createHmac("sha256", cohort.password).update(`${cohort.id}.${expires}`).digest("base64url");

export function trainingPass(cohort: Cohort): { value: string; maxAge: number } {
  const expires = Math.floor(Date.now() / 1000) + COOKIE_TTL_S;
  return { value: `${cohort.id}.${expires}.${sign(cohort, expires)}`, maxAge: COOKIE_TTL_S };
}

export function cohortFromPass(value: string | undefined): Cohort | undefined {
  const [id, expiresRaw, mac] = (value ?? "").split(".");
  const expires = Number(expiresRaw);
  const cohort = cohorts().find((c) => c.id === id);
  if (!cohort || !mac || !Number.isFinite(expires) || expires < Date.now() / 1000) return undefined;
  const expected = Buffer.from(sign(cohort, expires));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given) ? cohort : undefined;
}

// Slow down password guessing: a handful of wrong tries per address, then a wait.
const MAX_FAILURES = 8;
const WINDOW_MS = 10 * 60 * 1000;
const failures = new Map<string, { count: number; resetAt: number }>();

export function checkPassword(password: unknown, clientAddress: string): Cohort {
  const now = Date.now();
  const record = failures.get(clientAddress);
  if (record && record.resetAt > now && record.count >= MAX_FAILURES) {
    throw new GameError(429, "too_many_attempts", "Too many wrong passwords. Try again in a few minutes.");
  }
  const cohort = typeof password === "string" && password ? cohortForPassword(password) : undefined;
  if (!cohort) {
    const current = record && record.resetAt > now ? record : { count: 0, resetAt: now + WINDOW_MS };
    current.count++;
    failures.set(clientAddress, current);
    throw new GameError(403, "bad_password", "That password isn't right");
  }
  failures.delete(clientAddress);
  return cohort;
}

/** The cohort a request is acting for: a signed-in browser, or a bot presenting the password directly. */
export function requireCohort(pass: string | undefined, password: unknown, clientAddress: string): Cohort {
  const fromPass = cohortFromPass(pass);
  if (fromPass) return fromPass;
  if (password !== undefined) return checkPassword(password, clientAddress);
  throw new GameError(401, "locked", "The training room is locked");
}

// --- What the room shows -----------------------------------------------------

function modelSummary(model: BehaviorModel | null) {
  if (!model) return null;
  return {
    trainedAt: model.trainedAt,
    examples: model.examples,
    looAccuracy: model.looAccuracy,
    signals: topWeights(model, 6),
  };
}

export async function trainingSummary(cohort: Cohort) {
  const examples = await readTraining();
  const owner = Boolean(cohort.owner);
  const count = (label: "human" | "agent") => {
    const of = examples.filter((e) => e.label === label);
    return { total: of.length, judgedRight: of.filter((e) => e.judgeCorrect).length };
  };
  const human = count("human");
  const agent = count("agent");
  return {
    cohort: { id: cohort.id, label: cohort.label },
    // Who on the public board is really what is for the owner's eyes only.
    owner,
    board: owner ? await boardForLabelling() : [],
    human,
    agent,
    neededPerKind: MIN_EXAMPLES_PER_CLASS,
    canTrain: human.total >= MIN_EXAMPLES_PER_CLASS && agent.total >= MIN_EXAMPLES_PER_CLASS,
    model: modelSummary(await readModelFile<BehaviorModel>()),
    llmJudge: config().judge.llmEnabled,
    recent: examples
      .filter((e) => owner || e.source !== "board")
      .slice(-40)
      .reverse()
      .map((e) => ({
        id: e.entryId,
        at: e.recordedAt,
        handle: e.handle,
        truth: e.label,
        fromBoard: e.source === "board",
        score: e.judge.score,
        judgeCorrect: e.judgeCorrect,
      })),
  };
}

/** Refit the behaviour model on every labelled session collected so far. */
export async function retrain() {
  const examples = await readTraining();
  let model: BehaviorModel;
  try {
    model = trainModel(examples.map((e) => ({ features: e.features, label: e.label })));
  } catch (err) {
    throw new GameError(409, "not_enough_data", err instanceof Error ? err.message : "Not enough data to train");
  }
  await writeModelFile(model);
  return modelSummary(model);
}
