import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { AnswerTelemetry, RoundState, TrainingExample } from "./types";

/**
 * File-backed storage. Everything lives under the data directory:
 *
 *   data/rounds/<round>.json                  round, entries, payment records
 *   data/telemetry/<round>/<entry>.json       raw telemetry per question
 *   data/training/<round>.jsonl               labelled examples (the training set)
 *   data/model/behavior-model.json            the trained behaviour model
 *
 * This suits local play and a single server. A serverless deployment needs the
 * same handful of functions backed by a database instead; nothing outside this
 * file touches the disk layout.
 */

const dir = (...parts: string[]) => path.join(config().dataDir, ...parts);

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Write to a temp file and rename, so a crash can't leave a half-written file. */
async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value));
  await fs.rename(tmp, file);
}

// One queue per key, shared across module instances in this process.
const globalLocks = globalThis as unknown as { __pmhLocks?: Map<string, Promise<unknown>> };
const locks = (globalLocks.__pmhLocks ??= new Map());

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}

const ROUND_ID = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function roundFile(roundId: string): string {
  if (!ROUND_ID.test(roundId)) throw new Error(`Invalid round id: ${roundId}`);
  return dir("rounds", `${roundId}.json`);
}

export async function readRound(roundId: string): Promise<RoundState | null> {
  if (!ROUND_ID.test(roundId)) return null;
  return readJson<RoundState>(roundFile(roundId));
}

/**
 * Read-modify-write a round atomically. `create` builds the round the first
 * time it is touched. Keep `fn` quick: it holds the round's lock.
 */
export async function updateRound<T>(
  roundId: string,
  fn: (state: RoundState) => T | Promise<T>,
  create?: () => Promise<RoundState>,
): Promise<T> {
  return withLock(`round:${roundId}`, async () => {
    let state = await readJson<RoundState>(roundFile(roundId));
    if (!state) {
      if (!create) throw new Error(`Round ${roundId} does not exist`);
      state = await create();
    }
    const result = await fn(state);
    await writeJson(roundFile(roundId), state);
    return result;
  });
}

export async function listRoundIds(): Promise<string[]> {
  try {
    const files = await fs.readdir(dir("rounds"));
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter((id) => ROUND_ID.test(id))
      .sort();
  } catch {
    return [];
  }
}

// --- Raw telemetry ---------------------------------------------------------

function telemetryFile(roundId: string, entryId: string): string {
  if (!ROUND_ID.test(roundId) || !SAFE_ID.test(entryId)) throw new Error("Invalid telemetry path");
  return dir("telemetry", roundId, `${entryId}.json`);
}

export async function saveTelemetry(
  roundId: string,
  entryId: string,
  questionId: string,
  raw: AnswerTelemetry,
): Promise<void> {
  const file = telemetryFile(roundId, entryId);
  await withLock(`telemetry:${entryId}`, async () => {
    const all = (await readJson<Record<string, AnswerTelemetry>>(file)) ?? {};
    all[questionId] = raw;
    await writeJson(file, all);
  });
}

export async function readTelemetry(roundId: string, entryId: string): Promise<Record<string, AnswerTelemetry>> {
  return (await readJson<Record<string, AnswerTelemetry>>(telemetryFile(roundId, entryId))) ?? {};
}

// --- Training data ---------------------------------------------------------

export async function appendTraining(example: TrainingExample): Promise<void> {
  const file = dir("training", `${example.roundId}.jsonl`);
  await withLock("training", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(example) + "\n");
  });
}

/** All training examples, oldest first. `lastFiles` limits how many days are read. */
export async function readTraining(lastFiles?: number): Promise<TrainingExample[]> {
  let files: string[];
  try {
    files = (await fs.readdir(dir("training"))).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  if (lastFiles) files = files.slice(-lastFiles);
  const out: TrainingExample[] = [];
  for (const f of files) {
    const text = await fs.readFile(dir("training", f), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim()) out.push(JSON.parse(line) as TrainingExample);
    }
  }
  return out;
}

// --- Behaviour model -------------------------------------------------------

export const modelFile = () => dir("model", "behavior-model.json");

export async function readModelFile<T>(): Promise<T | null> {
  return readJson<T>(modelFile());
}

export async function writeModelFile(model: unknown): Promise<void> {
  await writeJson(modelFile(), model);
}
