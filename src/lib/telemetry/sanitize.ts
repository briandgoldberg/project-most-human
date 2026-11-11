import type { AnswerTelemetry, ClientEnv, GamePlay } from "../types";

/**
 * Telemetry arrives from the player's machine and may be malformed or
 * hostile. This coerces it into the wire format, dropping anything that
 * doesn't fit and capping sizes, so the rest of the server can trust its shape.
 * (It cannot make the content truthful: a bot can send well-formed lies, and
 * catching those is the judge's job.)
 */

const LIMITS = { keys: 6000, inputs: 4000, pointer: 3000, clicks: 300, flags: 200, strokes: 80, strokePoints: 2500 };
const MAX_T = 24 * 60 * 60 * 1000;

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const time = (x: unknown): number | null => (isNum(x) && x >= 0 && x <= MAX_T ? Math.round(x) : null);
const coord = (x: unknown): number | null => (isNum(x) && Math.abs(x) <= 100_000 ? Math.round(x * 10) / 10 : null);
const str = (x: unknown, max: number): string => (typeof x === "string" ? x.slice(0, max) : "");
const bit = (x: unknown): 0 | 1 => (x === 1 || x === true ? 1 : 0);

function tuples<T>(value: unknown, limit: number, map: (row: unknown[]) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const row of value) {
    if (out.length >= limit) break;
    if (!Array.isArray(row)) continue;
    const mapped = map(row);
    if (mapped !== null) out.push(mapped);
  }
  return out;
}

function sanitizeEnv(value: unknown): ClientEnv | undefined {
  if (!value || typeof value !== "object") return undefined;
  const e = value as Record<string, unknown>;
  const pair = (x: unknown): [number, number] =>
    Array.isArray(x) && isNum(x[0]) && isNum(x[1]) ? [Math.round(x[0]), Math.round(x[1])] : [0, 0];
  return {
    ua: str(e.ua, 300),
    webdriver: e.webdriver === true,
    languages: Array.isArray(e.languages) ? e.languages.slice(0, 8).map((l) => str(l, 16)) : [],
    tz: str(e.tz, 64),
    screen: pair(e.screen),
    viewport: pair(e.viewport),
    dpr: isNum(e.dpr) ? e.dpr : 1,
    touchPoints: isNum(e.touchPoints) ? e.touchPoints : 0,
    cores: isNum(e.cores) ? e.cores : 0,
    plugins: isNum(e.plugins) ? e.plugins : 0,
  };
}

const GAME_LIMIT = 12;
const MAX_GAME_MS = 60_000;

function sanitizeGame(value: unknown): GamePlay | undefined {
  if (!value || typeof value !== "object") return undefined;
  const g = value as Record<string, unknown>;
  const list = (x: unknown, max: number, places: number): number[] | undefined =>
    Array.isArray(x) ? x.slice(0, GAME_LIMIT).filter((t): t is number => isNum(t) && t >= 0 && t <= max).map((t) => Math.round(t * places) / places) : undefined;
  const times = (x: unknown) => list(x, MAX_GAME_MS, 10);
  const count = (x: unknown) => (isNum(x) ? Math.max(0, Math.min(50, Math.round(x))) : 0);
  const play: GamePlay = {
    taps: times(g.taps),
    holds: times(g.holds),
    hits: times(g.hits),
    // How far from a dot's centre, in dot radii: anything past the edge wasn't a hit.
    offsets: list(g.offsets, 1.5, 1000),
    beatGaps: times(g.beatGaps),
    picks: list(g.picks, 3, 1),
    pickGaps: times(g.pickGaps),
  };
  if (!Object.values(play).some(Boolean)) return undefined;
  return { ...play, early: count(g.early), misses: play.hits ? count(g.misses) : undefined };
}

export function sanitizeTelemetry(value: unknown): AnswerTelemetry {
  const r = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const shownAt = time(r.shownAt) ?? 0;
  const submittedAt = Math.max(shownAt, time(r.submittedAt) ?? shownAt);

  const strokes = Array.isArray(r.strokes)
    ? r.strokes
        .slice(0, LIMITS.strokes)
        .map((s) =>
          tuples(s, LIMITS.strokePoints, ([t, x, y, p]) => {
            const tt = time(t);
            const xx = coord(x);
            const yy = coord(y);
            return tt === null || xx === null || yy === null
              ? null
              : ([tt, xx, yy, isNum(p) ? Math.max(0, Math.min(1, p)) : 0] as [number, number, number, number]);
          }),
        )
        .filter((s) => s.length > 0)
    : undefined;

  return {
    v: 1,
    shownAt,
    submittedAt,
    keys: tuples(r.keys, LIMITS.keys, ([t, phase, code, trusted]) => {
      const tt = time(t);
      return tt === null ? null : [tt, bit(phase), str(code, 24), bit(trusted)];
    }),
    inputs: tuples(r.inputs, LIMITS.inputs, ([t, type, dataLen, valueLen]) => {
      const tt = time(t);
      return tt === null
        ? null
        : [tt, str(type, 40), isNum(dataLen) ? Math.max(0, Math.min(10_000, Math.round(dataLen))) : 0, isNum(valueLen) ? Math.max(0, Math.round(valueLen)) : 0];
    }),
    pointer: tuples(r.pointer, LIMITS.pointer, ([t, x, y]) => {
      const tt = time(t);
      const xx = coord(x);
      const yy = coord(y);
      return tt === null || xx === null || yy === null ? null : [tt, xx, yy];
    }),
    clicks: tuples(r.clicks, LIMITS.clicks, ([d, u, x, y]) => {
      const dd = time(d);
      const uu = time(u);
      return dd === null || uu === null ? null : [dd, uu, coord(x) ?? 0, coord(y) ?? 0];
    }),
    focus: tuples(r.focus, LIMITS.flags, ([t, on]) => {
      const tt = time(t);
      return tt === null ? null : [tt, bit(on)];
    }),
    hidden: tuples(r.hidden, LIMITS.flags, ([t, on]) => {
      const tt = time(t);
      return tt === null ? null : [tt, bit(on)];
    }),
    scrolls: isNum(r.scrolls) ? Math.max(0, Math.min(100_000, Math.round(r.scrolls))) : 0,
    touches: isNum(r.touches) ? Math.max(0, Math.min(100_000, Math.round(r.touches))) : 0,
    strokes,
    game: sanitizeGame(r.game),
    env: sanitizeEnv(r.env),
  };
}
