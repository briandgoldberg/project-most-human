/* eslint-disable @typescript-eslint/no-explicit-any -- Playwright is optional and loaded untyped. */
import { createRequire } from "node:module";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { BotResult } from "../run-bots";
import { chance, logNormal, pickOne, rand, randInt } from "./synth";

/**
 * The hardest house agent. Where the other bots fabricate telemetry, this one
 * drives a real browser the way a person would, so every reading the judge
 * gets was genuinely produced by the page's own collector:
 *
 *   - real key presses, held for uneven times, overlapping as fingers roll
 *   - slower word starts, pauses to think, typos noticed a beat late, false starts
 *   - a pointer that wanders while reading, overshoots, and clicks with a hold
 *   - drawings made of wobbly strokes at uneven speed
 *   - automation flags hidden, an ordinary user agent, phone variants with touch
 *   - a different persona per session, with answers written for that persona
 *
 * It enters on the agents' side with an agent key, so each run is recorded as
 * an agent as soon as the judge has scored it.
 *
 * Needs Playwright (npm i -D playwright && npx playwright install chromium)
 * and Anthropic credentials for the answers.
 */

interface Persona {
  name: string;
  device: "desktop" | "phone";
  /** Typing speed in words per minute. */
  wpm: number;
  typoRate: number;
  /** Who they are and how they write, for the answer writer. */
  sheet: string;
}

const PERSONAS: Persona[] = [
  { name: "maya", device: "desktop", wpm: 62, typoRate: 0.035, sheet: "Maya, 29, dental hygienist in a mid-size city. On her laptop on the couch after work, tired. Types in lowercase, rarely uses apostrophes, says 'lol' sparingly. Has a cat that knocks things over. Blunt, a bit dry." },
  { name: "dave", device: "desktop", wpm: 38, typoRate: 0.05, sheet: "Dave, 54, runs a small HVAC business. Two-finger-ish typist at a desktop in his home office. Uses proper capitals and periods but short sentences. Mildly grumpy, practical, doesn't see the point of some questions and says so." },
  { name: "priya", device: "phone", wpm: 40, typoRate: 0.05, sheet: "Priya, 22, college senior, on her phone between classes. Fast thumbs, lowercase, drops words, 'ngl', 'idk', occasional 'omg'. Distracted, answers are short. Lives with three roommates and it shows." },
  { name: "tom", device: "desktop", wpm: 75, typoRate: 0.025, sheet: "Tom, 36, software tester, mechanical keyboard, types fast and sloppy. Mixed case, forgets to capitalise 'i' half the time. Over-explains one answer and gives almost nothing on the next. Has a bad knee and a newborn, sleep-deprived." },
  { name: "linda", device: "phone", wpm: 26, typoRate: 0.04, sheet: "Linda, 61, retired school secretary, on her phone in the kitchen. Careful, full sentences, capital letters, sometimes a stray double space or a missed letter she doesn't fix. Warm, a little chatty, mentions her husband Ron and the garden." },
  { name: "jake", device: "desktop", wpm: 50, typoRate: 0.04, sheet: "Jake, 19, works nights stocking shelves, on an old laptop in his room. Lowercase, no punctuation at the end, 'bro', 'tbh'. Low effort, some answers are five words. Hungry, room is a mess, playing a game in another window." },
  { name: "ana", device: "desktop", wpm: 57, typoRate: 0.03, sheet: "Ana, 41, nurse on a day off, English is her second language (Portuguese first). Writes clearly with the occasional odd preposition or missing article. Direct, a bit funny without trying. Drinking coffee that went cold." },
  { name: "sam", device: "phone", wpm: 34, typoRate: 0.06, sheet: "Sam, 33, line cook on a smoke break, on a cracked phone. Terse, lowercase, swears mildly ('damn', 'hell'), typos everywhere and doesn't care. Feet hurt. Smells like fryer oil." },
];

