import type { AnswerTelemetry, ClientEnv, InputEv, KeyEv, PointerEv, StrokePoint } from "../../src/lib/types";

/**
 * Telemetry forgery. Each house bot fabricates the same event stream a real
 * browser would send, at a different level of effort, so the judge can be
 * tested against everything from "didn't bother" to "trying hard".
 */

export const rand = (min: number, max: number) => min + Math.random() * (max - min);
export const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));
export const chance = (p: number) => Math.random() < p;
export const pickOne = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

function gaussian(): number {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

/** Log-normal sample with the given median: right-skewed like real reaction times. */
export const logNormal = (medianValue: number, sigma: number) => medianValue * Math.exp(sigma * gaussian());

export interface TypingStyle {
  /** Milliseconds from the question appearing to the first keystroke. */
  firstDelay: () => number;
  /** Milliseconds between keystrokes. `wordStart` is true for the first letter of a word. */
  interval: (wordStart: boolean) => number;
  /** How long each key is held. Null = send no physical key events (phone keyboard, or a lazy bot). */
  dwell: (() => number) | null;
  /** Chance per character of a typo that then gets fixed. */
  typoRate: number;
  /** Chance at each word boundary of stopping to think, and for how long. */
  pauseRate: number;
  pause: () => number;
  /** Let the next key go down before the previous one is released. */
  rollover: boolean;
  /** Phone-style: text arrives a word at a time. */
  wordChunks?: boolean;
}

function keyCode(ch: string): string {
  if (/[a-z]/i.test(ch)) return `Key${ch.toUpperCase()}`;
  if (/[0-9]/.test(ch)) return `Digit${ch}`;
  if (ch === " ") return "Space";
  return ({ ".": "Period", ",": "Comma", "'": "Quote", "?": "Slash", "!": "Digit1", "-": "Minus", ";": "Semicolon" } as Record<string, string>)[ch] ?? "Unidentified";
}

const NEIGHBOURS = "qwertyuiopasdfghjklzxcvbnm";

export interface Typed {
  keys: KeyEv[];
  inputs: InputEv[];
  /** Client time of the last event. */
  end: number;
}

/** Fabricate the key and input events for typing `text`, starting at `start`. */
export function synthTyping(text: string, start: number, style: TypingStyle): Typed {
  const keys: KeyEv[] = [];
  const inputs: InputEv[] = [];
  let t = start + style.firstDelay();
  let valueLen = 0;
  let lastUp = 0;

  const press = (code: string, inputType: string, dataLen: number) => {
    if (style.dwell) {
      // Without rollover, wait for the previous key to come up first.
      if (!style.rollover && t < lastUp) t = lastUp + 1;
      const up = t + Math.max(20, style.dwell());
      keys.push([Math.round(t), 0, code, 1]);
      keys.push([Math.round(up), 1, code, 1]);
      lastUp = up;
    }
    valueLen += inputType.startsWith("delete") ? -1 : dataLen;
    inputs.push([Math.round(t + 1), inputType, dataLen, valueLen]);
  };

  if (style.wordChunks) {
    for (const word of text.match(/\S+\s*/g) ?? []) {
      t += style.interval(true) * (1 + word.length * 0.6);
      if (chance(style.pauseRate)) t += style.pause();
      valueLen += word.length;
      inputs.push([Math.round(t), "insertText", word.length, valueLen]);
    }
    return { keys: [], inputs, end: t };
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const wordStart = i === 0 || text[i - 1] === " ";
    if (wordStart && i > 0 && chance(style.pauseRate)) t += style.pause();
    if (/[a-z]/i.test(ch) && chance(style.typoRate)) {
      const wrong = pickOne([...NEIGHBOURS]);
      press(keyCode(wrong), "insertText", 1);
      t += style.interval(false) + rand(120, 450); // notice the mistake
      press("Backspace", "deleteContentBackward", 0);
      t += style.interval(false);
    }
    press(keyCode(ch), "insertText", 1);
    t += style.interval(i + 1 < text.length && text[i] === " ");
  }
  keys.sort((a, b) => a[0] - b[0]);
  return { keys, inputs, end: Math.max(t, lastUp) };
}

/** A dead-straight pointer move at constant speed. */
export function linearPath(from: [number, number], to: [number, number], start: number, durationMs: number): PointerEv[] {
  const steps = Math.max(2, Math.round(durationMs / 16));
  const out: PointerEv[] = [];
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    out.push([Math.round(start + k * durationMs), Math.round(from[0] + (to[0] - from[0]) * k), Math.round(from[1] + (to[1] - from[1]) * k)]);
  }
  return out;
}

