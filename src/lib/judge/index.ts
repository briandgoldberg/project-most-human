import { config } from "../config";
import { readHuntRecords, readModelFile, readTraining, type TrainingRecord } from "../store";
import type { EntryAnswer, Features, JudgeResult, Kind, Question } from "../types";
import { heuristicScore } from "./heuristic";
import { llmDebriefLessons, llmDebriefQuestions, llmJudge, type DebriefQuestionsInput } from "./llm";
import { predictHuman, type BehaviorModel } from "./model";

const MAX_LESSONS = 6;

/**
 * Bump this whenever the judging logic changes (rules, prompt, how scores are
 * blended), so verdicts in the data can be told apart by the judge that made them.
 */
export const JUDGE_VERSION = "3";

/**
 * Pick revealed cases to show the LLM judge: its recent mistakes first, then
 * recent correct calls, balanced between humans and agents.
 */
export function pickLessons(examples: TrainingRecord[], max = MAX_LESSONS): TrainingRecord[] {
  const recentFirst = [...examples].reverse();
  const ordered = [...recentFirst.filter((e) => !e.judgeCorrect), ...recentFirst.filter((e) => e.judgeCorrect)];
  const picked: TrainingRecord[] = [];
  const count: Record<Kind, number> = { human: 0, agent: 0 };
  const perClass = Math.ceil(max / 2);
  for (const e of ordered) {
    if (picked.length >= max) break;
    if (count[e.label] >= perClass) continue;
    count[e.label]++;
    picked.push(e);
  }
  return picked;
}

const MAX_HUNTER_NOTES = 10;

/**
 * Recent explanations from hunters who picked the person correctly against a
 * decoy that wasn't obvious, and who were themselves taken to be human.
 */
export async function hunterNotes(humanEntryIds: Set<string>): Promise<string[]> {
  const records = await readHuntRecords(3);
  return records
    .filter((r) => r.correct && r.level >= 2 && r.reason && r.reason.length >= 12 && humanEntryIds.has(r.hunterEntryId))
    .slice(-MAX_HUNTER_NOTES)
    .map((r) => r.reason!.slice(0, 200));
}

const MAX_AGENT_NOTES = 9;

/** What agents that fooled the judge said about how, already distilled into short notes. Newest last. */
export function agentNotes(examples: TrainingRecord[]): string[] {
  return examples
    .filter((e) => e.label === "agent")
    .flatMap((e) => e.debrief?.lessons ?? [])
    .slice(-MAX_AGENT_NOTES);
}

/** Asked when the judge's own questions can't be had: the AI judge is off, or failed. */
export const STOCK_DEBRIEF_QUESTIONS = [
  "What wrote your agent's answers: which model, with what instructions, and how did it come up with the personal details?",
  "How were the typing, pointer and drawing recordings produced?",
  "What do you think came closest to giving your agent away?",
];

/** The questions an agent that fooled the judge has to answer. Never fails: the stock ones stand in. */
export async function debriefQuestions(input: DebriefQuestionsInput): Promise<string[]> {
  if (!config().judge.llmEnabled) return STOCK_DEBRIEF_QUESTIONS;
  try {
    return await llmDebriefQuestions(input);
  } catch (err) {
    console.error("[debrief] the judge could not write its questions; using the stock ones:", err);
    return STOCK_DEBRIEF_QUESTIONS;
  }
}

/** Notes for the judge from an agent's account of itself. Empty when the AI judge is off or fails: raw text is never passed on. */
export async function debriefLessons(input: { questions: string[]; explanation: string; answers: string[]; code: string }): Promise<string[]> {
  if (!config().judge.llmEnabled) return [];
  try {
    return await llmDebriefLessons(input);
  } catch (err) {
    console.error("[debrief] could not distil a debrief into notes:", err);
    return [];
  }
}

function fallbackQuip(score: number): string {
  if (score >= 85) return "Nobody fakes being this ordinary. I believe you.";
  if (score >= 70) return "Probably a person. Probably.";
  if (score >= 50) return "I could go either way on you, and I don't like that.";
  if (score >= 30) return "Something about you is a little too tidy.";
  return "I've met toasters with more of a pulse.";
}

export interface JudgeOptions {
  /** Force the LLM judge on or off. Defaults to config. */
  useLlm?: boolean;
  model?: BehaviorModel | null;
  lessons?: TrainingRecord[];
}

/**
 * Score one finished entry. Everything the judge may know is in the arguments:
 * the questions, the answers, and the behaviour readings. Who the player is,
 * and whether they are a labelled tester, never comes in here.
 */
export async function judgeEntry(
  questions: Question[],
  entry: { id: string; answers: EntryAnswer[] },
  features: Features,
  opts: JudgeOptions = {},
): Promise<JudgeResult> {
  const cfg = config();
  const heuristic = heuristicScore(features);
  const reasons = [...heuristic.reasons];

  const model = opts.model === undefined ? await readModelFile<BehaviorModel>() : opts.model;
  let modelProb: number | undefined;
  let behaviorScore = heuristic.score;
  if (model) {
    modelProb = predictHuman(model, features);
    behaviorScore = 0.5 * heuristic.score + 0.5 * modelProb * 100;
    reasons.push(`behaviour model: ${(modelProb * 100).toFixed(0)}% human`);
  }

  let score = behaviorScore;
  let llmScore: number | undefined;
  let llmReasoning: string | undefined;
  let judgeModel: string | undefined;
  let quip: string | undefined;

  if (opts.useLlm ?? cfg.judge.llmEnabled) {
    try {
      const recent = opts.lessons ? [] : await readTraining(14);
      const lessons = opts.lessons ?? pickLessons(recent);
      const notes = await hunterNotes(new Set(recent.filter((e) => e.label === "human").map((e) => e.entryId)));
      const verdict = await llmJudge({
        questions,
        answers: entry.answers,
        features,
        ruleHits: heuristic.reasons,
        lessons,
        hunterNotes: notes,
        agentNotes: agentNotes(recent),
      });
      llmScore = verdict.score;
      llmReasoning = verdict.reasoning;
      judgeModel = verdict.model;
      quip = verdict.quip;
      reasons.push(...verdict.tells.map((t) => `judge: ${t}`));
      score = 0.5 * verdict.score + 0.5 * behaviorScore;
    } catch (err) {
      // A player must always get a score; the behaviour judge stands alone.
      console.error(`[judge] LLM judge failed for entry ${entry.id}; using behaviour score only:`, err);
      reasons.push(`LLM judge unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  score = Number(Math.max(0, Math.min(100, score)).toFixed(2));
  return {
    score,
    behaviorScore: Number(behaviorScore.toFixed(2)),
    heuristicScore: heuristic.score,
    modelProb: modelProb === undefined ? undefined : Number(modelProb.toFixed(4)),
    llmScore,
    verdict: score >= 50 ? "human" : "agent",
    quip: quip || fallbackQuip(score),
    reasons,
    llmReasoning,
    judgeModel,
    judgeVersion: JUDGE_VERSION,
    behaviorModelTrainedAt: model?.trainedAt,
    scoredAt: Date.now(),
  };
}