const TODAY = [
  "it's raining a little", "it's weirdly warm for the season", "the heating is broken", "they slept badly",
  "they just ate leftovers", "they skipped lunch", "a neighbour is doing loud construction", "their phone is at 9% battery",
  "they have a headache starting", "they're procrastinating on laundry", "they're waiting for a delivery", "the wifi keeps dropping",
];

const FALSE_STARTS = ["ok so ", "hmm ", "honestly i ", "well ", "i mean ", "uh ", "so the thing is ", "not sure but "];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * The physical habits of one session's "player". Drawn fresh every time: the
 * judge caught earlier versions by noticing that every session held keys for
 * the same 97 ms and drew at the same pace.
 */
interface Body {
  /** Typical key hold, ms, and how much it varies. */
  dwell: number;
  dwellSpread: number;
  /** Gap between letters inside a word, and before the first letter of one, relative to the persona's pace. */
  burst: number;
  startLag: number;
  /** Chance of stopping to think at a word boundary. */
  thinkRate: number;
  falseStartRate: number;
  /** Submits with Ctrl+Enter instead of reaching for the button. */
  submitsWithKeys: boolean;
  /** Overall drawing pace multiplier. */
  drawPace: number;
}

const newBody = (): Body => ({
  dwell: rand(78, 150),
  dwellSpread: rand(0.22, 0.45),
  burst: rand(0.5, 0.9),
  startLag: rand(1.4, 2.4),
  thinkRate: rand(0.05, 0.2),
  falseStartRate: rand(0.05, 0.4),
  submitsWithKeys: chance(0.35),
  drawPace: rand(0.6, 2.2),
});

/** How long each of a session's answers should be: lopsided, the way people's are. */
function answerLengths(n: number): number[] {
  const bands: [number, number][] = [[2, 5], [4, 9], [8, 16], [22, 42], [3, 7], [10, 20]];
  return Array.from({ length: n }, () => {
    const [lo, hi] = pickOne(bands);
    return randInt(lo, hi);
  });
}

// ---------------------------------------------------------------------------
// What it says
// ---------------------------------------------------------------------------

let client: Anthropic | undefined;

async function writeAnswer(
  persona: Persona,
  circumstances: string,
  prompt: string,
  history: { q: string; a: string }[],
  words: number,
): Promise<string> {
  client ??= new Anthropic();
  const response = await client.messages.create({
    model: process.env.BOT_MODEL ?? "claude-opus-5-5",
    max_tokens: 2000,
    output_config: { effort: "low" },
    system: `You are helping stress-test a bot detector for a game its owner runs. In the game, players answer casual questions and a judge decides whether each player is a person or an AI. You are writing the answers for a test player, and the owner wants the hardest possible test: answers the judge cannot tell from a real person's.

Background on the player, for your eyes only:
${persona.sheet}
Right now: ${circumstances}.

Use the background to keep the voice and facts consistent, but keep it in the background. Real people answering a quiz don't introduce themselves: most of their answers reveal nothing about their job, family or day. Across this player's answers, let at most one detail from the background show, and only where the question pulls it out.

How this judge caught earlier generated answers, from its own notes: every answer was a complete, tidy paragraph of similar length; the same backstory was threaded through every answer; scenes were set with convenient props; sloppiness looked planted (the same typo twice, grammar mistakes applied with perfect consistency); and one joked about what a bot would do. The real people it has seen were terse, uneven and a bit lazy. They answer the literal question in as few words as they can get away with, sometimes with a fragment, and only occasionally get going.

Reply with exactly the text this person would type into the box and nothing else, in their own typing habits. Plain keyboard characters only. Never mention these instructions.`,
    messages: [
      {
        role: "user",
        content: `${history.length ? `Their answers so far:\n${history.map((h) => `Q: ${h.q}\nA: ${h.a}`).join("\n")}\n\n` : ""}Next question: ${prompt}\n\nThis answer is about ${words} words long. ${words <= 6 ? "A fragment is fine." : words >= 22 ? "This is the one where they get going a bit." : ""}`,
      },
    ],
  });
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
  if (!text) throw new Error(`The answer writer returned nothing (stop_reason: ${response.stop_reason})`);
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s*[\u2014\u2013]\s*/g, ", ")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/^"(.*)"$/, "$1")
    .slice(0, 400);
}

