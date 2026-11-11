import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.PMH_DATA_DIR = mkdtempSync(path.join(tmpdir(), "pmh-extras-"));
process.env.PAYMENT_MODE = "mock";
delete process.env.ANTHROPIC_API_KEY;

test("players are told when the daily payout is, from the hour it is scheduled for", async () => {
  const { nextPayout, untilPayout } = await import("../payouts");
  const at = (iso: string) => Date.parse(iso);
  // Before today's run: it is today. At or after it: tomorrow.
  assert.equal(nextPayout(17, at("2026-11-11T10:30:00Z")), at("2026-11-11T17:00:00Z"));
  assert.equal(nextPayout(17, at("2026-11-11T17:00:00Z")), at("2026-11-12T17:00:00Z"));
  assert.equal(nextPayout(17, at("2026-11-11T23:59:00Z")), at("2026-11-12T17:00:00Z"));
  // Across the end of a month and a year.
  assert.equal(nextPayout(0, at("2026-12-31T00:00:01Z")), at("2027-01-01T00:00:00Z"));
  assert.equal(untilPayout(17, at("2026-11-11T10:30:00Z")), "in about 7 hours");
  assert.equal(untilPayout(17, at("2026-11-11T15:40:00Z")), "in about 1 hour");
  assert.equal(untilPayout(17, at("2026-11-11T16:20:00Z")), "in under an hour");
  assert.equal(untilPayout(17, at("2026-11-11T17:00:00Z")), "in about 24 hours");

  // The site only says a time once the owner has said there is one.
  const { config } = await import("../config");
  const game = await import("../game");
  assert.equal(config().payoutHourUtc, undefined);
  assert.equal((await game.humanSummary()).payoutHourUtc, undefined);
  for (const [value, hour] of [["17", 17], ["0", 0], ["24", undefined], ["soon", undefined], ["9.5", undefined]] as const) {
    process.env.PAYOUT_HOUR_UTC = value;
    assert.equal(config().payoutHourUtc, hour, `PAYOUT_HOUR_UTC=${value}`);
  }
  process.env.PAYOUT_HOUR_UTC = "17";
  assert.equal((await game.humanSummary()).payoutHourUtc, 17);
  delete process.env.PAYOUT_HOUR_UTC;
});

test("signed-in players can leave feedback or a question, and the owner reads it", async () => {
  const { leaveFeedback, recentFeedback, MAX_FEEDBACK_CHARS } = await import("../feedback");
  const sam = { id: "p-sam-0123456789abcdef", name: "Sam" };

  // Only for people who are signed in.
  await assert.rejects(leaveFeedback(null, { text: "hello there" }), (e: { status?: number; code?: string }) => e.status === 401 && e.code === "sign_in_needed");
  await assert.rejects(leaveFeedback(sam, { text: "  " }), /a little more/);
  await assert.rejects(leaveFeedback(sam, { text: "x".repeat(MAX_FEEDBACK_CHARS + 1) }), /under 2000/);
  await assert.rejects(leaveFeedback(sam, { text: "how do I withdraw?", email: "not an address" }), /email address/);
  assert.deepEqual(await recentFeedback(), [], "nothing that was refused is kept");

  assert.deepEqual(await leaveFeedback(sam, { text: "  the hold game is hard on a phone  ", page: "/" }), { ok: true });
  await leaveFeedback(sam, { text: "when do payouts happen?", email: " sam@example.com ", page: "/agents" });
  const kept = await recentFeedback();
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((f) => f.text).sort(), ["the hold game is hard on a phone", "when do payouts happen?"]);
  const question = kept.find((f) => f.email)!;
  assert.deepEqual([question.player, question.email, question.page], [sam.id, "sam@example.com", "/agents"]);
  assert.equal(kept.find((f) => !f.email)!.email, undefined, "no address is kept unless one was given");

  // One account can't flood the box.
  for (let i = 0; i < 3; i++) await leaveFeedback(sam, { text: `message number ${i}` });
  await assert.rejects(leaveFeedback(sam, { text: "and another one" }), (e: { status?: number }) => e.status === 429);
  await leaveFeedback({ id: "p-someone-else", name: "Ana" }, { text: "someone else can still write" });

  // It reaches the owner's page.
  const { ownerSummary } = await import("../owner");
  const summary = await ownerSummary();
  assert.equal(summary.feedback.length, 6);
  assert.ok(summary.feedback.every((f, i, all) => i === 0 || all[i - 1].at >= f.at), "newest first");
});

test("which mini-games are in play can be narrowed, and a sitting still gets different ones", async () => {
  const { nextQuestion } = await import("../interview");
  const first = await nextQuestion("game", []);
  assert.notEqual(first.kind, "text");

  process.env.MINI_GAMES = "beat, recall";
  const one = await nextQuestion("game", []);
  const two = await nextQuestion("game", [{ question: one, answer: "" }]);
  assert.deepEqual([one.kind, two.kind].sort(), ["beat", "recall"]);
  // With every game in play used up, they come round again rather than the step failing.
  const three = await nextQuestion("game", [{ question: one, answer: "" }, { question: two, answer: "" }]);
  assert.ok(["beat", "recall"].includes(three.kind));
  // A name that isn't a game is ignored; if none are left, every game is in play.
  process.env.MINI_GAMES = "chess";
  assert.notEqual((await nextQuestion("game", [])).kind, "text");
  delete process.env.MINI_GAMES;
});
