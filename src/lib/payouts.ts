/**
 * When prizes go out. Paying is a job run away from the website (it needs the
 * treasury's key, which the website never holds), so the site can't know that
 * a run happened: it knows the hour one is scheduled for, if the owner has
 * said so with PAYOUT_HOUR_UTC, and tells players that.
 */

const HOUR_MS = 3_600_000;

/** The start of the next daily run after `now`, as a timestamp. `hourUtc` is 0 to 23. */
export function nextPayout(hourUtc: number, now: number): number {
  const day = new Date(now);
  const today = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hourUtc);
  return today > now ? today : today + 24 * HOUR_MS;
}

/** How long until then, in words a player can plan around. */
export function untilPayout(hourUtc: number, now: number): string {
  const hours = (nextPayout(hourUtc, now) - now) / HOUR_MS;
  if (hours < 1) return "in under an hour";
  const whole = Math.round(hours);
  return `in about ${whole} hour${whole === 1 ? "" : "s"}`;
}