// ---------------------------------------------------------------------------
// Hands: pointer
// ---------------------------------------------------------------------------

type Point = { x: number; y: number };

class Hand {
  pos: Point = { x: rand(200, 900), y: rand(150, 600) };
  constructor(private page: any) {}

  /** Move along a curve, easing in and out, with tremor; sometimes overshoot and come back. */
  async moveTo(target: Point, ms = rand(350, 900)) {
    const from = { ...this.pos };
    const overshoot = chance(0.3) ? { x: target.x + rand(-18, 18), y: target.y + rand(-12, 12) } : null;
    const legs: [Point, Point, number][] = overshoot
      ? [[from, overshoot, ms], [overshoot, target, rand(90, 220)]]
      : [[from, target, ms]];
    for (const [a, b, duration] of legs) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const bend = rand(-0.22, 0.22);
      const c1 = { x: a.x + dx * 0.3 - dy * bend, y: a.y + dy * 0.3 + dx * bend };
      const c2 = { x: a.x + dx * 0.72 - dy * bend * 0.5, y: a.y + dy * 0.72 + dx * bend * 0.5 };
      const start = Date.now();
      for (;;) {
        const lin = Math.min(1, (Date.now() - start) / duration);
        const k = lin * lin * (3 - 2 * lin);
        const u = 1 - k;
        const x = u ** 3 * a.x + 3 * u * u * k * c1.x + 3 * u * k * k * c2.x + k ** 3 * b.x + rand(-1.2, 1.2);
        const y = u ** 3 * a.y + 3 * u * u * k * c1.y + 3 * u * k * k * c2.y + k ** 3 * b.y + rand(-1.2, 1.2);
        await this.page.mouse.move(x, y);
        this.pos = { x, y };
        if (lin >= 1) break;
        await sleep(rand(9, 22));
      }
    }
  }

  async click(target: Point) {
    await this.moveTo(target);
    await sleep(rand(60, 260));
    await this.page.mouse.down();
    await sleep(logNormal(95, 0.3));
    await this.page.mouse.up();
  }

  /** Small aimless movement, the kind a hand makes while its owner reads. */
  async fidget() {
    await this.moveTo({ x: this.pos.x + rand(-140, 140), y: this.pos.y + rand(-90, 90) }, rand(250, 700));
    if (chance(0.25)) {
      await this.page.mouse.wheel(0, rand(30, 120));
      await sleep(rand(300, 900));
      await this.page.mouse.wheel(0, -rand(30, 120));
    }
  }
}

async function centre(locator: any, spread = 0.25): Promise<Point> {
  const box = await locator.boundingBox();
  return { x: box.x + box.width * (0.5 + rand(-spread, spread)), y: box.y + box.height * (0.5 + rand(-spread, spread)) };
}

// ---------------------------------------------------------------------------
// Hands: keyboard
// ---------------------------------------------------------------------------

