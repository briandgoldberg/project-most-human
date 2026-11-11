import type { Entry, Question, TrainingExample } from "../types";
import { drawing, humanlike } from "./fixtures";

/** Shared by the test files: playing whole games the way a person or a script would. */

export type Game = typeof import("../game");
export type Outcome = Awaited<ReturnType<Game["answer"]>>;
export const ANSWERS = [
  "my left knee, i sit on it like an idiot and then act surprised",
  "since college probably",
  "the neighbours dog. it has opinions about the bin lorry and shares them at 6am",
  "no",
];

/** The entry as the server holds it, including what the player is never shown. */
export async function peek(session: { roundId: string; entryId: string }): Promise<Entry> {
  const { readRound } = await import("../store");
  return (await readRound(session.roundId))!.entries[session.entryId];
}

/** Make the current hunting round look as if it was put in front of the player a while ago. */
export async function backdateHunt(session: { roundId: string; entryId: string }, huntId: string, ms = 15_000) {
  const { updateRound } = await import("../store");
  await updateRound(session.roundId, (state) => {
    state.entries[session.entryId].hunts!.find((h) => h.id === huntId)!.servedAt = Date.now() - ms;
  });
}

/**
 * Play a game to the end. `how` is how the answers are produced; `hunt` decides
 * each hunting round given the right answer (default: always right).
 */
export async function play(
  game: Game,
  session: { token: string; roundId: string; entryId: string; question: Question },
  opts: { how?: "person" | "script"; hunt?: (round: number, right: 0 | 1) => 0 | 1 } = {},
) {
  const { updateRound } = await import("../store");
  let step: Outcome = { done: false, question: session.question, index: 0, total: 0 };
  let n = 0;
  const seen: string[] = [];
  for (;;) {
    const now = step;
    if (now.done) return { result: now.result, seen };
    if (now.hunt) {
      const hunt = now.hunt;
      const right = (await peek(session)).hunts!.find((h) => h.id === hunt.id)!.humanIndex;
      seen.push(`hunt${hunt.round}`);
      const reason = `the other one is too tidy, round ${hunt.round}`;
      // Reading two answers and typing a reason takes a while; tests don't wait.
      if (opts.how !== "script") await backdateHunt(session, hunt.id);
      step = await game.pickHunt({
        token: session.token,
        huntId: hunt.id,
        pick: (opts.hunt ?? ((_, r) => r))(hunt.round, right),
        reason,
        telemetry: opts.how === "script" ? {} : humanlike(reason, hunt.round),
      });
      continue;
    }
    const q: Question = now.question!;
    seen.push(q.kind);
    const text = q.kind === "text" ? ANSWERS[n % ANSWERS.length] : "";
    if (opts.how === "script") {
      // No recording of a person producing anything; the drawing is the least that is accepted.
      step = await game.answer({ token: session.token, questionId: q.id, text, telemetry: q.kind === "draw" ? { strokes: [[[1, 1, 1, 0], [2, 9, 9, 0]]] } : {} });
    } else {
      const telemetry = q.kind === "draw" ? drawing() : humanlike(text, n);
      // A person takes as long as their recording says. Tests don't wait, so move the question's start back instead.
      await updateRound(session.roundId, (state) => {
        const e = state.entries[session.entryId];
        e.servedAt[e.answers.length] = Date.now() - (telemetry.submittedAt - telemetry.shownAt);
      });
      step = await game.answer({ token: session.token, questionId: q.id, text, telemetry });
    }
    n++;
  }
}

/** Play as a person, picking right and explaining, until a hunting round of at least `level` is in front of the player. */
export async function untilHunt(game: Game, session: { token: string; roundId: string; entryId: string; question: Question }, level = 1) {
  const { updateRound } = await import("../store");
  let step: Outcome = await game.sessionStatus(session.token);
  for (let n = 0; ; ) {
    if (step.done) throw new Error("the game ended before a hunting round came up");
    if (step.hunt) {
      const view = step.hunt;
      const hunt = (await peek(session)).hunts!.find((h) => h.id === view.id)!;
      if (hunt.level >= level) return hunt;
      await backdateHunt(session, hunt.id);
      step = await game.pickHunt({ token: session.token, huntId: hunt.id, pick: hunt.humanIndex, reason: "the other is too neat", telemetry: humanlike("the other is too neat") });
      continue;
    }
    const q: Question = step.question!;
    const telemetry = humanlike(ANSWERS[n], n);
    await updateRound(session.roundId, (state) => {
      const e = state.entries[session.entryId];
      e.servedAt[e.answers.length] = Date.now() - (telemetry.submittedAt - telemetry.shownAt);
    });
    step = await game.answer({ token: session.token, questionId: q.id, text: ANSWERS[n], telemetry });
    n++;
  }
}

/** Put some confirmed-human answers in the hunting pool, as earlier players would have. */
export async function seedPool(people = 3) {
  const { appendTraining } = await import("../store");
  const { clearHuntCache } = await import("../hunt");
  for (let p = 0; p < people; p++) {
    const questions: Question[] = [0, 1, 2, 3].map((i) => ({ id: `seed${p}-q${i}`, kind: "text", category: "seed", prompt: `Seed question ${p}.${i}?` }));
    await appendTraining({
      entryId: `seed-${p}`, roundId: "2026-01-01", recordedAt: 1, label: "human", cohortId: "players", source: "auto", consent: "v3",
      handle: `seed ${p}`, questions,
      answers: questions.map((q, i) => ({ questionId: q.id, text: `a real persons answer number ${p}.${i}, typed in a hurry`, serverLatencyMs: 9000 })),
      features: {}, judge: { score: 80, behaviorScore: 80, heuristicScore: 80, verdict: "human", quip: "", reasons: [], scoredAt: 1 },
      judgeCorrect: true, telemetry: {},
    } as unknown as TrainingExample);
  }
  clearHuntCache();
}

