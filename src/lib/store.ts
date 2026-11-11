import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { AgentKey, AnswerTelemetry, RoundState, TrainingExample } from "./types";

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
 * Read-modify-write one document atomically. `create` builds it the first
 * time. If another server changed it in the meantime the whole step is redone
 * on the fresh copy, so `fn` may run more than once: it must only change the
 * value it is given, and keep quick.
 */
async function updateDoc<V, T>(key: string, fn: (value: V) => T | Promise<T>, create?: () => Promise<V>): Promise<T> {
  return withLock(key, async () => {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const doc = await backend().getDoc<V>(key);
      let value = doc?.value;
      if (value === undefined) {
        if (!create) throw new Error(`${key} does not exist`);
        value = await create();
      }
      const result = await fn(value);
      if (await backend().putDoc(key, value, doc ? doc.version : 0)) return result;
      await sleep(20 + Math.random() * 60 * (attempt + 1));
    }
    throw new Error(`${key} is too busy to update`);
  });
}

/** Read-modify-write a round atomically. `create` builds the round the first time it is touched. */
export async function updateRound<T>(
  roundId: string,
  fn: (state: RoundState) => T | Promise<T>,
  create?: () => Promise<RoundState>,
): Promise<T> {
  return updateDoc(roundKey(roundId), fn, create);
}

// ---------------------------------------------------------------------------
// Agent keys
// ---------------------------------------------------------------------------

const AGENT_KEYS = "agents/keys";

export async function readAgentKeys(): Promise<Record<string, AgentKey>> {
  return (await backend().getDoc<Record<string, AgentKey>>(AGENT_KEYS))?.value ?? {};
}

export async function updateAgentKeys<T>(fn: (keys: Record<string, AgentKey>) => T): Promise<T> {
  return updateDoc(AGENT_KEYS, fn, async () => ({}));
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
// What the game spends on Claude
// ---------------------------------------------------------------------------

/** One call to the model: what it was for and what it cost in tokens. */
export interface UsageRecord {
  at: number;
  /** "judge", "question", "questions" (a batch), "decoy", "debrief". */
  purpose: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

export async function appendUsage(record: UsageRecord): Promise<void> {
  await backend().append(`usage/${dayOf(record.at)}`, record);
}

/** Calls made in the last `days` days, today included. */
export async function readUsage(days = 1): Promise<UsageRecord[]> {
  return backend().readLog<UsageRecord>(`usage/${dayOf(Date.now() - (days - 1) * 86_400_000)}`, "usage/~");
}

// ---------------------------------------------------------------------------
// Questions written ahead of time
// ---------------------------------------------------------------------------

/** Fresh questions waiting to be asked. Each is used once. */
export interface QuestionPool {
  you: { category: string; prompt: string; shortOk?: boolean }[];
  wild: { category: string; prompt: string; shortOk?: boolean }[];
  /** When a top-up was last started, so two servers don't both write one. */
  restockingAt?: number;
}

const QUESTION_POOL = "questions/pool";

export async function readQuestionPool(): Promise<QuestionPool> {
  return (await backend().getDoc<QuestionPool>(QUESTION_POOL))?.value ?? { you: [], wild: [] };
}

export async function updateQuestionPool<T>(fn: (pool: QuestionPool) => T): Promise<T> {
  return updateDoc<QuestionPool, T>(QUESTION_POOL, fn, async () => ({ you: [], wild: [] }));
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/** What the game remembers about one person on the human side, across their games. */
export interface PlayerRecord {
  /** Games started. */
  games: number;
  /** The handle they last played under, so they aren't asked again. */
  handle?: string;
  /** The real answers they have been shown in hunting rounds, so they are never shown one twice. */
  seen: string[];
  /** Prize tokens credited to them, and how many of those have been sent. The difference is their balance. */
  won?: number;
  paid?: number;
  /** Where they have asked for their balance to be sent. */
  wallet?: string;
  /** Games of theirs that were broken off for breaking the rules. Enough of these and the account is banned. */
  strikes?: { at: number; reason: string }[];
  banned?: { at: number; reason: string };
  firstAt: number;
  lastAt: number;
}

const playerKey = (id: string) => {
  if (!SAFE_ID.test(id)) throw new Error("Invalid player id");
  return `players/${id}`;
};

export async function readPlayer(id: string): Promise<PlayerRecord | null> {
  return (await backend().getDoc<PlayerRecord>(playerKey(id)))?.value ?? null;
}

export async function updatePlayer<T>(id: string, fn: (player: PlayerRecord) => T): Promise<T> {
  return updateDoc<PlayerRecord, T>(
    playerKey(id),
    (player) => {
      player.lastAt = Date.now();
      return fn(player);
    },
    async () => ({ games: 0, seen: [], firstAt: Date.now(), lastAt: Date.now() }),
  );
}

/** The accounts currently banned, so the owner can see them and lift a ban. Player records can't be listed. */
export type BanList = Record<string, { at: number; reason: string; handle?: string }>;

const BANS = "players-banned";

export async function readBans(): Promise<BanList> {
  return (await backend().getDoc<BanList>(BANS))?.value ?? {};
}

export async function updateBans<T>(fn: (bans: BanList) => T): Promise<T> {
  return updateDoc<BanList, T>(BANS, fn, async () => ({}));
}

// ---------------------------------------------------------------------------
// Bot Hunter
// ---------------------------------------------------------------------------

/** A machine-written decoy answer, kept so the same decoy is reused rather than rewritten. */
export async function readDecoy(key: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error("Invalid decoy key");
  return (await backend().getDoc<{ text: string }>(`decoys/${key}`))?.value.text ?? null;
}

export async function saveDecoy(key: string, text: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error("Invalid decoy key");
  await backend().putDoc(`decoys/${key}`, { text }, null);
}

/** One player's pick in one hunt: what they were shown and whether they found the person. */
export interface HuntRecord {
  at: number;
  roundId: string;
  hunterEntryId: string;
  /** Who the hunter was, across their games: see TrainingExample.player. */
  hunter?: string;
  sourceEntryId: string;
  level: number;
  prompt: string;
  human: string;
  decoy: string;
  correct: boolean;
  /** How long the hunter took to decide. */
  ms: number;
  /** What the hunter said gave the machine away. */
  reason?: string;
}

export async function appendHuntRecord(record: HuntRecord): Promise<void> {
  await withLock("hunts", () => backend().append(`hunts/${record.roundId}`, record));
}

/** Hunting picks, oldest first. `days` limits it to the last so many days. */
export async function readHuntRecords(days?: number): Promise<HuntRecord[]> {
  const from = days ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : "";
  return backend().readLog<HuntRecord>(`hunts/${from}`, "hunts/~");
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/** Something a signed-in player wanted the owner to read. */
export interface FeedbackRecord {
  at: number;
  /** Who wrote it: the same one-way id the game knows them by. */
  player: string;
  /** What the board calls them, if they have played. */
  handle?: string;
  /** The page they were on. */
  page?: string;
  /** Where to reply, if they asked for one. */
  email?: string;
  text: string;
}

export async function appendFeedback(record: FeedbackRecord): Promise<void> {
  await backend().append(`feedback/${dayOf(record.at)}`, record);
}

/** Messages from the last `days` days, today included. */
export async function readFeedback(days = 30): Promise<FeedbackRecord[]> {
  return backend().readLog<FeedbackRecord>(`feedback/${dayOf(Date.now() - (days - 1) * 86_400_000)}`, "feedback/~");
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