const SHIFTED: Record<string, string> = { "?": "/", "!": "1", ":": ";", '"': "'", "(": "9", ")": "0", "&": "7", "$": "4", "%": "5", "+": "=", "_": "-" };
const PLAIN = /^[a-z0-9 .,'\/;\-=]$/;
const NEAR: Record<string, string> = { a: "sq", b: "vn", c: "xv", d: "sf", e: "wr", f: "dg", g: "fh", h: "gj", i: "uo", j: "hk", k: "jl", l: "k", m: "n", n: "bm", o: "ip", p: "o", q: "w", r: "et", s: "ad", t: "ry", u: "yi", v: "cb", w: "qe", x: "zc", y: "tu", z: "x" };

class Typist {
  private releases: Promise<void>[] = [];
  private held = new Map<string, Promise<void>>();
  private base: number;

  constructor(private page: any, private persona: Persona, private body: Body) {
    this.base = 60_000 / (persona.wpm * 5);
  }

  /** Press a key and let it come up on its own time, so the next press can land before it does. */
  private async strike(key: string) {
    await this.held.get(key); // the same finger can't press a key it is still holding
    await this.page.keyboard.down(key);
    const release = sleep(logNormal(this.body.dwell, this.body.dwellSpread)).then(() => this.page.keyboard.up(key));
    this.held.set(key, release);
    this.releases.push(release);
  }

  private async char(ch: string) {
    if (PLAIN.test(ch)) return this.strike(ch);
    const lower = ch.toLowerCase();
    const base = SHIFTED[ch] ?? (ch !== lower && PLAIN.test(lower) ? lower : null);
    if (base) {
      await this.page.keyboard.down("Shift");
      await sleep(rand(40, 110));
      await this.strike(base);
      await sleep(rand(30, 90));
      await this.page.keyboard.up("Shift");
      return;
    }
    await this.page.keyboard.insertText(ch); // anything off the US layout
  }

  private gap(wordStart: boolean, after: string): number {
    let ms = wordStart ? logNormal(this.base * this.body.startLag, 0.55) : logNormal(this.base * this.body.burst, 0.45);
    if (/[.,?!]/.test(after)) ms += logNormal(380, 0.6);
    return ms;
  }

  private async backspace(times: number) {
    for (let i = 0; i < times; i++) {
      await this.strike("Backspace");
      await sleep(logNormal(120, 0.3));
    }
  }

  async type(text: string) {
    // Sometimes start down the wrong road and take it back.
    if (chance(this.body.falseStartRate)) {
      const start = pickOne(FALSE_STARTS);
      if (!text.toLowerCase().startsWith(start.trim())) {
        for (const ch of start) {
          await this.char(ch);
          await sleep(this.gap(ch === " ", ch));
        }
        await sleep(logNormal(900, 0.5));
        await this.backspace(start.length);
        await sleep(logNormal(600, 0.5));
      }
    }

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const wordStart = i === 0 || text[i - 1] === " ";
      if (wordStart && i > 0 && chance(this.body.thinkRate)) await sleep(logNormal(1900, 0.7)); // thinking

      if (NEAR[ch] && chance(this.persona.typoRate)) {
        await this.char(pickOne([...NEAR[ch]]));
        await sleep(this.gap(false, ch));
        // Notice straight away, or a letter or two later.
        const late = Math.min(randInt(0, 2), text.length - i - 1);
        for (let k = 0; k < late; k++) {
          await this.char(text[i + 1 + k]);
          await sleep(this.gap(false, text[i + 1 + k]));
        }
        await sleep(logNormal(340, 0.45));
        await this.backspace(late + 1);
      }
      await this.char(ch);
      await sleep(this.gap(text[i + 1] !== undefined && ch === " ", ch));
    }
    await Promise.all(this.releases);
    this.releases = [];
  }
}

/** Thumbs on glass: no physical keys, characters or whole words arriving through the input method. */
async function thumbType(page: any, persona: Persona, text: string) {
  const base = 60_000 / (persona.wpm * 5);
  const words = text.match(/\S+\s*/g) ?? [];
  for (const [w, word] of words.entries()) {
    if (w > 0 && chance(0.12)) await sleep(logNormal(2000, 0.6));
    if (word.trim().length > 3 && chance(0.22)) {
      // Swipe or autocomplete: the word lands in one go.
      await sleep(logNormal(base * word.length * 0.7, 0.4));
      await page.keyboard.insertText(word);
      continue;
    }
    for (const ch of word) {
      if (NEAR[ch] && chance(persona.typoRate)) {
        await page.keyboard.insertText(pickOne([...NEAR[ch]]));
        await sleep(logNormal(base * 1.6, 0.4));
        await page.keyboard.press("Backspace", { delay: logNormal(85, 0.3) });
        await sleep(logNormal(base, 0.4));
      }
      await page.keyboard.insertText(ch);
      await sleep(ch === " " ? logNormal(base * 1.7, 0.5) : logNormal(base, 0.45));
    }
  }
}

// ---------------------------------------------------------------------------
// Hands: drawing
// ---------------------------------------------------------------------------