/** A curved pointer move that accelerates, decelerates and wobbles, like a hand on a mouse. */
export function handPath(from: [number, number], to: [number, number], start: number, durationMs: number): PointerEv[] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const bend = rand(-0.25, 0.25);
  const c1: [number, number] = [from[0] + dx * 0.3 - dy * bend, from[1] + dy * 0.3 + dx * bend];
  const c2: [number, number] = [from[0] + dx * 0.7 - dy * bend * 0.6, from[1] + dy * 0.7 + dx * bend * 0.6];
  const out: PointerEv[] = [];
  let t = start;
  const end = start + durationMs;
  while (t <= end) {
    const lin = (t - start) / durationMs;
    const k = lin * lin * (3 - 2 * lin); // ease in and out
    const a = (1 - k) ** 3;
    const b = 3 * (1 - k) ** 2 * k;
    const c = 3 * (1 - k) * k * k;
    const d = k ** 3;
    out.push([
      Math.round(t),
      Math.round(a * from[0] + b * c1[0] + c * c2[0] + d * to[0] + gaussian() * 1.2),
      Math.round(a * from[1] + b * c1[1] + c * c2[1] + d * to[1] + gaussian() * 1.2),
    ]);
    t += rand(14, 24);
  }
  return out;
}

/** A circle. `wobble` 0 = compass-perfect at constant speed; higher = hand-drawn. */
export function synthCircle(start: number, wobble: number): StrokePoint[][] {
  const cx = rand(150, 260);
  const cy = rand(110, 170);
  const r = rand(55, 90);
  const points: StrokePoint[] = [];
  const total = wobble ? rand(1.85, 2.2) * Math.PI : 2 * Math.PI;
  const a0 = wobble ? rand(0, 2 * Math.PI) : 0;
  let t = start;
  let angle = 0;
  let drift = 0;
  while (angle <= total) {
    drift += gaussian() * wobble * 1.5;
    const rr = r + drift + Math.sin(angle * 2) * wobble * 6;
    points.push([
      Math.round(t),
      Math.round((cx + rr * Math.cos(a0 + angle)) * 10) / 10,
      Math.round((cy + rr * Math.sin(a0 + angle)) * 10) / 10,
      wobble ? 0.5 : 0,
    ]);
    // A hand slows into the curve's start and end and varies in between.
    const speed = wobble ? 0.05 + 0.09 * Math.sin((angle / total) * Math.PI) + rand(0, 0.03) : 0.1;
    angle += speed;
    t += wobble ? rand(12, 22) : 16;
  }
  return [points];
}

export const DESKTOP_ENV: ClientEnv = {
  ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  webdriver: false,
  languages: ["en-US", "en"],
  tz: "America/Chicago",
  screen: [1512, 982],
  viewport: [1280, 800],
  dpr: 2,
  touchPoints: 0,
  cores: 8,
  plugins: 5,
};

export const PHONE_ENV: ClientEnv = {
  ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  webdriver: false,
  languages: ["en-US"],
  tz: "America/New_York",
  screen: [393, 852],
  viewport: [393, 660],
  dpr: 3,
  touchPoints: 5,
  cores: 6,
  plugins: 0,
};

export function emptyTelemetry(shownAt: number): AnswerTelemetry {
  return { v: 1, shownAt, submittedAt: shownAt, keys: [], inputs: [], pointer: [], clicks: [], focus: [], hidden: [], scrolls: 0, touches: 0 };
}
