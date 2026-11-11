import { randomBytes } from "node:crypto";
import { config } from "./config";
import { llmWriteNextQuestion } from "./judge/llm";
import { randomDrawQuestion, randomTextQuestion } from "./questions";
import type { Question, StepKind } from "./types";

/**
 * What one player gets asked. No two players get the same questions, and
 * nobody can see theirs coming:
 *
 *   1. a fresh question
 *   2. a follow-up to their answer
 *   3. a fresh question on something else
 *   4. a follow-up to that answer
 *   5. a drawing
 *
 * Follow-ups are the part that can't be prepared for: they don't exist until
 * the player has answered. Each question is written the moment it is needed,
 * by the model when it is available and from the built-in bank otherwise.
 */
export const QUESTION_PLAN = ["fresh", "followup", "fresh", "followup", "draw"] as const;

/**
 * A whole game, in order. With hunting on, a player proves they are human and
 * hunts bots in alternating blocks: two questions, three hunts, two questions,
 * three hunts, then the drawing. Follow-ups stay next to the answer they follow.
 */
export function gamePlan(hunting: boolean): StepKind[] {
  return hunting
    ? ["fresh", "followup", "hunt", "hunt", "hunt", "fresh", "followup", "hunt", "hunt", "hunt", "draw"]
    : [...QUESTION_PLAN];
}

/**
 * Left to itself the model keeps coming back to the same handful of subjects,
 * which would make questions guessable. Each fresh question is pointed at one
 * of these at random instead.
 */
const ANGLES = [
  "their shoes or feet", "the fridge", "a neighbour", "their phone screen", "the bathroom", "something they're wearing",
  "the last thing they threw away", "their commute or the street outside", "a childhood snack", "a pet or an animal they saw",
  "the weather where they are", "something that's broken at home", "their bed or how they slept", "a smell from today",
  "a sound nearby", "something sticky, itchy or uncomfortable", "money they wasted", "a chore they're dodging",
  "something they ate today", "an argument about something trivial", "a habit they'd be embarrassed to explain",
  "their hands", "a thing on their desk or table", "the last time they were lost", "a lie they told recently",
  "something they're bad at", "a stranger from this week", "their hair", "a drawer full of junk", "the last thing that made them jump",
  "a relative's annoying saying", "something they keep meaning to fix", "what they'd rather be doing", "a bad purchase",
  "the temperature of the room", "a song stuck in their head", "the last time they were late", "a food they refuse to eat",
  "their handwriting", "something they dropped",
];

export interface Exchange {
  question: Question;
  answer: string;
}

const id = () => `q-${randomBytes(6).toString("base64url")}`;

/** Write question number `index` (0-based) for a session that has had `history` so far. */
export async function nextQuestion(index: number, history: Exchange[]): Promise<Question> {
  const cfg = config();
  const kind = QUESTION_PLAN[index];
  if (kind === "draw") {
    return { ...randomDrawQuestion(), id: id(), kind: "draw" };
  }

  const asked = history.filter((h) => h.question.kind === "text");
  if (cfg.questionSource === "llm" && cfg.judge.llmEnabled) {
    try {
      const written = await llmWriteNextQuestion({
        kind,
        angle: ANGLES[Math.floor(Math.random() * ANGLES.length)],
        history: asked.map((h) => ({ prompt: h.question.prompt, answer: h.answer })),
      });
      return { ...written, id: id(), kind: "text" };
    } catch (err) {
      console.error("[interview] question writer failed; using the question bank:", err);
    }
  }
  const fromBank = randomTextQuestion(
    asked.map((h) => h.question.prompt),
    asked.map((h) => h.question.category),
  );
  return { ...fromBank, id: id(), kind: "text" };
}
