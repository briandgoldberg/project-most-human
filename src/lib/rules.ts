import { MAX_ANSWER_CHARS } from "./questions";
import type { GamePlay, Question } from "./types";

/**
 * The rules of play, checked before an answer is accepted, for people and
 * agents alike. An answer that breaks one is sent back with the reason and
 * the player tries again. These are about playing properly, not about who is
 * playing: that is the judge's job.
 */

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);
const letters = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Mostly plain Latin letters, where "does this look like words" can be asked at all. */
const latin = (text: string) => {
  const all = text.replace(/[^\p{L}]/gu, "");
  return all.length > 0 && all.replace(/[^a-zA-Z]/g, "").length / all.length > 0.8;
};

/** Keyboard mashing: Latin text where hardly any "word" could be said aloud. */
function mashed(text: string): boolean {
  if (!latin(text)) return false;
  const tokens = words(text).map((w) => w.replace(/[^a-zA-Z]/g, "")).filter((w) => w.length >= 4);
  if (tokens.length === 0) return false;
  const unsayable = tokens.filter((w) => !/[aeiouy]/i.test(w) || /[^aeiouy]{6,}/i.test(w) || /(.)\1{3,}/.test(w));
  return unsayable.length / tokens.length > 0.5;
}

/**
 * What is wrong with a typed answer, in words the player can act on, or null
 * if it will do. `earlier` is what they have already said this game.
 */
export function checkAnswer(question: Pick<Question, "prompt" | "shortOk">, text: string, earlier: string[] = []): string | null {
  const said = text.trim();
  if (!said) return "Say something.";
  if (said.length > MAX_ANSWER_CHARS) return `Keep it under ${MAX_ANSWER_CHARS} characters.`;
  if (!/[\p{L}\p{N}]/u.test(said)) return "Use words.";
  if (/^(.)\1+$/.test(letters(said)) && letters(said).length > 1) return "That isn't an answer.";
  if (mashed(said)) return "That looks like keyboard mashing. Answer in words.";
  // Languages written without spaces can say plenty in one "word".
  const spaced = /\s/.test(said) || latin(said);
  if (!question.shortOk && spaced && words(said).length < 3) return "This one needs more than a word or two.";
  const mine = letters(said);
  if (mine.length >= 8 && letters(question.prompt).includes(mine)) return "Answer the question, don't repeat it.";
  if (mine.length >= 4 && earlier.some((e) => letters(e) === mine)) return "You've said that already. Say something new.";
  return null;
}

/** What is wrong with what came back from a mini-game, or null if it was played through. */
export function checkGame(question: Pick<Question, "kind" | "game">, play: GamePlay | undefined): string | null {
  if (question.kind === "tap") {
    const goes = question.game?.waits?.length ?? 0;
    if (!play?.taps || play.taps.length !== goes) return "Finish the game first: tap on every light.";
  }
  if (question.kind === "hold") {
    const tries = question.game?.tries ?? 0;
    if (!play?.holds || play.holds.length !== tries || play.holds.some((h) => h < 50)) return "Finish the game first: every try needs a hold.";
  }
  if (question.kind === "aim") {
    const dots = question.game?.targets?.length ?? 0;
    if (!play?.hits || play.hits.length !== dots || play.offsets?.length !== dots) return "Finish the game first: hit every dot.";
  }
  if (question.kind === "beat") {
    const gaps = Math.max(0, (question.game?.beats ?? 0) - 1);
    if (!play?.beatGaps || play.beatGaps.length !== gaps || play.beatGaps.some((g) => g < 50)) return "Finish the game first: tap the whole beat back.";
  }
  if (question.kind === "recall") {
    const length = question.game?.sequence?.length ?? 0;
    if (!play?.picks || play.picks.length !== length || play.pickGaps?.length !== length) return "Finish the game first: press a pad for every step.";
  }
  return null;
}

/** What a player did in a mini-game, in words, for the judge to read alongside their answers. */
export function describePlay(question: Pick<Question, "kind" | "game">, play: GamePlay | undefined): string | undefined {
  if (question.kind === "tap" && play?.taps) {
    const early = play.early ? ` Tapped before the light ${play.early} time${play.early === 1 ? "" : "s"}.` : "";
    return `Reaction game, ${play.taps.length} goes. Reacted in ${play.taps.map((t) => Math.round(t)).join(", ")} ms.${early}`;
  }
  if (question.kind === "hold" && play?.holds) {
    const target = ((question.game?.holdMs ?? 0) / 1000).toFixed(1);
    return `Timing game: hold a button for ${target}s with no clock. Held for ${play.holds.map((h) => (h / 1000).toFixed(2)).join("s, ")}s.`;
  }
  if (question.kind === "aim" && play?.hits) {
    const off = (play.offsets ?? []).map((o) => `${Math.round(o * 100)}%`).join(", ");
    const missed = play.misses ? ` Missed ${play.misses} time${play.misses === 1 ? "" : "s"}.` : "";
    return `Aim game, ${play.hits.length} dots. Reached them in ${play.hits.map((t) => Math.round(t)).join(", ")} ms, landing ${off} of the way from centre to edge.${missed}`;
  }
  if (question.kind === "beat" && play?.beatGaps) {
    const beat = ((question.game?.beatMs ?? 0) / 1000).toFixed(2);
    return `Rhythm game: shown a pulse every ${beat}s, then tapped it back. Gaps between taps: ${play.beatGaps.map((g) => (g / 1000).toFixed(2)).join("s, ")}s.`;
  }
  if (question.kind === "recall" && play?.picks) {
    const sequence = question.game?.sequence ?? [];
    const right = sequence.filter((pad, i) => play.picks![i] === pad).length;
    const pace = (play.pickGaps ?? []).slice(1).map((g) => Math.round(g)).join(", ");
    return `Memory game: shown ${sequence.length} pads lighting in order, then pressed them back. Got ${right} of ${sequence.length} right, ${pace} ms between presses.`;
  }
  return undefined;
}

/** The least time a mini-game can take to play, in ms: the server's check that it really was played. */
export function leastGameTime(question: Pick<Question, "kind" | "game">, play: GamePlay | undefined): number {
  if (question.kind === "tap") return (question.game?.waits ?? []).reduce((n, w) => n + w, 0);
  if (question.kind === "hold") return (play?.holds ?? []).reduce((n, h) => n + h, 0);
  const spec = question.game ?? {};
  const sum = (xs: number[] | undefined) => (xs ?? []).reduce((n, x) => n + x, 0);
  // The waits between dots, plus however long each took to reach.
  if (question.kind === "aim") return (spec.targets?.length ?? 0) * (spec.gapMs ?? 0) + sum(play?.hits);
  // Watching the pulses, then tapping them back.
  if (question.kind === "beat") return Math.max(0, (spec.pulses ?? 0) - 1) * (spec.beatMs ?? 0) + sum(play?.beatGaps);
  // Watching the pads light, then pressing them.
  if (question.kind === "recall") return (spec.sequence?.length ?? 0) * (spec.showMs ?? 0) + sum(play?.pickGaps);
  return 0;
}
