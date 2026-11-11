import { createHash, randomBytes } from "node:crypto";
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
  /** Who wrote it, where known, so nobody is shown their own answers. */
  player?: string;
  questionId: string;
  prompt: string;
  text: string;
  /** The same person's other answers, for the decoy that imitates them. */
  others: string[];
  /** How this answer was typed, as recorded at the time. */
  evidence: Evidence;
}

/** Turn what was recorded about one answer into what a hunter is shown. */
function evidenceOf(text: string, f: Partial<AnswerFeatures> | undefined, device: Device | undefined, gaps?: number[]): Evidence {
  const writingMs = f?.composeMs ?? null;
  const strip = gaps?.length ? gaps.slice(0, STRIP) : undefined;
  return {
    gaps: strip,
    longestPauseMs: strip ? Math.max(...strip) : null,
    keyHoldMs: f?.dwellMean ?? null,
    pointerMoved: f?.pointerSamples === undefined ? null : f.pointerSamples > 0,
    leftPage: (f?.hiddenCount ?? 0) + (f?.focusLoss ?? 0),
    totalMs: f?.clientMs ?? null,
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

/** How many keystrokes of rhythm a hunter is shown. */
const STRIP = 60;

const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const near = (value: number, spread = 0.2) => value * between(1 - spread, 1 + spread);

/**
 * The machine's answer was never typed, so its readings are forged, the way an
 * agent trying to pass would forge them. Like the text, the forgery improves
 * with the level: pasted in an instant, then typed too evenly, then modelled
 * on the real person's own readings.
 */
function forgeEvidence(level: number, decoy: string, person: Evidence): Evidence {
  // What a hunter is shown beyond the basics is forged to the same standard. If the person's own
  // record predates one of these readings, the forgery leaves it out too, so its presence gives nothing away.
  const has = { strip: Boolean(person.gaps?.length), hold: person.keyHoldMs !== null && person.keyHoldMs !== undefined, pointer: person.pointerMoved !== null && person.pointerMoved !== undefined };
  if (level <= 1) {
    const start = Math.round(between(150, 450));
    return {
      device: "desktop", startDelayMs: start, writingMs: 0, charsPerSecond: null, rhythm: null, pauses: 0, corrections: 0, pasted: 1, keyOverlap: null,
      gaps: undefined, longestPauseMs: null, keyHoldMs: null, pointerMoved: has.pointer ? false : null, leftPage: 0, totalMs: start + Math.round(between(200, 600)),
    };
  }
  const phone = person.device === "phone";
  if (level === 2 || person.charsPerSecond === null) {
    const cps = between(6.5, 8.5);
    const start = Math.round(between(1200, 2600));
    const writing = Math.round((decoy.length / cps) * 1000);
    // Too even: every gap within a few percent of the same length.
    const strip = has.strip ? Array.from({ length: Math.min(STRIP, Math.max(1, decoy.length - 1)) }, () => Math.round(near(1000 / cps, 0.12))) : undefined;
    return {
      gaps: strip,
      longestPauseMs: strip ? Math.max(...strip) : null,
      keyHoldMs: has.hold ? Math.round(between(78, 84)) : null,
      pointerMoved: has.pointer ? false : null,
      leftPage: 0,
      totalMs: start + writing + Math.round(between(300, 700)),
      device: person.device,
      startDelayMs: start,
      writingMs: writing,
      charsPerSecond: Number(cps.toFixed(1)),
      rhythm: Number(between(0.16, 0.3).toFixed(2)),
      pauses: 0,
      corrections: Math.random() < 0.3 ? 1 : 0,
      pasted: 0,
      keyOverlap: phone ? null : Number(between(0, 0.04).toFixed(2)),
    };
  }
  const cps = near(person.charsPerSecond);
  const start = person.startDelayMs === null ? Math.round(between(2000, 5000)) : Math.round(near(person.startDelayMs, 0.3));
  const writing = Math.round((decoy.length / cps) * 1000);
  // Modelled on the person: their own gaps, drawn again in a different order and nudged.
  const own = person.gaps ?? [];
  const strip = has.strip ? Array.from({ length: Math.min(STRIP, Math.max(1, decoy.length - 1)) }, () => Math.round(near(own[Math.floor(Math.random() * own.length)], 0.15))) : undefined;
  return {
    gaps: strip,
    longestPauseMs: strip ? Math.max(...strip) : null,
    keyHoldMs: has.hold ? Math.round(near(person.keyHoldMs!, 0.1)) : null,
    pointerMoved: has.pointer ? person.pointerMoved : null,
    leftPage: Math.random() < 0.8 ? (person.leftPage ?? 0) : 0,
    totalMs: start + writing + Math.round(between(400, 1500)),
    device: person.device,
    startDelayMs: start,
    writingMs: writing,
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

/** A few of the items, picked at random. */
const sample = <T,>(items: T[], n: number): T[] => [...items].sort(() => Math.random() - 0.5).slice(0, n);

let cache: { at: number; pool: HumanAnswer[] } | undefined;
const CACHE_MS = 60_000;

/** Every real answer currently available to hunt with. */
export async function humanPool(now = Date.now()): Promise<HumanAnswer[]> {
  if (cache && now - cache.at < CACHE_MS) return cache.pool;
  // Answers grouped by who wrote them in one sitting, so an imitation has other things of theirs to go on.
  const sessions = new Map<string, { questionId: string; prompt: string; text: string; evidence: Evidence; player?: string; sourceEntryId: string }[]>();
  const add = (
    entryId: string,
    player: string | undefined,
    device: Device | undefined,
    questions: { id: string; kind: string; prompt: string }[],
    answers: { questionId: string; text: string; features?: Partial<AnswerFeatures>; gaps?: number[] }[],
    group = entryId,
  ) => {
    const items = answers.flatMap((a) => {
      const q = questions.find((x) => x.id === a.questionId);
      if (!q || q.kind !== "text" || !showable(a.text)) return [];
      const text = a.text.trim();
      return [{ questionId: q.id, prompt: q.prompt, text, evidence: evidenceOf(text, a.features, device, a.gaps), player, sourceEntryId: entryId }];
    });
    if (items.length) sessions.set(group, [...(sessions.get(group) ?? []), ...items]);
  };

  // Players taken to be human: by the judge with confidence, or by hand in the past. Ones the judge
  // labelled must also have agreed to their answers being shown to other players.
  for (const e of await readTraining()) {
    if (e.label !== "human") continue;
    if (e.source === "auto" && !SHOWABLE_CONSENT.test(e.consent ?? "")) continue;
    // Answers given in the training area are one each; everything one trainer wrote counts as one sitting.
    add(e.entryId, e.player, e.device, e.questions, e.answers, e.source === "seed" ? `seed:${e.player ?? e.cohortId}` : e.entryId);
  }

  const pool = [...sessions.values()].flatMap((items) =>
    items.map((item) => ({ ...item, others: sample(items.filter((o) => o !== item), 6).map((o) => o.text) })),
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
  try {
    const text = await llmWriteDecoy({ level, prompt: answer.prompt, words: wordCount(answer.text), samples: answer.others });
    await saveDecoy(key, text);
    return text;
  } catch (err) {
    // The model is unavailable or over its ceiling for the day: a stock machine answer keeps the round playable.
    console.error("[hunt] could not write a decoy; using a stock one:", err);
    return CANNED_DECOYS[Math.floor(Math.random() * CANNED_DECOYS.length)];
  }
}

/** A short name for one real answer, for remembering who has been shown it. */
export const seenKey = (answer: { sourceEntryId: string; prompt: string }) =>
  createHash("sha256").update(`${answer.sourceEntryId}:${answer.prompt}`).digest("hex").slice(0, 12);

/** Who is asking for a hunt: so they never get their own answers, or one they have judged before. */
export interface Hunter {
  /** The game being played. */
  entryId: string;
  /** The person, across their games, where known. */
  person?: string;
  /** Real answers this person has already been shown, in this game or earlier ones. */
  seen: Iterable<string>;
}

/** The real answers that could still be put in front of this person. */
export async function freshFor(hunter: Hunter): Promise<HumanAnswer[]> {
  const seen = new Set(hunter.seen);
  return (await humanPool()).filter(
    (a) => a.sourceEntryId !== hunter.entryId && !(hunter.person && a.player === hunter.person) && !seen.has(seenKey(a)),
  );
}

/**
 * Build the next hunt for a player, or null if there is nothing left to show
 * them. Players never get their own answers, or the same answer twice.
 */
export async function nextHunt(entry: Pick<Entry, "id" | "hunts">, who: { person?: string; seen?: Iterable<string> } = {}): Promise<Hunt | null> {
  const played = entry.hunts ?? [];
  const candidates = await freshFor({ entryId: entry.id, person: who.person, seen: [...(who.seen ?? []), ...played.map(seenKey)] });
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
