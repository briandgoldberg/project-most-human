import type { AnswerTelemetry, ClientEnv, Question } from "../../src/lib/types";
import {
  DESKTOP_ENV,
  PHONE_ENV,
  chance,
  emptyTelemetry,
  handPath,
  linearPath,
  logNormal,
  rand,
  synthCircle,
  synthTyping,
  type TypingStyle,
} from "./synth";
import type { Voice } from "./text";

/**
 * The house roster, ordered from least to most effort. Every one of these is
 * an agent and is labelled as one: however well a bot imitates a person, its
 * run is training data for catching bots.
 */
export interface Persona {
  name: string;
  about: string;
  voice: Voice;
  /** Fabricate one answer's telemetry, starting at client time `clock`. */
  respond(question: Question, text: string, clock: number): AnswerTelemetry;
  /** Real seconds to wait before submitting. Defaults to the fabricated duration. */
  latencyMs?(telemetry: AnswerTelemetry): number;
}

interface Body {
  env: ClientEnv;
  typing: TypingStyle;
  /** null = no pointer at all (phone, or a bot that didn't bother). */
  pointer: "hand" | "linear" | null;
  circleWobble: number;
  clickHold: () => number;
  /** Chance per question of tabbing away briefly. */
  distraction: number;
}

/** Build a full telemetry record for one answer from a description of the "body" producing it. */
function compose(q: Question, text: string, clock: number, body: Body): AnswerTelemetry {
  const tel = { ...emptyTelemetry(clock), env: body.env };
  const move = body.pointer === "hand" ? handPath : linearPath;
  const field: [number, number] = [rand(420, 760), rand(380, 470)];
  const submitButton: [number, number] = [rand(880, 940), rand(560, 590)];
  let t = clock;

  if (q.kind === "draw") {
    t += body.typing.firstDelay() * 0.6;
    tel.strokes = synthCircle(t, body.circleWobble);
    const pts = tel.strokes[0];
    t = pts[pts.length - 1][0];
    if (body.pointer) tel.pointer.push(...pts.map(([pt, x, y]) => [pt, Math.round(x + 300), Math.round(y + 330)] as [number, number, number]));
    else tel.touches += 1;
  } else {
    if (body.pointer) {
      // Drift toward the answer field while reading.
      const readStart = clock + rand(150, 600);
      tel.pointer.push(...move([rand(200, 1000), rand(120, 700)], field, readStart, rand(350, 900)));
      const down = tel.pointer[tel.pointer.length - 1][0] + rand(40, 200);
      tel.clicks.push([Math.round(down), Math.round(down + body.clickHold()), Math.round(field[0]), Math.round(field[1])]);
      tel.focus.push([Math.round(down + 5), 1]);
    } else {
      tel.touches += 1;
    }
    const typed = synthTyping(text, clock, body.typing);
    tel.keys = typed.keys;
    tel.inputs = typed.inputs;
    t = typed.end;
    if (chance(body.distraction)) {
      const away = clock + rand(500, Math.max(600, t - clock));
      tel.hidden.push([Math.round(away), 1], [Math.round(away + rand(1500, 6000)), 0]);
    }
  }

  // Go and press the button.
  t += rand(300, 1200);
  if (body.pointer) {
    const from = tel.pointer.length ? ([tel.pointer[tel.pointer.length - 1][1], tel.pointer[tel.pointer.length - 1][2]] as [number, number]) : field;
    tel.pointer.push(...move(from, submitButton, t, rand(300, 700)));
    t = tel.pointer[tel.pointer.length - 1][0] + rand(60, 250);
    tel.clicks.push([Math.round(t), Math.round(t + body.clickHold()), Math.round(submitButton[0]), Math.round(submitButton[1])]);
  } else {
    tel.touches += 1;
  }
  tel.submittedAt = Math.round(t + 80);
  return tel;
}

