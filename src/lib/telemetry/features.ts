import type {
  AnswerFeatures,
  AnswerTelemetry,
  ClientEnv,
  Features,
  PointerEv,
  QuestionKind,
} from "../types";

// ---------------------------------------------------------------------------
// Small statistics helpers
// ---------------------------------------------------------------------------

export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function std(xs: number[]): number | null {
  const m = mean(xs);
  if (m === null || xs.length < 2) return null;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Coefficient of variation: how irregular a series is relative to its size. */
export function cv(xs: number[]): number | null {
  const m = mean(xs);
  const s = std(xs);
  if (m === null || s === null || m === 0) return null;
  return s / Math.abs(m);
}

/** Shannon entropy of a histogram of `xs`, normalised to 0..1. */
function entropy(xs: number[], binSize: number, bins: number): number | null {
  if (xs.length < 8) return null;
  const counts = new Array<number>(bins).fill(0);
  for (const x of xs) counts[Math.min(bins - 1, Math.max(0, Math.floor(x / binSize)))]++;
  let h = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / xs.length;
    h -= p * Math.log2(p);
  }
  return h / Math.log2(Math.min(bins, xs.length));
}

const round = (x: number | null, places = 4): number | null =>
  x === null || !Number.isFinite(x) ? null : Number(x.toFixed(places));

// ---------------------------------------------------------------------------
// Per-answer features
// ---------------------------------------------------------------------------

/** A gap longer than this is the player stopping to think, not typing rhythm. */
const PAUSE_MS = 1200;
const MODIFIER = /^(Shift|Control|Alt|Meta|CapsLock|Fn|OS)/;

function isPaste(inputType: string): boolean {
  return inputType === "insertFromPaste" || inputType === "insertFromDrop" || inputType === "insertFromYank";
}

interface PathStats {
  straightness: number | null;
  speedCv: number | null;
  jitter: number | null;
}

/**
 * Describes a pointer path. People move in arcs with uneven speed and small
 * corrections; scripted pointers tend toward straight lines at constant speed.
 */
export function pathStats(points: PointerEv[], gapMs = 120): PathStats {
  const speeds: number[] = [];
  const turns: number[] = [];
  const straightness: number[] = [];

  let start = 0;
  const flush = (end: number) => {
    // One continuous movement: points[start..end]
    if (end - start >= 3) {
      let path = 0;
      let prevAngle: number | null = null;
      for (let i = start + 1; i <= end; i++) {
        const dx = points[i][1] - points[i - 1][1];
        const dy = points[i][2] - points[i - 1][2];
        const dt = points[i][0] - points[i - 1][0];
        const d = Math.hypot(dx, dy);
        path += d;
        if (dt > 0 && d > 0) speeds.push(d / dt);
        if (d > 1) {
          const angle = Math.atan2(dy, dx);
          if (prevAngle !== null) {
            let turn = angle - prevAngle;
            while (turn > Math.PI) turn -= 2 * Math.PI;
            while (turn < -Math.PI) turn += 2 * Math.PI;
            turns.push(turn);
          }
          prevAngle = angle;
        }
      }
      const disp = Math.hypot(points[end][1] - points[start][1], points[end][2] - points[start][2]);
      if (path > 30) straightness.push(disp / path);
    }
    start = end + 1;
  };

  for (let i = 1; i < points.length; i++) {
    if (points[i][0] - points[i - 1][0] > gapMs) flush(i - 1);
  }
  if (points.length) flush(points.length - 1);

  return {
    straightness: round(mean(straightness)),
    speedCv: round(speeds.length >= 5 ? cv(speeds) : null),
    jitter: round(turns.length >= 5 ? std(turns) : null),
  };
}

