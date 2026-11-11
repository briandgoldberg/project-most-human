import type { Features } from "../types";

export interface HeuristicResult {
  /** 0-100, higher = more human. */
  score: number;
  reasons: string[];
}

/**
 * Hand-written rules over the behaviour features. This is the judge's starting
 * point before any training data exists, and stays in the blend afterwards so
 * hard evidence (automation flags, text with no typing) can't be averaged away.
 */
export function heuristicScore(f: Features): HeuristicResult {
  let score = 50;
  const reasons: string[] = [];
  const rule = (hit: boolean, delta: number, reason: string) => {
    if (!hit) return;
    score += delta;
    reasons.push(`${delta > 0 ? "+" : ""}${delta} ${reason}`);
  };
  const has = (k: string): boolean => f[k] !== null && f[k] !== undefined;
  const v = (k: string): number => f[k] ?? 0;
  const touch = v("touchUse") === 1;
  const typedSomething = v("ansLenMean") > 0;

  // --- Environment ----------------------------------------------------------
  rule(v("webdriver") === 1, -30, "browser reports it is automated (navigator.webdriver)");
  rule(v("headlessUa") === 1, -25, "user agent is a script or headless browser");
  rule(!has("webdriver"), -12, "no browser environment reported at all");
  rule(v("untrustedRatio") > 0.2, -25, "key events were dispatched by script, not a keyboard");

  // --- How the text arrived -------------------------------------------------
  if (typedSomething) {
    const coverage = v("typedCoverage");
    const paste = v("pasteRatio");
    rule(coverage < 0.3 && paste < 0.3, -35, "answers appeared without being typed or pasted");
    rule(paste > 0.5, -30, "answers were mostly pasted");
    rule(paste > 0.1 && paste <= 0.5, -10, "some pasted text");
  }

  // --- Typing rhythm --------------------------------------------------------
  if (has("ikiCv")) {
    const c = v("ikiCv");
    rule(c < 0.15, -25, `keystroke timing is metronomic (cv ${c.toFixed(2)})`);
    rule(c >= 0.15 && c < 0.3, -10, `keystroke timing is unusually even (cv ${c.toFixed(2)})`);
    rule(c >= 0.4 && c <= 1.6, 10, "keystroke timing varies the way typing does");
  }
  if (has("ikiEntropy")) {
    rule(v("ikiEntropy") < 0.25, -8, "keystroke intervals cluster in one or two values");
  }
  rule(has("ikiMedian") && v("ikiMedian") < 35, -20, "typing faster than fingers move");
  rule(has("cps") && v("cps") > 14, -20, `sustained ${v("cps").toFixed(0)} characters per second`);
  if (has("correctionRatio") && typedSomething) {
    const c = v("correctionRatio");
    rule(c === 0 && v("ansLenMean") > 40, -6, "not a single correction");
    rule(c >= 0.02 && c <= 0.3, 8, "corrects mistakes while typing");
  }
  rule(has("pauseRate") && v("pauseRate") > 0.2, 5, "stops to think mid-answer");

  // --- Physical keyboard (desktop only) -------------------------------------
  if (!touch && has("keyCoverage")) {
    rule(v("keyCoverage") < 0.3 && v("typedCoverage") > 0.5, -10, "text input without matching key presses");
    rule(has("rolloverRatio") && v("rolloverRatio") > 0.05, 6, "keys overlap as fingers roll");
    rule(has("rolloverRatio") && v("rolloverRatio") === 0, -4, "keys never overlap");
    rule(has("dwellCv") && v("dwellCv") < 0.1, -10, "every key is held for the same time");
  }

  // --- Pointer --------------------------------------------------------------
  if (!touch) {
    rule(has("pointerRate") && v("pointerRate") === 0, -10, "pointer never moved");
    rule(has("pointerStraightness") && v("pointerStraightness") > 0.995, -12, "pointer moves in perfect straight lines");
    rule(has("pointerSpeedCv") && v("pointerSpeedCv") < 0.2, -10, "pointer moves at constant speed");
    rule(
      has("pointerJitter") && v("pointerJitter") > 0.05 && has("pointerStraightness") && v("pointerStraightness") <= 0.995,
      6,
      "pointer path wobbles like a hand",
    );
    rule(has("clickDwellMean") && v("clickDwellMean") < 5, -8, "clicks are instantaneous");
  }

  // --- Timing ---------------------------------------------------------------
  rule(has("firstInputDelayMean") && v("firstInputDelayMean") < 400, -15, "starts answering before a person could read the question");
  rule(has("firstInputDelayCv") && v("firstInputDelayCv") < 0.1, -6, "identical reading time on every question");
  rule(has("serverLatencyMean") && v("serverLatencyMean") < 3, -20, `answers arrive in ${v("serverLatencyMean").toFixed(1)}s on average`);
  rule(has("serverLatencyCv") && v("serverLatencyCv") < 0.1, -8, "every answer takes the same time");
  rule(has("clockSkew") && v("clockSkew") > 0.5, -12, "claimed timeline doesn't match when answers actually arrived");
  rule(v("hiddenCount") > 0, -3, "left the tab mid-question");
  rule(v("trapHits") > 0, -50, "followed an instruction that is hidden from people and only a machine reading the page would see");

  // --- Drawing --------------------------------------------------------------
  if (has("drawPoints")) {
    rule(v("drawPoints") < 8, -10, "drawing has almost no points");
    rule(has("drawSpeedCv") && v("drawSpeedCv") < 0.15, -10, "drawn at constant speed");
    rule(has("drawJitter") && v("drawJitter") < 0.01 && v("drawPoints") >= 8, -8, "drawn lines are geometrically perfect");
    rule(v("drawPoints") >= 20 && has("drawSpeedCv") && v("drawSpeedCv") >= 0.3, 5, "drawing speeds up and slows down like a hand");
  }

  // --- Mini-games -----------------------------------------------------------
  if (has("tapMedian")) {
    const m = v("tapMedian");
    rule(m < 120, -25, `reacts in ${m.toFixed(0)}ms, faster than nerves carry a signal to a finger`);
    rule(m > 1500, -5, "slow to react, as if waiting on something else to look at the screen");
    rule(has("tapCv") && v("tapCv") < 0.04, -15, "every reaction took the same time to within a few milliseconds");
    rule(m >= 160 && m <= 900 && has("tapCv") && v("tapCv") >= 0.06, 6, "reacts like a person: quick, and never the same twice");
    rule(v("tapEarly") > 0, 2, "jumped the gun at least once");
  }
  if (has("holdError")) {
    const e = v("holdError");
    rule(e < 0.01, -15, "held for the asked time to within 1%, with no clock to go by");
    rule(has("holdCv") && v("holdCv") < 0.005, -12, "every hold lasted exactly as long as the others");
    rule(e >= 0.02 && e <= 0.5 && (!has("holdCv") || v("holdCv") >= 0.01), 5, "misjudges time the way people do");
  }
  if (has("aimMedian")) {
    const m = v("aimMedian");
    const centred = has("aimOffset") && v("aimOffset") < 0.03;
    rule(m < 120, -25, `reaches each dot in ${m.toFixed(0)}ms, before a hand could get there`);
    rule(has("aimCv") && v("aimCv") < 0.04, -15, "took the same time to reach every dot, near or far");
    rule(centred, -15, "hit every dot dead centre");
    rule(m >= 200 && m <= 3000 && has("aimCv") && v("aimCv") >= 0.08 && !centred, 6, "aims like a hand: a little off centre, and never at one pace");
  }
  if (has("beatError")) {
    const e = v("beatError");
    rule(e < 0.01, -15, "tapped the beat back to within 1%");
    rule(has("beatCv") && v("beatCv") < 0.005, -12, "every gap between taps was exactly the same");
    rule(e >= 0.015 && e <= 0.5 && (!has("beatCv") || v("beatCv") >= 0.01), 5, "keeps a beat the way people do: close, and drifting");
  }
  if (has("recallMedian")) {
    const m = v("recallMedian");
    rule(m < 100, -20, `pressed the pads ${m.toFixed(0)}ms apart, faster than a hand moves between them`);
    rule(has("recallCv") && v("recallCv") < 0.04, -12, "pressed every pad at exactly the same pace");
    rule(m >= 180 && m <= 4000 && has("recallCv") && v("recallCv") >= 0.08, 5, "repeats a sequence at a person's uneven pace");
    rule(has("recallRight") && v("recallRight") < 1, 2, "got part of the sequence wrong");
  }

  // --- Text surface ---------------------------------------------------------
  rule(v("aiPhraseHits") > 0, -Math.min(20, 8 * v("aiPhraseHits")), "stock assistant phrasing");
  rule(v("emDashes") > 0, -4, "typed em dashes");
  rule(v("formalRatio") === 1 && v("ansLenMean") > 120, -6, "every answer is a polished paragraph");
  rule(has("ansLenCv") && v("ansLenCv") < 0.08 && v("ansLenMean") > 40, -5, "all answers are the same length");

  return { score: Math.max(1, Math.min(99, score)), reasons };
}