/** Strokes for what the question asks for, as fractions of the canvas, roughly as a person would rough it out. */
function sketch(prompt: string): Point[][] {
  const p = prompt.toLowerCase();
  const arc = (cx: number, cy: number, r: number, from: number, to: number, n = 40): Point[] =>
    Array.from({ length: n + 1 }, (_, i) => {
      const a = from + ((to - from) * i) / n;
      return { x: cx + r * Math.cos(a), y: cy + r * 0.62 * Math.sin(a) * 1.6 };
    });
  const line = (a: Point, b: Point, n = 14): Point[] =>
    Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
  const poly = (...pts: Point[]): Point[] => pts.slice(1).flatMap((pt, i) => line(pts[i], pt).slice(i ? 1 : 0));
  const start = rand(0, Math.PI * 2);

  if (p.includes("house")) {
    return [
      poly({ x: 0.38, y: 0.75 }, { x: 0.38, y: 0.45 }, { x: 0.62, y: 0.45 }, { x: 0.62, y: 0.76 }, { x: 0.37, y: 0.75 }),
      poly({ x: 0.35, y: 0.46 }, { x: 0.5, y: 0.22 }, { x: 0.65, y: 0.45 }),
      poly({ x: 0.47, y: 0.75 }, { x: 0.47, y: 0.6 }, { x: 0.53, y: 0.6 }, { x: 0.53, y: 0.75 }),
    ];
  }
  if (p.includes("star")) {
    const tip = (i: number): Point => ({ x: 0.5 + 0.17 * Math.cos(-Math.PI / 2 + (i * 4 * Math.PI) / 5), y: 0.5 + 0.3 * Math.sin(-Math.PI / 2 + (i * 4 * Math.PI) / 5) });
    return [poly(tip(0), tip(1), tip(2), tip(3), tip(4), tip(0))];
  }
  if (p.includes("spiral")) {
    return [Array.from({ length: 110 }, (_, i) => ({ x: 0.5 + (0.004 + i * 0.0016) * Math.cos(i * 0.21 + start), y: 0.5 + (0.007 + i * 0.0028) * Math.sin(i * 0.21 + start) }))];
  }
  if (p.includes("cat")) {
    return [
      arc(0.5, 0.55, 0.11, start, start + Math.PI * 2.05),
      poly({ x: 0.42, y: 0.42 }, { x: 0.43, y: 0.25 }, { x: 0.48, y: 0.38 }),
      poly({ x: 0.52, y: 0.38 }, { x: 0.57, y: 0.25 }, { x: 0.58, y: 0.42 }),
      line({ x: 0.46, y: 0.52 }, { x: 0.465, y: 0.53 }, 3),
      line({ x: 0.54, y: 0.52 }, { x: 0.545, y: 0.53 }, 3),
      line({ x: 0.52, y: 0.6 }, { x: 0.66, y: 0.57 }),
      line({ x: 0.48, y: 0.6 }, { x: 0.34, y: 0.58 }),
    ];
  }
  if (p.includes("sign") || p.includes("name")) {
    return [
      Array.from({ length: 90 }, (_, i) => ({ x: 0.25 + i * 0.0055, y: 0.5 + 0.13 * Math.sin(i * 0.33 + start) * Math.exp(-i / 120) + 0.04 * Math.sin(i * 0.09) })),
      line({ x: 0.3, y: 0.68 }, { x: 0.7, y: 0.65 }, 20),
    ];
  }
  return [arc(0.5, 0.5, rand(0.1, 0.14), start, start + Math.PI * rand(1.9, 2.15), 48)];
}

/**
 * Give ideal strokes a hand. Real drawings lurch: quick flicks, slow careful
 * bits, dead stops mid-line. Each session also gets its own size, lean, level
 * of detail and pace, so no two drawings share a signature.
 */
