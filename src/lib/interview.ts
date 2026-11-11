import { randomBytes } from "node:crypto";
import { config } from "./config";
import { llmWriteNextQuestion } from "./judge/llm";
import { randomDrawQuestion, randomTextQuestion } from "./questions";
import type { Question } from "./types";

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
 * by the model when it is available and from the built-in bank otherwise, and
 * each comes with a time limit.
 */
export const QUESTION_PLAN = ["fresh", "followup", "fresh", "followup", "draw"] as const;

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
    return { ...randomDrawQuestion(), id: id(), kind: "draw", seconds: cfg.drawSeconds };
  }

  const asked = history.filter((h) => h.question.kind === "text");
  if (cfg.questionSource === "llm" && cfg.judge.llmEnabled) {
    try {
      const written = await llmWriteNextQuestion({
        kind,
        history: asked.map((h) => ({ prompt: h.question.prompt, answer: h.answer })),
      });
      return { ...written, id: id(), kind: "text", seconds: cfg.questionSeconds };
    } catch (err) {
      console.error("[interview] question writer failed; using the question bank:", err);
    }
  }
  const fromBank = randomTextQuestion(
    asked.map((h) => h.question.prompt),
    asked.map((h) => h.question.category),
  );
  return { ...fromBank, id: id(), kind: "text", seconds: cfg.questionSeconds };
}
