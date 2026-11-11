import { createHash } from "node:crypto";
import type { Question } from "./types";

/**
 * The house question bank. Normally the judge model writes each player's
 * questions live (see interview.ts) and this bank is the fallback when it
 * can't: no API key, QUESTION_SOURCE=bank, or the model call failing.
 *
 * Good questions are cheap for a person to answer from lived experience and
 * awkward to answer convincingly without one: senses, pettiness, bodies,
 * boredom, specific memories, opinions nobody asked for.
 */
const TEXT_BANK: Omit<Question, "id" | "kind">[] = [
  { category: "senses", prompt: "What does your kitchen smell like right now? If you're not near it, guess." },
  { category: "senses", prompt: "Describe the last thing you ate, badly. Don't make it sound good." },
  { category: "senses", prompt: "What's a sound that instantly annoys you, and where did you last hear it?" },
  { category: "senses", prompt: "What's within arm's reach of you that shouldn't be there?" },
  { category: "senses", prompt: "What's the texture you hate touching most? Why do you think that is?" },
  { category: "body", prompt: "Which part of your body is mildly uncomfortable right now, and what are you doing about it?" },
  { category: "body", prompt: "When did you last stub a toe, bite your tongue, or bang your elbow? What did you say out loud?" },
  { category: "body", prompt: "How do you sit when nobody's watching?" },
  { category: "body", prompt: "What's your worst habit when you're tired?" },
  { category: "petty", prompt: "What's a completely petty opinion you'd defend in an argument?" },
  { category: "petty", prompt: "Name a food everyone loves that you think is overrated. Be rude about it." },
  { category: "petty", prompt: "What's something a neighbour, roommate or coworker does that drives you up the wall?" },
  { category: "petty", prompt: "Which household chore do you put off longest, and what's your excuse?" },
  { category: "petty", prompt: "What's a word or phrase you can't stand hearing?" },
  { category: "memory", prompt: "What's the dumbest way you've ever hurt yourself?" },
  { category: "memory", prompt: "Tell me about a time you waved back at someone who wasn't waving at you, or something equally mortifying." },
  { category: "memory", prompt: "What's a smell that takes you straight back to being a kid?" },
  { category: "memory", prompt: "What's the last thing you lost, and did you find it?" },
  { category: "memory", prompt: "What was on the walls of your childhood bedroom?" },
  { category: "memory", prompt: "What's a lie you told as a kid that got out of hand?" },
  { category: "now", prompt: "What were you doing ten minutes before you opened this page?" },
  { category: "now", prompt: "What's the weather doing outside your nearest window? No checking an app." },
  { category: "now", prompt: "What tabs or apps do you have open that you're ignoring right now?" },
  { category: "now", prompt: "What's the last text you sent, roughly, and who was it to?" },
  { category: "now", prompt: "What are you supposed to be doing instead of this?" },
  { category: "taste", prompt: "What song do you skip every single time it comes on, even though you haven't removed it?" },
  { category: "taste", prompt: "What's your go-to order when you can't be bothered to think?" },
  { category: "taste", prompt: "What's a movie you pretend to have seen?" },
  { category: "taste", prompt: "What's something you bought and immediately regretted?" },
  { category: "quick", prompt: "Don't think: type the first five words that come into your head, then say which one surprised you." },
  { category: "quick", prompt: "Finish this however you want: \"The problem with Mondays is...\"" },
  { category: "quick", prompt: "Explain what a sneeze feels like to someone who has never had one." },
  { category: "quick", prompt: "You've got 20 seconds: what would you grab if you had to leave the house right now?" },
  { category: "quick", prompt: "Mash the keyboard for a second, then explain what you were feeling." },
  { category: "people", prompt: "Who's the last person who made you laugh, and what did they do?" },
  { category: "people", prompt: "What does someone in your family always say that makes you roll your eyes?" },
  { category: "people", prompt: "Describe a stranger you noticed this week and why they stuck with you." },
  { category: "people", prompt: "What's the worst advice anyone's given you with a straight face?" },
  { category: "odd", prompt: "What's a thing you do that you assume everyone does, but have never checked?" },
  { category: "odd", prompt: "What do you think about when you can't sleep?" },
  { category: "odd", prompt: "What's a superstition you don't believe in but follow anyway?" },
  { category: "odd", prompt: "If you had to eat one colour of food for a week, which and what goes wrong?" },
  { category: "odd", prompt: "What's the most useless thing you know by heart?" },
  { category: "meta", prompt: "Why should I believe you're a person? Don't try too hard." },
  { category: "meta", prompt: "What would a bot get wrong about answering this question?" },
];