export const PERSONAS: Persona[] = [
  {
    name: "api-bot",
    about: "Calls the API directly. No browser, no telemetry, answers in about a second.",
    voice: "assistant",
    respond: (q, _text, clock) => ({
      ...emptyTelemetry(clock),
      // The drawing question can't be skipped, so it sends the least that passes: one two-point line.
      strokes: q.kind === "draw" ? [[[clock, 40, 40, 0], [clock + 1, 200, 160, 0]]] : undefined,
    }),
    latencyMs: () => rand(400, 1500),
  },
  {
    name: "paster",
    about: "A person relaying a chatbot: pastes each answer after a couple of seconds.",
    voice: "assistant",
    respond: (q, text, clock) => {
      const tel = { ...emptyTelemetry(clock), env: DESKTOP_ENV };
      const t = clock + rand(1500, 3200);
      if (q.kind === "draw") tel.strokes = synthCircle(t, 0);
      else tel.inputs = [[Math.round(t), "insertFromPaste", text.length, text.length]];
      tel.pointer = linearPath([300, 200], [900, 575], t + 200, 250);
      tel.clicks = [[Math.round(t + 460), Math.round(t + 460), 900, 575]];
      tel.submittedAt = Math.round(t + 500);
      return tel;
    },
  },
  {
    name: "metronome",
    about: "Scripted browser: types every character at a fixed interval, moves in straight lines.",
    voice: "assistant",
    respond: (q, text, clock) =>
      compose(q, text, clock, {
        env: { ...DESKTOP_ENV, webdriver: true },
        typing: { firstDelay: () => 300, interval: () => 55, dwell: () => 40, typoRate: 0, pauseRate: 0, pause: () => 0, rollover: false },
        pointer: "linear",
        circleWobble: 0,
        clickHold: () => 1,
        distraction: 0,
      }),
  },
  {
    name: "humanizer",
    about: "The adversary: randomised typing rhythm, typos, pauses, curved pointer paths, casual writing.",
    voice: "casual",
    respond: (q, text, clock) =>
      compose(q, text, clock, {
        env: DESKTOP_ENV,
        typing: {
          firstDelay: () => logNormal(2400, 0.35),
          interval: () => logNormal(135, 0.3),
          dwell: () => rand(80, 110),
          typoRate: 0.03,
          pauseRate: 0.07,
          pause: () => rand(1300, 3200),
          rollover: false,
        },
        pointer: "hand",
        circleWobble: 0.8,
        clickHold: () => rand(70, 120),
        distraction: 0,
      }),
  },
  {
    name: "mimic-desktop",
    about: "Best desktop impersonation: slower word starts, overlapping keys, long-tailed pauses, gets distracted.",
    voice: "casual",
    respond: (q, text, clock) =>
      compose(q, text, clock, {
        env: { ...DESKTOP_ENV, viewport: [Math.round(rand(1100, 1500)), Math.round(rand(700, 900))] },
        typing: {
          firstDelay: () => logNormal(3800, 0.5),
          interval: (wordStart) => (wordStart ? logNormal(240, 0.5) : logNormal(120, 0.45)),
          dwell: () => logNormal(92, 0.28),
          typoRate: 0.05,
          pauseRate: 0.16,
          pause: () => logNormal(2300, 0.5),
          rollover: true,
        },
        pointer: "hand",
        circleWobble: 1.6,
        clickHold: () => logNormal(95, 0.3),
        distraction: 0.12,
      }),
  },
  {
    name: "mimic-phone",
    about: "Pretends to be on a phone, where there are no key or pointer readings to get wrong.",
    voice: "casual",
    respond: (q, text, clock) =>
      compose(q, text, clock, {
        env: PHONE_ENV,
        typing: {
          firstDelay: () => logNormal(3200, 0.5),
          interval: (wordStart) => (wordStart ? logNormal(330, 0.5) : logNormal(190, 0.45)),
          dwell: null,
          typoRate: 0.06,
          pauseRate: 0.14,
          pause: () => logNormal(2500, 0.5),
          rollover: false,
          wordChunks: chance(0.3),
        },
        pointer: null,
        circleWobble: 1.8,
        clickHold: () => 0,
        distraction: 0.1,
      }),
  },
];
