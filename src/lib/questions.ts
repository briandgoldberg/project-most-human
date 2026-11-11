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

export const BANK_SIZE = { text: TEXT_BANK.length, draw: DRAW_BANK.length };
