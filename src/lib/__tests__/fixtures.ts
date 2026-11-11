import type { AnswerTelemetry, ClientEnv, InputEv, KeyEv, PointerEv } from "../types";

/** Telemetry for typing `text` with the given gaps (ms) between keystrokes, cycling through `gaps`. */
export function typed(text: string, gaps: number[], opts: { dwell?: number[]; shownAt?: number; firstDelay?: number } = {}): AnswerTelemetry {
  const shownAt = opts.shownAt ?? 1000;
  const keys: KeyEv[] = [];
  const inputs: InputEv[] = [];
  let t = shownAt + (opts.firstDelay ?? 2500);
  [...text].forEach((ch, i) => {
    const dwell = opts.dwell ? opts.dwell[i % opts.dwell.length] : 90;
    keys.push([t, 0, `Key${ch.toUpperCase()}`, 1], [t + dwell, 1, `Key${ch.toUpperCase()}`, 1]);
    inputs.push([t + 1, "insertText", 1, i + 1]);
    t += gaps[i % gaps.length];
  });
  keys.sort((a, b) => a[0] - b[0]);
  return { v: 1, shownAt, submittedAt: t + 500, keys, inputs, pointer: [], clicks: [], focus: [], hidden: [], scrolls: 0, touches: 0 };
}

export function straightLine(n = 40): PointerEv[] {
  return Array.from({ length: n }, (_, i) => [i * 16, 100 + i * 10, 100 + i * 5] as PointerEv);
}

export function wobblyArc(n = 60): PointerEv[] {
  let t = 0;
  return Array.from({ length: n }, (_, i) => {
    t += 12 + ((i * 7) % 11);
    const k = i / n;
    return [t, Math.round(100 + 600 * k + 9 * Math.sin(i * 1.3)), Math.round(100 + 300 * k * k + 7 * Math.cos(i * 0.9))] as PointerEv;
  });
}

export const DESKTOP: ClientEnv = { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0 Safari/537.36", webdriver: false, languages: ["en-US"], tz: "America/Chicago", screen: [1512, 982], viewport: [1280, 800], dpr: 2, touchPoints: 0, cores: 8, plugins: 5 };

/** A recording that reads as a person at a keyboard: uneven rhythm, overlapping keys, a wandering pointer. */
export function humanlike(text: string, n = 0): AnswerTelemetry {
  const raw = typed(text, [95, 180, 120, 310, 140, 90, 260, 150, 1900, 110, 170, 130].map((g) => g + n * 7), { dwell: [70, 110, 95, 130, 85, 140], firstDelay: 2200 + n * 900 });
  raw.pointer = wobblyArc(60 + n * 5);
  raw.clicks = [[500, 590 + n * 9, 400, 300]];
  raw.env = DESKTOP;
  return raw;
}

/** A hand-drawn-looking stroke for the drawing question. */
export function drawing(): AnswerTelemetry {
  const raw = humanlike("", 1);
  raw.keys = [];
  raw.inputs = [];
  let t = 3000;
  raw.strokes = [
    Array.from({ length: 40 }, (_, i) => {
      t += 10 + ((i * 13) % 37) + (i % 9 === 0 ? 180 : 0);
      return [t, 100 + 60 * Math.cos(i / 6) + (i % 3), 100 + 60 * Math.sin(i / 6) - (i % 4), 0.5] as [number, number, number, number];
    }),
  ];
  raw.submittedAt = t + 600;
  return raw;
}
