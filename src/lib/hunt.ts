import { randomBytes } from "node:crypto";
import { config } from "./config";
import { llmWriteDecoy } from "./judge/llm";
import { readDecoy, readTraining, saveDecoy } from "./store";
import type { Entry, Hunt } from "./types";

/**
 * Bot Hunter: the half of a player's game where they do the judging.
 *
 * Each round shows a question with two answers, one typed by a real person
 * and one written by the machine, and the player picks the person. Rounds get
 * harder as the machine's decoy gets better, and a wrong pick ends the climb.
 * A player who clears enough rounds wins the hunter prize.
 *
 * The real answers come from other players: people the owner has confirmed as
 * human by hand in the past, and players the judge was confident about who
 * agreed to their answers being shown. So every player who proves they are
 * human also supplies the material other players hunt with.
 */

/** The level of each hunting round, in order. The number of rounds is the height of the ladder. */
export const HUNT_LEVELS = [1, 2, 2, 3, 3, 3];
/** The first notice wording under which players agreed to their answers being shown to others. */
const SHOWABLE_CONSENT = /^v([3-9]|\d\d+)$/;
/** Hunting is switched on once there is at least this much real material to hunt with. */
export const MIN_POOL = 8;

export interface HumanAnswer {
  sourceEntryId: string;
  questionId: string;
  prompt: string;
  text: string;
  /** The same person's other answers, for the decoy that imitates them. */
  others: string[];
}

/** Whether a player's answer is fit to put in front of other players. */
function showable(text: string): boolean {
  const t = text.trim();
  if (t.length < 12 || t.length > 300) return false;
  // Keep contact details and links out of other people's games.
  return !/https?:|www\.|@\w+\.\w|\b\d[\d\s().-]{7,}\d\b/i.test(t);
}

let cache: { at: number; pool: HumanAnswer[] } | undefined;
const CACHE_MS = 60_000;

/** Every real answer currently available to hunt with. */
export async function humanPool(now = Date.now()): Promise<HumanAnswer[]> {
  if (cache && now - cache.at < CACHE_MS) return cache.pool;
  const sessions = new Map<string, { questionId: string; prompt: string; text: string }[]>();
  const add = (entryId: string, questions: { id: string; kind: string; prompt: string }[], answers: { questionId: string; text: string }[]) => {
    const items = answers.flatMap((a) => {
      const q = questions.find((x) => x.id === a.questionId);
      return q && q.kind === "text" && showable(a.text) ? [{ questionId: q.id, prompt: q.prompt, text: a.text.trim() }] : [];
    });
    if (items.length) sessions.set(entryId, items);
  };

  // Players taken to be human: by the judge with confidence, or by hand in the past. Ones the judge
  // labelled must also have agreed to their answers being shown to other players.
  for (const e of await readTraining()) {
    if (e.label !== "human") continue;
    if (e.source === "auto" && !SHOWABLE_CONSENT.test(e.consent ?? "")) continue;
    add(e.entryId, e.questions, e.answers);
  }

  const pool = [...sessions].flatMap(([sourceEntryId, items]) =>
    items.map((item) => ({ ...item, sourceEntryId, others: items.filter((o) => o !== item).map((o) => o.text) })),
  );
  cache = { at: now, pool };
  return pool;
}

export function clearHuntCache(): void {
  cache = undefined;
}

/** Whether there is enough real material for games to include hunting. */
export async function huntingAvailable(): Promise<boolean> {
  if (config().hunting === "off") return false;
  return (await humanPool()).length >= MIN_POOL;
}

/**
 * Stand-in decoys for when there is no model to write them (no API key).
 * They are plainly machine-like, so hunting still works but stays easy.
 */
const CANNED_DECOYS = [
  "That's a great question! While experiences vary from person to person, I would say it comes down to a combination of habit, environment, and personal preference.",
  "Certainly! There are several factors to consider here, and the answer often depends on the individual and the context.",
  "As an AI, I don't have personal experiences, but many people find this to be a relatable and thought-provoking topic.",
  "It's important to note that this varies widely. A common answer would be something familiar and comforting that often goes unnoticed.",
  "This is a fascinating prompt. If I had to choose, I would select the option that balances practicality with personal meaning.",
  "Honestly, it is difficult to pick just one. Upon reflection, the answer lies in appreciating the nuances of the situation.",
];

const wordCount = (text: string) => text.trim().split(/\s+/).length;

/** The machine's answer to the same question, at the given level. Written once per answer and level, then reused. */
async function decoyFor(answer: HumanAnswer, level: number): Promise<string> {
  const key = `${answer.sourceEntryId}_${answer.questionId}_L${level}`.replace(/[^A-Za-z0-9_-]/g, "-");
  if (!config().judge.llmEnabled) return CANNED_DECOYS[Math.floor(Math.random() * CANNED_DECOYS.length)];
  const saved = await readDecoy(key);
  if (saved) return saved;
  const text = await llmWriteDecoy({ level, prompt: answer.prompt, words: wordCount(answer.text), samples: answer.others });
  await saveDecoy(key, text);
  return text;
}

/**
 * Build the next hunt for a player, or null if there is nothing left to show
 * them. Players never get their own answers, or the same answer twice.
 */
export async function nextHunt(entry: Pick<Entry, "id" | "hunts">): Promise<Hunt | null> {
  const played = entry.hunts ?? [];
  const seen = new Set(played.map((h) => `${h.sourceEntryId}:${h.prompt}`));
  const candidates = (await humanPool()).filter(
    (a) => a.sourceEntryId !== entry.id && !seen.has(`${a.sourceEntryId}:${a.prompt}`),
  );
  if (!candidates.length) return null;

  let level = HUNT_LEVELS[Math.min(played.length, HUNT_LEVELS.length - 1)];
  // Imitating someone needs something of theirs to go on.
  const imitable = candidates.filter((a) => a.others.length > 0);
  if (level >= 3 && !imitable.length) level = 2;
  const from = level >= 3 ? imitable : candidates;
  const answer = from[Math.floor(Math.random() * from.length)];
  const decoy = await decoyFor(answer, level);
  if (decoy.toLowerCase() === answer.text.toLowerCase()) return null;

  const humanIndex: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
  return {
    id: `h-${randomBytes(6).toString("base64url")}`,
    level,
    prompt: answer.prompt,
    options: humanIndex === 0 ? [answer.text, decoy] : [decoy, answer.text],
    humanIndex,
    sourceEntryId: answer.sourceEntryId,
    servedAt: Date.now(),
  };
}

/** How far up the ladder a player got: the rounds they cleared before a miss, or all of them. */
export function huntScore(hunts: Hunt[] | undefined): { cleared: number; played: number; fell: boolean } {
  const done = (hunts ?? []).filter((h) => h.pick !== undefined);
  return { cleared: done.filter((h) => h.correct).length, played: done.length, fell: done.some((h) => !h.correct) };
}
