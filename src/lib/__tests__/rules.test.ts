import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Hunt, Question } from "../types";
import { humanlike } from "./fixtures";
import { ANSWERS, peek, play, playLikeAPerson, type Game } from "./helpers";

process.env.PMH_DATA_DIR = mkdtempSync(path.join(tmpdir(), "pmh-rules-"));
process.env.PAYMENT_MODE = "mock";
process.env.JUDGE_LLM = "off";

const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
type Session = Awaited<ReturnType<Game["enter"]>>;

/** Answer the question a session is on as a person would, taking as long as the recording says. */
async function answerAsPerson(game: Game, session: Session, question: Question, text: string, n = 0) {
  const { updateRound } = await import("../store");
  const telemetry = question.kind === "text" ? humanlike(text, n) : playLikeAPerson(question, n);
  await updateRound(session.roundId, (state) => {
    const e = state.entries[session.entryId];
    e.servedAt[e.answers.length] = Date.now() - (telemetry.submittedAt - telemetry.shownAt);
  });
  return game.answer({ token: session.token, questionId: question.id, text, telemetry });
}

test("the rules of play: what counts as an answer", async () => {
  const { checkAnswer, checkGame, describePlay } = await import("../rules");
  const open = { prompt: "What's within arm's reach of you that shouldn't be there?" };
  const short = { ...open, shortOk: true };

  assert.equal(checkAnswer(open, "a mug from tuesday, growing something"), null);
  // A word or two won't do, unless the question is the kind a word or two answers.
  assert.match(checkAnswer(open, "socks")!, /more than a word or two/);
  assert.match(checkAnswer(open, "my socks")!, /more than a word or two/);
  assert.equal(checkAnswer(short, "socks"), null);
  assert.equal(checkAnswer(open, "my dirty socks"), null);
  // Nothing, punctuation, one key held down, or a mashed keyboard.
  assert.match(checkAnswer(short, "   ")!, /Say something/);
  assert.match(checkAnswer(short, "?!...")!, /Use words/);
  assert.match(checkAnswer(short, "aaaaaaaa")!, /isn't an answer/);
  assert.match(checkAnswer(open, "asdfgh jklqwrt zxcvbnm sdfghjk")!, /keyboard mashing/);
  assert.equal(checkAnswer(open, "honestly idk, rhythm and blues cds mostly"), null, "odd words among real ones are fine");
  // Handing the question back, or saying the same thing twice.
  assert.match(checkAnswer(open, "within arm's reach of you")!, /don't repeat it/);
  assert.match(checkAnswer(open, "My left knee again!", ["my left knee, again"])!, /said that already/);
  assert.match(checkAnswer(open, "x".repeat(601))!, /under 600/);
  // Writing that doesn't use spaces or Latin letters isn't held to rules made for English.
  assert.equal(checkAnswer(open, "机の上にコーヒーカップがあります"), null);
  assert.equal(checkAnswer(open, "кружка и три ручки"), null);

  // Mini-games have to be played through.
  const tap = { kind: "tap" as const, game: { waits: [1500, 2000, 2500] } };
  const hold = { kind: "hold" as const, game: { holdMs: 3000, tries: 3 } };
  assert.match(checkGame(tap, { taps: [240, 260] })!, /Finish the game/);
  assert.equal(checkGame(tap, { taps: [240, 260, 251] }), null);
  assert.match(checkGame(hold, { holds: [2900, 3100] })!, /Finish the game/);
  assert.match(checkGame(hold, undefined)!, /Finish the game/);
  assert.equal(checkGame(hold, { holds: [2900, 3100, 3300] }), null);
  assert.equal(describePlay(tap, { taps: [240.4, 260, 251], early: 1 }), "Reaction game, 3 goes. Reacted in 240, 260, 251 ms. Tapped before the light 1 time.");
  assert.equal(describePlay(hold, { holds: [2900, 3100, 3300] }), "Timing game: hold a button for 3.0s with no clock. Held for 2.90s, 3.10s, 3.30s.");
});

test("an answer that breaks the rules is sent back, and a player who keeps at it is out", async () => {
  const game = await import("../game");
  const session = await game.enter({ handle: "one word", deviceId: "rule-breaker-cookie-1" });
  const q = session.question;
  const rejected = (text: string) =>
    assert.rejects(answerAsPerson(game, session, q, text), (err: Error & { status?: number; code?: string }) => err.status === 400 && err.code === "answer_rejected");

  await rejected("dunno");
  await rejected("asdfgh jklqwrt zxcvbnm");
  assert.deepEqual([(await peek(session)).rejections, (await peek(session)).answers.length], [2, 0], "nothing sent back is kept as an answer");
  // A proper answer after that is fine, and the game carries on to the follow-up.
  const next = await answerAsPerson(game, session, q, ANSWERS[0]);
  assert.ok(!next.done && next.question && next.question.id !== q.id);
  // A third non-answer ends it: that is a rule broken, and a strike against the account.
  const out = await answerAsPerson(game, session, next.question!, "zzzzzz");
  assert.ok(out.done);
  assert.deepEqual([out.result.cancelled, out.result.brokeRule, out.result.prize], [true, "kept giving answers that break the rules", undefined]);
  assert.deepEqual(out.result.strike, { count: 1, limit: 3, banned: false });
  assert.equal((await game.whoAmI(null, "rule-breaker-cookie-1")).strikes, 1);
});

test("mini-games are scored on how they were played, and can't be skipped or faked past the clock", async () => {
  const game = await import("../game");
  const { heuristicScore } = await import("../judge/heuristic");
  const { extractAnswerFeatures } = await import("../telemetry/features");
  const { gameQuestion } = await import("../questions");

  // Each kind sets itself up differently every time, on the server.
  const tap = { ...gameQuestion("tap"), id: "t" } as Question;
  const hold = { ...gameQuestion("hold"), id: "h" } as Question;
  assert.ok(tap.game!.waits!.length === 5 && tap.game!.waits!.every((w) => w >= 1200 && w <= 3600));
  assert.ok([2000, 3000, 4000].includes(hold.game!.holdMs!) && hold.game!.tries === 3);
  assert.match(hold.prompt, /exactly [234] seconds/);

  // A person's reactions and holds read as a person's; a script's give it away.
  const person = { ...extractAnswerFeatures("tap", "", playLikeAPerson(tap), tap.game), ...{} };
  assert.ok(person.tapMedian! > 200 && person.tapCv! > 0.06);
  const held = extractAnswerFeatures("hold", "", playLikeAPerson(hold), hold.game);
  assert.ok(held.holdError! > 0.03 && held.holdError! < 0.1);
  const rules = (f: Record<string, number | null>) => heuristicScore({ webdriver: 0, ...f }).reasons.join(" | ");
  assert.match(rules({ tapMedian: 252, tapCv: 0.12, tapEarly: 1 }), /reacts like a person.*jumped the gun/);
  assert.match(rules({ tapMedian: 9, tapCv: 0.01 }), /faster than nerves.*every reaction took the same time/);
  assert.match(rules({ holdError: 0.06, holdCv: 0.07 }), /misjudges time the way people do/);
  assert.match(rules({ holdError: 0.001, holdCv: 0.001 }), /to within 1%.*exactly as long as the others/);

  // In a game: a mini-game comes third. It can't be sent back unplayed.
  const session = await game.enter({ handle: "gamer", deviceId: "gamer-cookie-1" });
  const two = await answerAsPerson(game, session, session.question, ANSWERS[0]);
  const three = await answerAsPerson(game, session, two.done ? session.question : two.question!, ANSWERS[1], 1);
  assert.ok(!three.done && three.question && three.question.kind !== "text");
  const q = three.question!;
  await assert.rejects(game.answer({ token: session.token, questionId: q.id, text: "", telemetry: humanlike("") }), /Finish the game|Draw something/);
  assert.equal((await peek(session)).rejections, undefined, "not finishing a game is a slip, not a non-answer");
  const after = await answerAsPerson(game, session, q, "", 2);
  assert.ok(!after.done);
  const stored = (await peek(session)).answers[2];
  if (q.kind !== "draw") assert.match(stored.played!, /^(Reaction|Timing) game/);

  // On the human side, a game finished faster than it can be played, or reactions no nerve could manage, end it there.
  for (const cheat of ["clock", "nerves"] as const) {
    const s = await game.enter({ handle: `cheat ${cheat}`, deviceId: `cheat-cookie-${cheat}` });
    const a = await answerAsPerson(game, s, s.question, ANSWERS[0]);
    const b = await answerAsPerson(game, s, a.done ? s.question : a.question!, ANSWERS[1], 1);
    assert.ok(!b.done);
    const { updateRound } = await import("../store");
    // Make the game a reaction game whatever the draw was, so both cheats can be tried.
    const forced = { ...gameQuestion("tap"), id: b.question!.id } as Question;
    await updateRound(s.roundId, (state) => void (state.entries[s.entryId].questions![2] = forced));
    const telemetry = playLikeAPerson(forced);
    if (cheat === "nerves") telemetry.game = { taps: forced.game!.waits!.map(() => 12), early: 0 };
    // "clock": sent the moment the game was served, though its lights alone take several seconds.
    if (cheat === "nerves") await updateRound(s.roundId, (state) => void (state.entries[s.entryId].servedAt[2] = Date.now() - 60_000));
    const out = await game.answer({ token: s.token, questionId: forced.id, text: "", telemetry });
    assert.ok(out.done && out.result.cancelled);
    assert.equal(out.result.brokeRule, cheat === "clock" ? "finished a game faster than it can be played" : "reacted faster than a person can");
  }
});

test("three games ended for breaking the rules get an account banned, and the owner can lift it", async () => {
  const game = await import("../game");
  const owner = await import("../owner");
  const { updateRound } = await import("../store");
  const player = "b".repeat(24);
  // There is nothing to hunt with yet, which would otherwise keep a returning player waiting.
  process.env.HUNT_REPEATS = "on";
  const strikes = [];
  for (let i = 0; i < 3; i++) {
    const session = await game.enter({ handle: "paster", player });
    const telemetry = humanlike(ANSWERS[0]);
    telemetry.inputs = [[3000, "insertFromPaste", ANSWERS[0].length, ANSWERS[0].length]];
    await updateRound(session.roundId, (state) => void (state.entries[session.entryId].servedAt[0] = Date.now() - 20_000));
    const out = await game.answer({ token: session.token, questionId: session.question.id, text: ANSWERS[0], telemetry });
    assert.ok(out.done && out.result.brokeRule === "answer was pasted");
    strikes.push(out.result.strike);
  }
  assert.deepEqual(strikes, [{ count: 1, limit: 3, banned: false }, { count: 2, limit: 3, banned: false }, { count: 3, limit: 3, banned: true }]);
  const me = await game.whoAmI({ id: player, name: "P" }, undefined);
  assert.deepEqual([me.banned, me.strikes], [true, 3]);
  await assert.rejects(game.enter({ handle: "paster", player }), (err: Error & { status?: number; code?: string }) => err.status === 403 && err.code === "banned");

  // Being taken for a bot on the judge's opinion alone is not a broken rule.
  const { readPlayer, updatePlayer } = await import("../store");
  assert.equal((await readPlayer("c".repeat(24)))?.strikes, undefined);

  // The owner sees who is banned and why, and can lift it.
  const banned = (await owner.ownerSummary()).banned;
  assert.deepEqual(banned.map((b) => [b.id, b.handle, b.reason]), [[player, "paster", "answer was pasted"]]);
  await assert.rejects(owner.liftBan("../etc"), /Unknown account/);
  await owner.liftBan(player);
  assert.deepEqual((await owner.ownerSummary()).banned, []);
  assert.deepEqual([(await game.whoAmI({ id: player, name: "P" }, undefined)).banned, (await readPlayer(player))!.strikes], [false, []]);
  await game.enter({ handle: "paster", player });
  delete process.env.HUNT_REPEATS;
  void updatePlayer;
});

test("an agent is told why it scored what it did, and a settled case doesn't cost a call to the AI judge", async () => {
  const game = await import("../game");
  const agents = await import("../agents");
  const { judgeEntry, hardEvidence } = await import("../judge");
  const { buildJudgePrompt } = await import("../judge/llm");

  const { key } = await agents.issueAgentKey({ name: "Rationale Labs", wallet: WALLET });
  const builder = await agents.requireAgentKey(key);
  // A script with no browser: caught on hard evidence, and told so.
  const crude = await play(game, await game.enterAgent({ key: builder, handle: "crude" }), { how: "script" });
  const why = crude.result.why!;
  assert.equal(crude.result.impostor?.fooled, false);
  assert.ok(crude.result.score <= 40 && why.behaviour <= 40 && why.judge === undefined);
  assert.ok(why.reasons.some((r) => /^-\d+ /.test(r)), "the rules that counted against it are listed with what they cost");
  assert.ok(why.reasons.some((r) => r.includes("decided on hard evidence (no browser recording came with the answers)")));
  assert.equal(why.judgeVersion, "4");
  // One that plays like a person gets its reasons too.
  const slick = await play(game, await game.enterAgent({ key: builder, handle: "slick" }));
  assert.ok(slick.result.why!.reasons.some((r) => r.startsWith("+")));
  // The agents' page lists recent runs with their scores, and says which judge is scoring.
  const summary = await agents.agentSummary();
  assert.deepEqual(summary.board.map((r) => [r.handle, r.fooled]), [["slick", slick.result.impostor!.fooled], ["crude", false]]);
  assert.equal(summary.judge.version, "4");
  // Players on the human side aren't handed the judge's working.
  const human = await play(game, await game.enter({ handle: "a person" }));
  assert.equal(human.result.why, undefined);

  // What settles a run without the AI judge, and what doesn't.
  assert.equal(hardEvidence({ webdriver: 0, trapHits: 0, headlessUa: 0, untrustedRatio: 0 }), undefined);
  assert.match(hardEvidence({ webdriver: 1 })!, /automated/);
  assert.match(hardEvidence({ webdriver: 0, trapHits: 1 })!, /hidden from people/);
  assert.match(hardEvidence({})!, /no browser recording/);
  // Even asked to use the AI judge, a settled case doesn't: no call is made, so none can fail.
  const settled = await judgeEntry([], { id: "x", answers: [] }, { webdriver: 1 }, { useLlm: true, decided: "the browser reported it was automated", model: null });
  assert.ok(settled.score <= 40 && settled.llmScore === undefined && !settled.reasons.some((r) => r.includes("unavailable")));

  // What the AI judge is sent is kept lean: only readings that were measured, and what was played in a game.
  const prompt = buildJudgePrompt({
    questions: [{ id: "g", kind: "tap", category: "game", prompt: "Tap the circle." }],
    answers: [{ questionId: "g", text: "", serverLatencyMs: 9000, played: "Reaction game, 5 goes. Reacted in 240 ms." }],
    features: { ikiCv: 0.71234567, pasteRatio: null, tapMedian: 252.4 },
    ruleHits: [],
    lessons: [],
  });
  assert.match(prompt, /\(Reaction game, 5 goes\. Reacted in 240 ms\.\)/);
  assert.match(prompt, /<instrument_readings>\nikiCv=0\.712 tapMedian=252\n<\/instrument_readings>/);
});

test("the training area: answers typed by the owner seed the game", async () => {
  const owner = await import("../owner");
  const { humanPool, freshFor, nextHunt } = await import("../hunt");
  const { readTraining, appendUsage } = await import("../store");
  const trainer = "d".repeat(24);
  const before = (await humanPool()).length;

  const turn = await owner.nextSeedQuestion();
  assert.ok(turn.question.prompt.length > 10 && ["you", "wild"].includes(turn.question.style));
  assert.ok(["long", "normal", "short"].includes(turn.depth.id) && turn.depth.ask.length > 10);

  const give = (prompt: string, text: string, depth: string, telemetry: unknown = humanlike(text)) =>
    owner.saveSeedAnswer({ prompt, category: "seed", depth, text, telemetry, person: trainer });
  // It has to be typed there: the recording is what the game learns from.
  const pasted = humanlike("i copied this one in from somewhere else entirely");
  pasted.inputs = [[3000, "insertFromPaste", 49, 49]];
  await assert.rejects(give(turn.question.prompt, "i copied this one in from somewhere else entirely", "normal", pasted), /Type it out here rather than pasting/);
  // Lazy answers are welcome when lazy is what was asked for, and only then.
  await assert.rejects(give(turn.question.prompt, "the bins", "normal"), /more than a word or two/);

  const prompts = Array.from({ length: 9 }, (_, i) => `Seed question number ${i + 1}, about nothing in particular?`);
  const texts = prompts.map((_, i) => (i === 0 ? "the bins" : `honestly it was the ${["bins", "stairs", "kettle", "neighbours cat", "bus", "rain", "oven", "wifi", "landlord"][i]} again, every single week`));
  let saved;
  for (let i = 0; i < prompts.length; i++) saved = await give(prompts[i], texts[i], i === 0 ? "short" : "long");
  assert.ok(saved!.saved && saved!.judged > 50 && saved!.next.answered === 9);

  // They are on file as a real person's, with how they were typed, and are in the game at once.
  const seeds = (await readTraining()).filter((e) => e.source === "seed");
  assert.equal(seeds.length, 9);
  assert.deepEqual([seeds[1].label, seeds[1].player, seeds[1].answers[0].gaps!.length > 10, seeds[1].judge.llmScore], ["human", trainer, true, undefined]);
  const pool = await humanPool();
  assert.equal(pool.length, before + 8, "the two-word one is too short to show players");
  const mine = pool.filter((a) => a.player === trainer);
  assert.ok(mine.every((a) => a.evidence.gaps!.length > 10 && a.evidence.longestPauseMs! >= 1000 && a.others.length > 0), "each comes with its typing rhythm, and the trainer's other answers to imitate");
  // The trainer is never shown their own answers; anyone else is.
  assert.equal((await freshFor({ entryId: "", person: trainer, seen: [] })).filter((a) => a.player === trainer).length, 0);
  assert.equal((await freshFor({ entryId: "", person: "e".repeat(24), seen: [] })).filter((a) => a.player === trainer).length, 8);

  // In a hunt the machine's readings are forged to the same standard, rhythm included, and improve by level.
  const hunts: Hunt[] = [];
  for (let i = 0; i < 6; i++) hunts.push((await nextHunt({ id: "hunter", hunts: hunts.map((h) => ({ ...h, pick: h.humanIndex, correct: true })) }, { person: "e".repeat(24) }))!);
  for (const h of hunts) {
    const person = h.evidence![h.humanIndex];
    const forged = h.evidence![h.humanIndex === 0 ? 1 : 0];
    assert.ok(person.gaps!.length > 10 && person.pointerMoved === true);
    if (h.level === 1) assert.deepEqual([forged.gaps, forged.pasted, forged.pointerMoved], [undefined, 1, false]);
    else assert.ok(forged.gaps!.length > 0 && forged.keyHoldMs! > 0 && forged.totalMs! > forged.writingMs!);
    // Level two types too evenly; level three borrows the person's own unevenness.
    const spread = (g: number[]) => Math.max(...g) / Math.min(...g);
    if (h.level === 2) assert.ok(spread(forged.gaps!) < 1.4);
    if (h.level === 3) assert.ok(spread(forged.gaps!) > 3);
  }

  // The owner's page adds up what the game has spent on Claude.
  await appendUsage({ at: Date.now(), purpose: "judge", model: "claude-opus-5-5", input: 5000, output: 1000, cacheRead: 900, cacheWrite: 0 });
  await appendUsage({ at: Date.now(), purpose: "judge", model: "claude-opus-5-5", input: 4000, output: 1000, cacheRead: 0, cacheWrite: 900 });
  await appendUsage({ at: Date.now() - 3 * 86_400_000, purpose: "questions", model: "claude-opus-5-5", input: 700, output: 900, cacheRead: 0, cacheWrite: 0 });
  const summary = await owner.ownerSummary();
  assert.deepEqual(summary.usage.today, [{ purpose: "judge", calls: 2, input: 9900, output: 2000, cached: 900, dollars: summary.usage.today[0].dollars }]);
  assert.ok(Math.abs(summary.usage.today[0].dollars! - (9000 * 4 + 2000 * 20 + 900 * 4 * 0.05 + 900 * 4 * 1.25) / 1e6) < 1e-9);
  assert.deepEqual(summary.usage.week.map((u) => [u.purpose, u.calls]), [["judge", 2], ["questions", 1]]);
  assert.equal(summary.seeds, 9);
});
