import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { AnswerTelemetry, RoundState, TrainingExample } from "./types";

/**
 * Storage. Three kinds of thing are kept:
 *
 *   round/<round>                 the round, its entries and payment records
 *   telemetry/<round>/<entry>     raw telemetry per question
 *   training/<round>              labelled examples (the training set), append-only
 *   model/behavior                the trained behaviour model
 *
 * Two backends hold them:
 *
 *   Files under data/ (the default). Right for local play and a single server
 *   with a disk.
 *
 *   A Postgres database on Supabase, used when SUPABASE_URL is set. Needed on
 *   serverless hosts such as Vercel, which keep no files and run many copies
 *   of the server at once. See supabase/migrations/0001_store.sql.
 *
 * Nothing outside this file knows which is in use.
 */

interface Doc<T> {
  value: T;
  version: number;
}

interface Backend {
  getDoc<T>(key: string): Promise<Doc<T> | null>;
  /** expected: null = overwrite, 0 = only if absent, n = only if still at version n. False = someone else got there first. */
  putDoc(key: string, value: unknown, expected: number | null): Promise<boolean>;
  append(stream: string, value: unknown): Promise<void>;
  /** Records from streams in [from, to), oldest first. `strip` drops one bulky field from each. */
  readLog<T>(from: string, to: string, strip?: string): Promise<T[]>;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const fileBackend: Backend = {
  async getDoc<T>(key: string) {
    try {
      return { value: JSON.parse(await fs.readFile(docPath(key), "utf8")) as T, version: 1 };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  // One process owns the files and writers queue on an in-process lock, so there are no versions to check.
  async putDoc(key, value) {
    const file = docPath(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write to a temp file and rename, so a crash can't leave a half-written file.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value));
    await fs.rename(tmp, file);
    return true;
  },
  async append(stream, value) {
    const file = path.join(config().dataDir, `${stream}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(value) + "\n");
  },
  async readLog<T>(from: string, to: string, strip?: string) {
    const folder = from.split("/")[0];
    const dir = path.join(config().dataDir, folder);
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const f of files) {
      const stream = `${folder}/${f.slice(0, -6)}`;
      if (stream < from || stream >= to) continue;
      for (const line of (await fs.readFile(path.join(dir, f), "utf8")).split("\n")) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as Record<string, unknown>;
        if (strip) delete record[strip];
        out.push(record as T);
      }
    }
    return out;
  },
};

/** round/2026-01-01 -> data/rounds/2026-01-01.json, keeping the original on-disk layout. */
function docPath(key: string): string {
  const [kind, ...rest] = key.split("/");
  const folder = kind === "round" ? "rounds" : kind;
  return path.join(config().dataDir, folder, ...rest) + ".json";
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { url, key, secret } = config().supabase;
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: key! },
    body: JSON.stringify({ p_secret: secret, ...args }),
    cache: "no-store",
  });
  if (!res.ok) {
    // Never include the request in the error: it carries the store secret.
    throw new Error(`Database call ${fn} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

const supabaseBackend: Backend = {
  getDoc: <T>(key: string) => rpc<Doc<T> | null>("pmh_get", { p_key: key }),
  putDoc: (key, value, expected) => rpc<boolean>("pmh_put", { p_key: key, p_value: value, p_expected: expected }),
  append: (stream, value) => rpc<void>("pmh_append", { p_stream: stream, p_value: value }),
  readLog: <T>(from: string, to: string, strip?: string) =>
    rpc<T[]>("pmh_read_log", { p_from: from, p_to: to, p_strip: strip ?? null }),
};

function backend(): Backend {
  const { url, key, secret } = config().supabase;
  if (!url) return fileBackend;
  if (!key || !secret) throw new Error("SUPABASE_URL is set, so SUPABASE_PUBLISHABLE_KEY and STORE_SECRET are needed too");
  return supabaseBackend;
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

// One queue per key within this process. Across processes, document versions do the same job.
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

const ROUND_ID = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const MAX_WRITE_ATTEMPTS = 8;

function roundKey(roundId: string): string {
  if (!ROUND_ID.test(roundId)) throw new Error(`Invalid round id: ${roundId}`);
  return `round/${roundId}`;
}

export async function readRound(roundId: string): Promise<RoundState | null> {
  if (!ROUND_ID.test(roundId)) return null;
  return (await backend().getDoc<RoundState>(roundKey(roundId)))?.value ?? null;
}

/**
 * Read-modify-write a round atomically. `create` builds the round the first
 * time it is touched. If another server changed the round in the meantime the
 * whole step is redone on the fresh copy, so `fn` may run more than once: it
 * must only change `state` and keep quick.
 */
export async function updateRound<T>(
  roundId: string,
  fn: (state: RoundState) => T | Promise<T>,
  create?: () => Promise<RoundState>,
): Promise<T> {
  const key = roundKey(roundId);
  return withLock(key, async () => {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const doc = await backend().getDoc<RoundState>(key);
      let state = doc?.value;
      if (!state) {
        if (!create) throw new Error(`Round ${roundId} does not exist`);
        state = await create();
      }
      const result = await fn(state);
      if (await backend().putDoc(key, state, doc ? doc.version : 0)) return result;
      await sleep(20 + Math.random() * 60 * (attempt + 1));
    }
    throw new Error(`Round ${roundId} is too busy to update`);
  });
}

// ---------------------------------------------------------------------------
// Raw telemetry
// ---------------------------------------------------------------------------

function telemetryKey(roundId: string, entryId: string): string {
  if (!ROUND_ID.test(roundId) || !SAFE_ID.test(entryId)) throw new Error("Invalid telemetry key");
  return `telemetry/${roundId}/${entryId}`;
}

export async function saveTelemetry(
  roundId: string,
  entryId: string,
  questionId: string,
  raw: AnswerTelemetry,
): Promise<void> {
  const key = telemetryKey(roundId, entryId);
  // A player answers one question at a time, so only this entry's own requests ever write here.
  await withLock(key, async () => {
    const all = (await backend().getDoc<Record<string, AnswerTelemetry>>(key))?.value ?? {};
    all[questionId] = raw;
    await backend().putDoc(key, all, null);
  });
}

export async function readTelemetry(roundId: string, entryId: string): Promise<Record<string, AnswerTelemetry>> {
  return (await backend().getDoc<Record<string, AnswerTelemetry>>(telemetryKey(roundId, entryId)))?.value ?? {};
}

// ---------------------------------------------------------------------------
// Training data
// ---------------------------------------------------------------------------

/** A training example as read back for judging and reporting: everything but the raw telemetry. */
export type TrainingRecord = Omit<TrainingExample, "telemetry">;

export async function appendTraining(example: TrainingExample): Promise<void> {
  await withLock("training", () => backend().append(`training/${example.roundId}`, example));
}

/** An entry labelled more than once (a correction) counts once, as its latest label. */
function latestPerEntry<T extends { entryId: string }>(records: T[]): T[] {
  const last = new Map<string, number>();
  records.forEach((r, i) => last.set(r.entryId, i));
  return records.filter((r, i) => last.get(r.entryId) === i);
}

/** Training examples, oldest first. `days` limits it to rounds from the last so many days. */
export async function readTraining(days?: number): Promise<TrainingRecord[]> {
  const from = days ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : "";
  return latestPerEntry(await backend().readLog<TrainingRecord>(`training/${from}`, "training/~", "telemetry"));
}

/** The full training set including raw telemetry, for export and offline analysis. */
export async function readTrainingFull(): Promise<TrainingExample[]> {
  return latestPerEntry(await backend().readLog<TrainingExample>("training/", "training/~"));
}

// ---------------------------------------------------------------------------
// Behaviour model
// ---------------------------------------------------------------------------

export async function readModelFile<T>(): Promise<T | null> {
  return (await backend().getDoc<T>("model/behavior-model"))?.value ?? null;
}

export async function writeModelFile(model: unknown): Promise<void> {
  await backend().putDoc("model/behavior-model", model, null);
}

/** Where things are kept, for messages to the operator. */
export function storageName(): string {
  return config().supabase.url ? "the Supabase database" : config().dataDir;
}