function byHand(strokes: Point[][], box: { x: number; y: number; width: number; height: number }, pace: number) {
  const scale = rand(0.7, 1.3);
  const lean = rand(-0.18, 0.18);
  const shiftX = rand(-0.12, 0.12);
  const shiftY = rand(-0.08, 0.08);
  const detail = rand(0.45, 1.6); // how densely this hand samples a line
  return strokes.map((ideal) => {
    // Resample the stroke to this hand's density.
    const n = Math.max(3, Math.round(ideal.length * detail));
    const stroke = Array.from({ length: n }, (_, i) => {
      const at = (i / (n - 1)) * (ideal.length - 1);
      const a = ideal[Math.floor(at)];
      const b = ideal[Math.min(ideal.length - 1, Math.floor(at) + 1)];
      const f = at - Math.floor(at);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    });
    let driftX = 0;
    let driftY = 0;
    let tempo = 1;
    return stroke.map((pt, i) => {
      driftX += rand(-1.1, 1.1);
      driftY += rand(-1.1, 1.1);
      if (chance(0.12)) tempo = logNormal(1, 0.9); // the hand speeds up or slows down for a stretch
      const prev = stroke[i - 1] ?? pt;
      const next = stroke[i + 1] ?? pt;
      const turn = Math.abs(Math.atan2(next.y - pt.y, next.x - pt.x) - Math.atan2(pt.y - prev.y, pt.x - prev.x));
      const dx = (pt.x - 0.5) * scale;
      const dy = (pt.y - 0.5) * scale;
      return {
        x: box.x + box.width * (0.5 + shiftX + dx + dy * lean) + driftX,
        y: box.y + box.height * (0.5 + shiftY + dy) + driftY,
        wait:
          logNormal(12, 0.75) * pace * tempo * (1 + 2.5 * Math.min(1, turn)) * (i < 3 || i > stroke.length - 4 ? 1.8 : 1) +
          (chance(0.04) ? rand(120, 650) : 0), // a dead stop to look at it
      };
    });
  });
}

// ---------------------------------------------------------------------------
// One session
// ---------------------------------------------------------------------------

function load(): any {
  try {
    return createRequire(path.join(process.cwd(), "package.json"))("playwright");
  } catch {
    throw new Error("The stealth bot needs Playwright: npm i -D playwright && npx playwright install chromium");
  }
}

export const STEALTH_PERSONAS = PERSONAS.map((p) => p.name);