export function extractAnswerFeatures(kind: QuestionKind, text: string, raw: AnswerTelemetry): AnswerFeatures {
  const inputs = raw.inputs ?? [];
  const keys = raw.keys ?? [];
  const pointer = raw.pointer ?? [];
  const clicks = raw.clicks ?? [];

  // --- Text entry -----------------------------------------------------------
  let insertCount = 0;
  let deleteCount = 0;
  let typedChars = 0;
  let pastedChars = 0;
  const typingTimes: number[] = [];
  for (const [t, inputType, dataLen] of inputs) {
    if (isPaste(inputType)) {
      pastedChars += dataLen;
    } else if (inputType.startsWith("delete")) {
      deleteCount++;
      typingTimes.push(t);
    } else if (inputType.startsWith("insert")) {
      insertCount++;
      typedChars += Math.max(1, dataLen);
      typingTimes.push(t);
    }
  }

  const gaps: number[] = [];
  for (let i = 1; i < typingTimes.length; i++) gaps.push(typingTimes[i] - typingTimes[i - 1]);
  const iki = gaps.filter((g) => g >= 0 && g <= PAUSE_MS);
  const pauses = gaps.filter((g) => g > PAUSE_MS).length;

  // --- Physical keys (absent on most phone keyboards) -----------------------
  const down = new Map<string, number>();
  const dwell: number[] = [];
  let keyCount = 0;
  let rollovers = 0;
  let untrusted = 0;
  for (const [t, phase, code, trusted] of keys) {
    if (!trusted) untrusted++;
    if (MODIFIER.test(code)) continue;
    if (phase === 0) {
      if (down.has(code)) continue; // auto-repeat
      keyCount++;
      if (down.size > 0) rollovers++;
      down.set(code, t);
    } else {
      const t0 = down.get(code);
      if (t0 !== undefined) {
        dwell.push(t - t0);
        down.delete(code);
      }
    }
  }

  // --- Pointer --------------------------------------------------------------
  const path = pathStats(pointer);
  const clickDwell = clicks.map(([d, u]) => u - d).filter((d) => d >= 0 && d < 5000);

  // --- Drawing --------------------------------------------------------------
  const strokes = raw.strokes ?? [];
  const drawPoints = strokes.reduce((n, s) => n + s.length, 0);
  let drawMs: number | null = null;
  let drawStats: PathStats = { straightness: null, speedCv: null, jitter: null };
  if (drawPoints > 0) {
    const flat = strokes.flat();
    drawMs = flat[flat.length - 1][0] - flat[0][0];
    // Analyse each stroke as its own movement.
    const speeds: number[] = [];
    const jitters: number[] = [];
    for (const s of strokes) {
      const st = pathStats(s.map(([t, x, y]) => [t, x, y] as PointerEv), Infinity);
      if (st.speedCv !== null) speeds.push(st.speedCv);
      if (st.jitter !== null) jitters.push(st.jitter);
    }
    drawStats = { straightness: null, speedCv: round(mean(speeds)), jitter: round(mean(jitters)) };
  }

  const firstInput = typingTimes.length ? typingTimes[0] : inputs.length ? inputs[0][0] : null;
  const lastInput = inputs.length ? inputs[inputs.length - 1][0] : null;
  const eventCount = keys.length;

  return {
    kind,
    len: text.length,
    insertCount,
    deleteCount,
    typedChars,
    pastedChars,
    ikiMedian: round(median(iki), 1),
    ikiCv: round(iki.length >= 8 ? cv(iki) : null),
    ikiEntropy: round(entropy(iki, 25, 40)),
    pauses,
    keyCount,
    dwellMean: round(mean(dwell), 1),
    dwellCv: round(dwell.length >= 8 ? cv(dwell) : null),
    rolloverRatio: round(keyCount >= 8 ? rollovers / keyCount : null),
    untrustedRatio: round(eventCount ? untrusted / eventCount : 0) ?? 0,
    firstInputDelay: firstInput === null ? null : Math.max(0, Math.round(firstInput - raw.shownAt)),
    composeMs: firstInput === null || lastInput === null ? null : Math.round(lastInput - firstInput),
    clientMs: Math.max(0, Math.round(raw.submittedAt - raw.shownAt)),
    pointerSamples: pointer.length,
    pointerStraightness: path.straightness,
    pointerSpeedCv: path.speedCv,
    pointerJitter: path.jitter,
    clicks: clicks.length,
    clickDwellMean: round(mean(clickDwell), 1),
    touches: raw.touches ?? 0,
    focusLoss: (raw.focus ?? []).filter(([, on]) => on === 0).length,
    hiddenCount: (raw.hidden ?? []).filter(([, on]) => on === 1).length,
    drawStrokes: strokes.length,
    drawPoints,
    drawMs,
    drawSpeedCv: drawStats.speedCv,
    drawJitter: drawStats.jitter,
  };
}

// ---------------------------------------------------------------------------
// Entry-level features
// ---------------------------------------------------------------------------

const AI_PHRASES = [
  /\bas an ai\b/i,
  /\blanguage model\b/i,
  /\bi don'?t have (personal|a body|feelings|experiences)\b/i,
  /\bdelve\b/i,
  /\bcertainly[!,]/i,
  /\bit'?s (important|worth) (to note|noting)\b/i,
  /\btapestry\b/i,
  /\bin conclusion\b/i,
  /\bi'?d be happy to\b/i,
  /\bgreat question\b/i,
];