/**
 * The other kind of question: nothing to do with the player's day, everything
 * to do with how they think. No right answers; people answer these in their
 * own voice, and something averaging everyone's voice answers them blandly.
 */
const WILD_BANK: Omit<Question, "id" | "kind">[] = [
  { category: "wild", prompt: "Invent a holiday nobody asked for. What do people do on it, and what goes wrong every year?" },
  { category: "wild", prompt: "A pigeon is now your boss. What's the first thing it changes at work?" },
  { category: "wild", prompt: "Pick a vegetable to be mayor of your town and say what it would ban." },
  { category: "wild", prompt: "You can only speak in rhymes for a day. What's the hardest errand?" },
  { category: "wild", prompt: "What would the furniture in your home complain about if it could talk?" },
  { category: "wild", prompt: "Design the worst possible theme park ride. What is it called?" },
  { category: "wild", prompt: "Your shadow quits. What was its last straw?" },
  { category: "wild", prompt: "Rank these from most to least trustworthy and defend it: a goose, a vending machine, a clown." },
  { category: "wild", prompt: "You get one useless superpower. Which one, and how do you still manage to misuse it?" },
  { category: "wild", prompt: "Describe the colour blue to someone who is annoyed with you." },
  { category: "wild", prompt: "What's the national anthem of your kitchen? Give me the first line." },
  { category: "wild", prompt: "A ghost haunts you but only does mildly helpful things. Like what?" },
  { category: "wild", prompt: "Rename a day of the week so it's more honest about itself." },
  { category: "wild", prompt: "If your last meal filed a complaint about you, what would it say?" },
  { category: "wild", prompt: "Invent a sport for people who hate running. What are the rules?" },
  { category: "wild", prompt: "The moon sends you a text. What does it say and do you reply?" },
  { category: "wild", prompt: "What crime would a very polite dragon commit?" },
  { category: "wild", prompt: "Sell me a single sock. Make it sound like a bargain." },
  { category: "wild", prompt: "Which household object is secretly judging you, and for what?" },
  { category: "wild", prompt: "You must add one rule to every board game ever. What is it?" },
  { category: "wild", prompt: "Write the warning label that should come attached to you." },
  { category: "wild", prompt: "Cats take over the internet for real this time. What's the first new law?" },
  { category: "wild", prompt: "What would you put in a museum of small disappointments?" },
  { category: "wild", prompt: "Describe your morning as if it were a nature documentary about a clumsy animal." },
];

/** Follow-ups for when no model is on hand to write one about the player's own answer. */
const FOLLOWUP_BANK: Omit<Question, "id" | "kind">[] = [
  { category: "followup", prompt: "Why that, of all things? Give me the real reason." },
  { category: "followup", prompt: "Say more about that. What's the detail you left out?" },
  { category: "followup", prompt: "What would someone who knows you well say about that answer?" },
  { category: "followup", prompt: "How long has that been true, and what changed it?", shortOk: true },
  { category: "followup", prompt: "What happened right after that?" },
];

const DRAW_BANK: Omit<Question, "id" | "kind">[] = [
  { category: "draw", prompt: "Draw a circle. Not a good one. Just a circle.", hint: "Mouse, trackpad or finger." },
  { category: "draw", prompt: "Sign your name, or a name you wish you had.", hint: "Mouse, trackpad or finger." },
  { category: "draw", prompt: "Draw a house in five seconds or less.", hint: "Mouse, trackpad or finger." },
  { category: "draw", prompt: "Draw a star without lifting your pen.", hint: "Mouse, trackpad or finger." },
  { category: "draw", prompt: "Draw the worst cat you can.", hint: "Mouse, trackpad or finger." },
  { category: "draw", prompt: "Draw a spiral, starting from the middle.", hint: "Mouse, trackpad or finger." },
];