export async function runStealthBot(url: string, agentKey: string, index: number): Promise<BotResult> {
  const { chromium, devices } = load();
  const persona = PERSONAS[index % PERSONAS.length];
  const phone = persona.device === "phone";
  const handle = `deep-${persona.name}-${Math.random().toString(36).slice(2, 5)}`;
  const circumstances = pickOne(TODAY);
  const body = newBody();
  const lengths = answerLengths(8);

  // An ordinary-looking browser: no automation flag, no "Headless" in the user agent.
  const browser = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled"] });
  try {
    const version = browser.version().split(".")[0];
    const context = await browser.newContext(
      phone
        ? { ...devices["Pixel 7"], locale: "en-US", timezoneId: pickOne(["America/Chicago", "America/New_York", "America/Los_Angeles"]) }
        : {
            viewport: { width: randInt(1180, 1560), height: randInt(720, 900) },
            deviceScaleFactor: pickOne([1, 2]),
            userAgent: `Mozilla/5.0 (${pickOne(["Windows NT 10.0; Win64; x64", "Macintosh; Intel Mac OS X 10_15_7"])}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`,
            locale: "en-US",
            timezoneId: pickOne(["America/Chicago", "America/New_York", "America/Denver", "America/Los_Angeles"]),
          },
    );
    await context.addInitScript((desktop: boolean) => {
      Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
      // A desktop Chrome lists five built-in PDF plugins; a headless one lists none.
      if (desktop && navigator.plugins.length === 0) {
        Object.defineProperty(Navigator.prototype, "plugins", { get: () => ({ length: 5 }) });
      }
    }, !phone);
    const page = await context.newPage();
    const hand = new Hand(page);
    const typist = new Typist(page, persona, body);
    const cdp = phone ? await context.newCDPSession(page) : null;

    const press = async (locator: any) => {
      const at = await centre(locator);
      if (phone) await page.touchscreen.tap(at.x, at.y);
      else await hand.click(at);
    };
    const write = (text: string) => (phone ? thumbType(page, persona, text) : typist.type(text));

    // In through the agents' page, like a builder's browser-driving agent would.
    await page.goto(new URL("/agents", url).href);
    await page.getByLabel("Agent key").waitFor();
    await sleep(rand(800, 2000));
    await press(page.getByLabel("Agent key"));
    await page.keyboard.insertText(agentKey); // pasted, as a key would be
    await sleep(rand(300, 800));
    await press(page.getByLabel("Name for this run"));
    await write(handle);
    await sleep(rand(300, 900));
    await press(page.getByRole("button", { name: "Start a run in this browser" }));
    await page.waitForURL("**/play");

    const history: { q: string; a: string }[] = [];
    for (;;) {
      const next = await Promise.race([
        page.getByLabel("Your answer").waitFor().then(() => "text" as const),
        page.getByLabel("Drawing area").waitFor().then(() => "draw" as const),
        page.getByText("out of 100 human").waitFor().then(() => "result" as const),
      ]);
      if (next === "result") break;
      const prompt: string = (await page.getByRole("heading", { level: 1 }).textContent()) ?? "";

      // Read the question. Longer questions take longer; the hand doesn't sit still.
      // Sometimes they start almost at once, sometimes they stare at it.
      const reading = logNormal(500 + prompt.length * 34, 0.8) + (chance(0.25) ? logNormal(4500, 0.7) : 0);
      const answerReady = next === "text" ? writeAnswer(persona, circumstances, prompt, history, lengths[history.length]) : null;
      const readUntil = Date.now() + reading;
      while (Date.now() < readUntil) {
        if (!phone && chance(0.6)) await hand.fidget();
        else await sleep(rand(300, 900));
      }

      if (next === "text") {
        const text = await answerReady!;
        await press(page.getByLabel("Your answer"));
        await sleep(logNormal(700, 0.5));
        await write(text);
        history.push({ q: prompt, a: text });
        await sleep(logNormal(900, 0.7)); // glance over it
        if (!phone && body.submitsWithKeys) await page.keyboard.press("Control+Enter", { delay: logNormal(90, 0.3) });
        else await press(page.getByRole("button", { name: "Answer" }));
      } else {
        const box = await page.getByLabel("Drawing area").boundingBox();
        const strokes = byHand(sketch(prompt), box, body.drawPace);
        // Some people go over a line again, or add a stray mark.
        if (chance(0.3)) strokes.push(strokes[randInt(0, strokes.length - 1)].map((pt) => ({ ...pt, x: pt.x + rand(-3, 3), y: pt.y + rand(-3, 3) })));
        for (const stroke of strokes) {
          if (phone) {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: stroke[0].x, y: stroke[0].y }] });
            for (const pt of stroke.slice(1)) {
              await sleep(pt.wait);
              await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: pt.x, y: pt.y }] });
            }
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          } else {
            await hand.moveTo(stroke[0], rand(180, 420));
            await sleep(rand(60, 200));
            await page.mouse.down();
            for (const pt of stroke.slice(1)) {
              await sleep(pt.wait);
              await page.mouse.move(pt.x, pt.y);
            }
            hand.pos = { x: stroke[stroke.length - 1].x, y: stroke[stroke.length - 1].y };
            await sleep(rand(30, 120));
            await page.mouse.up();
          }
          await sleep(logNormal(420, 0.5)); // lift, look, place again
        }
        await sleep(logNormal(800, 0.4));
        await press(page.getByRole("button", { name: "Done" }));
      }
      await page.getByRole("heading", { level: 1, name: prompt, exact: true }).waitFor({ state: "detached", timeout: 120_000 });
    }

    const score = Number(await page.locator(".text-8xl").textContent());
    const quip = ((await page.locator("p.font-display").textContent()) ?? "").replace(/[\u201c\u201d]/g, "");
    return { persona: `deep-${persona.name} (${persona.device})`, handle, score, verdict: score >= 50 ? "human" : "agent", quip };
  } finally {
    await browser.close();
  }
}
