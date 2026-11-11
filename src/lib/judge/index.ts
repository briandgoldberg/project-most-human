import { config } from "../config";
import { readModelFile, readTraining, type TrainingRecord } from "../store";
import type { EntryAnswer, Features, JudgeResult, Kind, Question } from "../types";
import { heuristicScore } from "./heuristic";
import { llmJudge } from "./llm";
import { predictHuman, type BehaviorModel } from "./model";

const MAX_LESSONS = 6;

/**
 * Bump this whenever the judging logic changes (rules, prompt, how scores are
 * blended), so verdicts in the data can be told apart by the judge that made them.
 */
export const JUDGE_VERSION = "2";

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
      const lessons = opts.lessons ?? pickLessons(await readTraining(3));
      const verdict = await llmJudge({
        questions,
        answers: entry.answers,
        features,
        ruleHits: heuristic.reasons,
        lessons,
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