export const TEXT_QUESTIONS_PER_ROUND = 4;
export const MAX_ANSWER_CHARS = 600;

/** Deterministic PRNG so a date always maps to the same picks. */
function seeded(seed: string): () => number {
  let a = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: T[], n: number, rand: () => number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length) {
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return out;
}

export function drawQuestionFor(roundId: string, salt = ""): Question {
  const rand = seeded(`${salt}:draw:${roundId}`);
  return { ...pick(DRAW_BANK, 1, rand)[0], id: `${roundId}-draw`, kind: "draw" };
}

/** Today's questions from the bank: text questions from distinct categories, then one drawing. */
export function bankQuestionsFor(roundId: string, salt = ""): Question[] {
  const rand = seeded(`${salt}:text:${roundId}`);
  const categories = pick([...new Set(TEXT_BANK.map((q) => q.category))], TEXT_QUESTIONS_PER_ROUND, rand);
  const text: Question[] = categories.map((category, i) => ({
    ...pick(TEXT_BANK.filter((q) => q.category === category), 1, rand)[0],
    id: `${roundId}-q${i + 1}`,
    kind: "text",
  }));
  return [...text, drawQuestionFor(roundId, salt)];
}

/** One text question from the bank, steering clear of prompts and categories already used. */
export function randomTextQuestion(usedPrompts: string[], usedCategories: string[]): { category: string; prompt: string } {
  const unused = TEXT_BANK.filter((q) => !usedPrompts.includes(q.prompt));
  const fresh = unused.filter((q) => !usedCategories.includes(q.category));
  const pool = fresh.length ? fresh : unused.length ? unused : TEXT_BANK;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function randomDrawQuestion(): { category: string; prompt: string; hint?: string } {
  return DRAW_BANK[Math.floor(Math.random() * DRAW_BANK.length)];
}

/** One imaginative question from the bank that this session hasn't had. */
export function randomWildQuestion(usedPrompts: string[]): { category: string; prompt: string } {
  const unused = WILD_BANK.filter((q) => !usedPrompts.includes(q.prompt));
  const pool = unused.length ? unused : WILD_BANK;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function randomFollowup(usedPrompts: string[]): { category: string; prompt: string; shortOk?: boolean } {
  const unused = FOLLOWUP_BANK.filter((q) => !usedPrompts.includes(q.prompt));
  const pool = unused.length ? unused : FOLLOWUP_BANK;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Every question in the bank of each style, for the training area to work through. */
export const BANK = { you: TEXT_BANK, wild: WILD_BANK };

// --- Mini-games ---------------------------------------------------------------

const between = (lo: number, hi: number) => Math.round(lo + Math.random() * (hi - lo));

/** The mini-games a "game" step can be. A drawing counts as one. */
export const GAME_KINDS = ["draw", "tap", "hold"] as const;
export type GameKind = (typeof GAME_KINDS)[number];

/** Set up one mini-game. The waits and targets are picked here, on the server, and differ every time. */
export function gameQuestion(kind: GameKind): Omit<Question, "id"> {
  if (kind === "tap") {
    return {
      kind: "tap",
      category: "game",
      prompt: "Tap the circle the moment it lights up.",
      hint: "Five goes. Don't jump the gun.",
      game: { waits: Array.from({ length: 5 }, () => between(1200, 3600)) },
    };
  }
  if (kind === "hold") {
    const seconds = [2, 3, 4][Math.floor(Math.random() * 3)];
    return {
      kind: "hold",
      category: "game",
      prompt: `Hold the button down for exactly ${seconds} seconds, then let go.`,
      hint: "Three tries. No clock: count in your head.",
      game: { holdMs: seconds * 1000, tries: 3 },
    };
  }
  return { ...randomDrawQuestion(), kind: "draw" };
}

export const BANK_SIZE = { text: TEXT_BANK.length, draw: DRAW_BANK.length };
