import type { AnswerTelemetry, InputEv, KeyEv, PointerEv } from "../types";

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