/** The fixed, ordered list of features the behaviour model is trained on. */
export const FEATURE_KEYS = [
  "ikiMedian",
  "ikiCv",
  "ikiEntropy",
  "pauseRate",
  "correctionRatio",
  "pasteRatio",
  "typedCoverage",
  "cps",
  "keyCoverage",
  "dwellMean",
  "dwellCv",
  "rolloverRatio",
  "untrustedRatio",
  "firstInputDelayMean",
  "firstInputDelayCv",
  "pointerRate",
  "pointerStraightness",
  "pointerSpeedCv",
  "pointerJitter",
  "clickDwellMean",
  "touchUse",
  "serverLatencyMean",
  "serverLatencyCv",
  "clockSkew",
  "focusLoss",
  "hiddenCount",
  "webdriver",
  "headlessUa",
  "drawPoints",
  "drawSpeedCv",
  "drawJitter",
  "drawMs",
  "ansLenMean",
  "ansLenCv",
  "formalRatio",
  "aiPhraseHits",
  "emDashes",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface AnswerForAggregation {
  text: string;
  serverLatencyMs: number;
  features: AnswerFeatures;
}

function present(xs: (number | null)[]): number[] {
  return xs.filter((x): x is number => x !== null && Number.isFinite(x));
}

export function aggregateFeatures(answers: AnswerForAggregation[], env?: ClientEnv, userAgent?: string): Features {
  const text = answers.filter((a) => a.features.kind === "text");
  const draw = answers.filter((a) => a.features.kind === "draw");
  const tf = text.map((a) => a.features);
  const all = answers.map((a) => a.features);

  const sum = (f: (x: AnswerFeatures) => number, from = tf) => from.reduce((n, x) => n + f(x), 0);
  const avg = (f: (x: AnswerFeatures) => number | null, from = tf) => mean(present(from.map(f)));

  const totalLen = sum((x) => x.len);
  const inserts = sum((x) => x.insertCount);
  const deletes = sum((x) => x.deleteCount);
  const composeSec = sum((x) => x.composeMs ?? 0) / 1000;
  const clientSec = sum((x) => x.clientMs, all) / 1000;
  const keyCount = sum((x) => x.keyCount);

  const firstDelays = present(tf.map((x) => x.firstInputDelay));
  const latencies = answers.map((a) => a.serverLatencyMs / 1000);
  const skews = answers
    .filter((a) => a.serverLatencyMs > 0)
    .map((a) => Math.abs(a.features.clientMs - a.serverLatencyMs) / a.serverLatencyMs);

  const texts = text.map((a) => a.text.trim());
  const joined = texts.join("\n");
  const lens = texts.map((t) => t.length);
  const formal = texts.filter((t) => /^[A-Z]/.test(t) && /[.!?]$/.test(t)).length;
  const ua = env?.ua ?? userAgent ?? "";

  const f: Record<FeatureKey, number | null> = {
    ikiMedian: avg((x) => x.ikiMedian),
    ikiCv: avg((x) => x.ikiCv),
    ikiEntropy: avg((x) => x.ikiEntropy),
    pauseRate: totalLen ? (sum((x) => x.pauses) / totalLen) * 100 : null,
    correctionRatio: inserts ? deletes / inserts : null,
    pasteRatio: totalLen ? Math.min(1, sum((x) => x.pastedChars) / totalLen) : null,
    typedCoverage: totalLen ? Math.min(2, sum((x) => x.typedChars) / totalLen) : null,
    cps: composeSec > 0 ? totalLen / composeSec : null,
    keyCoverage: inserts ? Math.min(2, keyCount / inserts) : null,
    dwellMean: avg((x) => x.dwellMean),
    dwellCv: avg((x) => x.dwellCv),
    rolloverRatio: avg((x) => x.rolloverRatio),
    untrustedRatio: avg((x) => x.untrustedRatio, all),
    firstInputDelayMean: mean(firstDelays),
    firstInputDelayCv: firstDelays.length >= 3 ? cv(firstDelays) : null,
    pointerRate: clientSec > 0 ? sum((x) => x.pointerSamples, all) / clientSec : null,
    pointerStraightness: avg((x) => x.pointerStraightness, all),
    pointerSpeedCv: avg((x) => x.pointerSpeedCv, all),
    pointerJitter: avg((x) => x.pointerJitter, all),
    clickDwellMean: avg((x) => x.clickDwellMean, all),
    touchUse: sum((x) => x.touches, all) > 0 || (env?.touchPoints ?? 0) > 0 ? 1 : 0,
    serverLatencyMean: mean(latencies),
    serverLatencyCv: latencies.length >= 3 ? cv(latencies) : null,
    clockSkew: mean(skews),
    focusLoss: sum((x) => x.focusLoss, all),
    hiddenCount: sum((x) => x.hiddenCount, all),
    webdriver: env ? (env.webdriver ? 1 : 0) : null,
    headlessUa: /headless|phantomjs|puppeteer|playwright|python-requests|node-fetch|undici|curl\/|^node$/i.test(ua) ? 1 : 0,
    drawPoints: draw.length ? sum((x) => x.drawPoints, draw.map((a) => a.features)) : null,
    drawSpeedCv: avg((x) => x.drawSpeedCv, draw.map((a) => a.features)),
    drawJitter: avg((x) => x.drawJitter, draw.map((a) => a.features)),
    drawMs: avg((x) => x.drawMs, draw.map((a) => a.features)),
    ansLenMean: mean(lens),
    ansLenCv: lens.length >= 3 ? cv(lens) : null,
    formalRatio: texts.length ? formal / texts.length : null,
    aiPhraseHits: AI_PHRASES.filter((re) => re.test(joined)).length,
    emDashes: (joined.match(/—/g) ?? []).length,
  };

  const out: Features = {};
  for (const k of FEATURE_KEYS) out[k] = round(f[k]);
  return out;
}
