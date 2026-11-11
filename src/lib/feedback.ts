import { GameError } from "./game";
import { appendFeedback, readFeedback, readPlayer, type FeedbackRecord } from "./store";

/**
 * Feedback and questions from signed-in players, for the owner to read on
 * /owner. A message is kept with the same one-way id the game knows the player
 * by, and with an email address only if they chose to give one for a reply.
 */

export const MAX_FEEDBACK_CHARS = 2000;
const MAX_PER_HOUR = 5;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/** A brake on one account flooding the box. In memory: good enough for what it guards. */
const recent = new Map<string, number[]>();

export async function leaveFeedback(player: { id: string; name: string } | null, input: { text: unknown; email?: unknown; page?: unknown }): Promise<{ ok: true }> {
  if (!player) throw new GameError(401, "sign_in_needed", "Sign in to send feedback");
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text.length < 3) throw new GameError(400, "too_short", "Say a little more than that");
  if (text.length > MAX_FEEDBACK_CHARS) throw new GameError(400, "too_long", `Keep it under ${MAX_FEEDBACK_CHARS} characters`);
  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (email && !EMAIL.test(email)) throw new GameError(400, "bad_email", "That email address doesn't look right. Leave it empty if you don't want a reply.");

  const now = Date.now();
  const mine = (recent.get(player.id) ?? []).filter((t) => now - t < 3_600_000);
  if (mine.length >= MAX_PER_HOUR) throw new GameError(429, "slow_down", "That's a lot of messages. Try again in a while.");
  recent.set(player.id, [...mine, now]);

  await appendFeedback({
    at: now,
    player: player.id,
    // What the board calls them, so the owner can tell who is writing without knowing who they are.
    handle: (await readPlayer(player.id))?.handle,
    page: typeof input.page === "string" ? input.page.slice(0, 80) : undefined,
    email: email || undefined,
    text,
  });
  return { ok: true };
}

/** For the owner: recent messages, newest first. */
export async function recentFeedback(days = 30, limit = 50): Promise<FeedbackRecord[]> {
  return (await readFeedback(days)).sort((a, b) => b.at - a.at).slice(0, limit);
}
