import { randomBytes } from "node:crypto";
import { config } from "./config";
import { llmWriteDecoy } from "./judge/llm";
import { readDecoy, readTraining, saveDecoy } from "./store";
import type { AnswerFeatures, Device, Entry, Evidence, Hunt } from "./types";

/**
 * Bot Hunter: the half of a player's game where they do the judging.
 *
 * Each round shows a question with two answers, one typed by a real person
 * and one written by the machine, and the player picks the person. Rounds get
 * harder as the machine's decoy gets better, and a wrong pick ends the game.
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
  /** How this answer was typed, as recorded at the time. */
  evidence: Evidence;
}

/** Turn what was recorded about one answer into what a hunter is shown. */
function evidenceOf(text: string, f: Partial<AnswerFeatures> | undefined, device: Device | undefined): Evidence {
  const writingMs = f?.composeMs ?? null;
  return {
    device: device ?? "unknown",
    startDelayMs: f?.firstInputDelay ?? null,
    writingMs,
    charsPerSecond: writingMs && writingMs > 0 ? Number(((text.length / writingMs) * 1000).toFixed(1)) : null,
    rhythm: f?.ikiCv ?? null,
    pauses: f?.pauses ?? 0,
    corrections: f?.deleteCount ?? 0,
    pasted: text.length && f?.pastedChars ? Math.min(1, f.pastedChars / text.length) : 0,
    keyOverlap: f?.rolloverRatio ?? null,
  };
}

const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const near = (value: number, spread = 0.2) => value * between(1 - spread, 1 + spread);

/**
 * The machine's answer was never typed, so its readings are forged, the way an
 * agent trying to pass would forge them. Like the text, the forgery improves
 * with the level: pasted in an instant, then typed too evenly, then modelled
 * on the real person's own readings.
 */
function forgeEvidence(level: number, decoy: string, person: Evidence): Evidence {
  if (level <= 1) {
    return { device: "desktop", startDelayMs: Math.round(between(150, 450)), writingMs: 0, charsPerSecond: null, rhythm: null, pauses: 0, corrections: 0, pasted: 1, keyOverlap: null };
  }
  const phone = person.device === "phone";
  if (level === 2 || person.charsPerSecond === null) {
    const cps = between(6.5, 8.5);
    return {
      device: person.device,
      startDelayMs: Math.round(between(1200, 2600)),
      writingMs: Math.round((decoy.length / cps) * 1000),
      charsPerSecond: Number(cps.toFixed(1)),
      rhythm: Number(between(0.16, 0.3).toFixed(2)),
      pauses: 0,
      corrections: Math.random() < 0.3 ? 1 : 0,
      pasted: 0,
      keyOverlap: phone ? null : Number(between(0, 0.04).toFixed(2)),
    };
  }
  const cps = near(person.charsPerSecond);
  return {
    device: person.device,
    startDelayMs: person.startDelayMs === null ? Math.round(between(2000, 5000)) : Math.round(near(person.startDelayMs, 0.3)),
    writingMs: Math.round((decoy.length / cps) * 1000),
    charsPerSecond: Number(cps.toFixed(1)),
    rhythm: person.rhythm === null ? null : Number(near(person.rhythm).toFixed(2)),
    pauses: Math.max(0, person.pauses + Math.round(between(-1, 1))),
    corrections: Math.max(0, person.corrections + Math.round(between(-1, 1))),
    pasted: 0,
    keyOverlap: person.keyOverlap === null ? null : Number(near(person.keyOverlap).toFixed(2)),
  };
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
  const sessions = new Map<string, { questionId: string; prompt: string; text: string; evidence: Evidence }[]>();
  const add = (
    entryId: string,
    device: Device | undefined,
    questions: { id: string; kind: string; prompt: string }[],
    answers: { questionId: string; text: string; features?: Partial<AnswerFeatures> }[],
  ) => {
    const items = answers.flatMap((a) => {
      const q = questions.find((x) => x.id === a.questionId);
      if (!q || q.kind !== "text" || !showable(a.text)) return [];
      const text = a.text.trim();
      return [{ questionId: q.id, prompt: q.prompt, text, evidence: evidenceOf(text, a.features, device) }];
    });
    if (items.length) sessions.set(entryId, items);
  };

  // Players taken to be human: by the judge with confidence, or by hand in the past. Ones the judge
  // labelled must also have agreed to their answers being shown to other players.
  for (const e of await readTraining()) {
    if (e.label !== "human") continue;
    if (e.source === "auto" && !SHOWABLE_CONSENT.test(e.consent ?? "")) continue;
    add(e.entryId, e.device, e.questions, e.answers);
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
    evidence: (() => {
      const forged = forgeEvidence(level, decoy, answer.evidence);
      return humanIndex === 0 ? [answer.evidence, forged] : [forged, answer.evidence];
    })(),
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
