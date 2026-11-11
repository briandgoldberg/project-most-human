import type { GamePlay, Question } from "../../src/lib/types";
import { logNormal, rand } from "./synth";

/**
 * How the house's agents play the mini-games. "robot" plays them the way a
 * script does when nobody has thought about it: instantly and exactly.
 * "human" imitates a person: reactions around a quarter of a second that
 * never repeat, holds and beats that miss by a few percent, dots hit a little
 * off centre, and a sequence pressed back at an uneven pace.
 */
export type GameSkill = "robot" | "human";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reaction = (skill: GameSkill) => (skill === "robot" ? rand(8, 14) : Math.max(150, logNormal(265, 0.18)));
const hold = (skill: GameSkill, target: number) => (skill === "robot" ? target + rand(-2, 2) : target * rand(0.86, 1.14));
/** Reaching a dot: see it, then travel, longer for the far ones. A script is simply there. */
const reach = (skill: GameSkill, distance: number) => (skill === "robot" ? rand(8, 14) : Math.max(220, logNormal(330 + distance * 420, 0.2)));
/** Where on the dot the hit lands, as a share of its radius: a script hits the middle. */
const offCentre = (skill: GameSkill) => (skill === "robot" ? 0 : Math.min(0.95, Math.abs(logNormal(0.32, 0.5))));
const beat = (skill: GameSkill, target: number) => (skill === "robot" ? target + rand(-1, 1) : target * rand(0.9, 1.08));
const between = (skill: GameSkill) => (skill === "robot" ? rand(10, 14) : Math.max(200, logNormal(520, 0.3)));

/** What an agent talking straight to the API sends back for a mini-game, and how long playing it would have taken. */
export function fabricateGame(question: Question, skill: GameSkill): { game: GamePlay; ms: number } | null {
  const spec = question.game ?? {};
  const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
  const tenth = (x: number) => Math.round(x * 10) / 10;
  if (question.kind === "tap") {
    const waits = spec.waits ?? [];
    const taps = waits.map(() => tenth(reaction(skill)));
    return { game: { taps, early: 0 }, ms: sum(waits) + sum(taps) + 600 };
  }
  if (question.kind === "hold") {
    const holds = Array.from({ length: spec.tries ?? 3 }, () => Math.round(hold(skill, spec.holdMs ?? 3000)));
    return { game: { holds }, ms: sum(holds) + holds.length * 700 };
  }
  if (question.kind === "aim") {
    const targets = spec.targets ?? [];
    const hits = targets.map(([x, y], i) => tenth(reach(skill, i ? Math.hypot(x - targets[i - 1][0], y - targets[i - 1][1]) : 0.5)));
    const offsets = targets.map(() => Math.round(offCentre(skill) * 1000) / 1000);
    return { game: { hits, offsets, misses: 0 }, ms: targets.length * (spec.gapMs ?? 250) + sum(hits) + 900 };
  }
  if (question.kind === "beat") {
    const beatGaps = Array.from({ length: Math.max(0, (spec.beats ?? 6) - 1) }, () => tenth(beat(skill, spec.beatMs ?? 600)));
    return { game: { beatGaps }, ms: (spec.pulses ?? 4) * (spec.beatMs ?? 600) + sum(beatGaps) + 900 };
  }
  if (question.kind === "recall") {
    const sequence = spec.sequence ?? [];
    // A person gets one wrong now and then; a script reading the question never does.
    const slip = skill === "human" && Math.random() < 0.2 ? Math.floor(Math.random() * sequence.length) : -1;
    const picks = sequence.map((pad, i) => (i === slip ? (pad + 1) % 4 : pad));
    const pickGaps = sequence.map((_, i) => tenth(between(skill) + (i === 0 && skill === "human" ? rand(200, 600) : 0)));
    return { game: { picks, pickGaps }, ms: sequence.length * (spec.showMs ?? 560) + sum(pickGaps) + 1500 };
  }
  return null;
}

/** The mini-games an agent driving a browser can find on the page, by the label of what it has to press. */
export const GAMES_ON_PAGE = { tap: "Reaction pad", hold: "Hold button", aim: "Aim area", beat: "Beat pad", recall: "Memory pads" } as const;
export type PageGame = keyof typeof GAMES_ON_PAGE;

/** Play whichever mini-game is on the page, for agents that drive a browser. `page` is a Playwright page. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function playGameOnPage(page: any, kind: PageGame, skill: GameSkill): Promise<void> {
  const settle = () => sleep(skill === "robot" ? 50 : rand(500, 1200));
  const click = async (x: number, y: number) => {
    await page.mouse.move(x, y, { steps: skill === "robot" ? 1 : Math.round(rand(6, 14)) });
    await page.mouse.down();
    await sleep(skill === "robot" ? 1 : rand(50, 110));
    await page.mouse.up();
  };
  const somewhereOn = (box: { x: number; y: number; width: number; height: number }) =>
    [box.x + box.width * rand(0.35, 0.65), box.y + box.height * rand(0.35, 0.65)] as const;

  if (kind === "tap") {
    const pad = page.getByLabel("Reaction pad");
    const box = await pad.boundingBox();
    await page.mouse.move(...somewhereOn(box));
    await settle();
    await page.mouse.down();
    await page.mouse.up();
    for (;;) {
      const state = await Promise.race([
        page.locator('[aria-label="Reaction pad"][data-state="lit"]').waitFor({ timeout: 15_000 }).then(() => "lit"),
        page.locator('[aria-label="Reaction pad"][data-state="done"]').waitFor({ timeout: 15_000 }).then(() => "done"),
        pad.waitFor({ state: "detached", timeout: 15_000 }).then(() => "done"),
      ]).catch(() => "done");
      if (state === "done") return;
      await sleep(reaction(skill));
      await page.mouse.down();
      await sleep(skill === "robot" ? 1 : rand(50, 110));
      await page.mouse.up();
      // Let the pad leave its lit state before looking again.
      await page.locator('[aria-label="Reaction pad"]:not([data-state="lit"])').waitFor({ timeout: 5000 }).catch(() => undefined);
    }
  }

  if (kind === "aim") {
    const area = page.getByLabel("Aim area");
    await settle();
    await click(...somewhereOn(await area.boundingBox()));
    let from = { x: 0.5, y: 0.5 };
    for (;;) {
      const state = await Promise.race([
        page.locator('[aria-label="Aim area"] [data-dot]').waitFor({ timeout: 15_000 }).then(() => "dot"),
        page.locator('[aria-label="Aim area"][data-state="done"]').waitFor({ timeout: 15_000 }).then(() => "done"),
        area.waitFor({ state: "detached", timeout: 15_000 }).then(() => "done"),
      ]).catch(() => "done");
      if (state === "done") return;
      const dot = await page.locator('[aria-label="Aim area"] [data-dot]').boundingBox().catch(() => null);
      const arena = await area.boundingBox().catch(() => null);
      if (!dot || !arena) return;
      const centre = { x: dot.x + dot.width / 2, y: dot.y + dot.height / 2 };
      const to = { x: (centre.x - arena.x) / arena.width, y: (centre.y - arena.y) / arena.height };
      await sleep(reach(skill, Math.hypot(to.x - from.x, to.y - from.y)));
      // A hand lands somewhere on the dot; a script lands in the middle of it.
      const off = offCentre(skill) * (dot.width / 2);
      const angle = rand(0, 2 * Math.PI);
      await click(centre.x + off * Math.cos(angle), centre.y + off * Math.sin(angle));
      from = to;
      // Let this dot go before looking for the next.
      await page.locator('[aria-label="Aim area"]:not([data-state="dot"])').waitFor({ timeout: 5000 }).catch(() => undefined);
    }
  }

  if (kind === "beat") {
    const padOf = '[aria-label="Beat pad"]';
    // Time the pulses as they happen, the way anything watching the page would.
    const heard: Promise<number> = page.evaluate((selector: string) => {
      return new Promise<number>((resolve) => {
        const el = document.querySelector(selector)!;
        const lit: number[] = [];
        const watch = new MutationObserver(() => {
          if (el.getAttribute("data-lit") === "1") lit.push(performance.now());
          if (el.getAttribute("data-state") !== "yours") return;
          watch.disconnect();
          const gaps = lit.slice(1).map((t, i) => t - lit[i]).sort((a, b) => a - b);
          resolve(gaps[gaps.length >> 1] ?? 600);
        });
        watch.observe(el, { attributes: true });
      });
    }, padOf);
    const box = await page.locator(padOf).boundingBox();
    await sleep(150);
    await settle();
    await click(...somewhereOn(box));
    const every = await heard;
    const wanted = Number(/(\d+) taps/.exec((await page.getByRole("status").last().textContent()) ?? "")?.[1] ?? 6);
    // Carry the beat on from where the pulses left off.
    await sleep(skill === "robot" ? every / 2 : every * rand(0.4, 0.6));
    for (let i = 0; i < wanted; i++) {
      if (i) await sleep(Math.max(0, beat(skill, every) - (skill === "robot" ? 1 : 80)));
      if ((await page.locator(`${padOf}[data-state="yours"]`).count()) === 0) return;
      await page.mouse.down();
      await sleep(skill === "robot" ? 1 : rand(50, 110));
      await page.mouse.up();
    }
    return;
  }

  if (kind === "recall") {
    const pads = '[aria-label="Memory pads"]';
    // Note which pads light, in order, as they are shown.
    const shown: Promise<number[]> = page.evaluate((selector: string) => {
      return new Promise<number[]>((resolve) => {
        const el = document.querySelector(selector)!;
        const order: number[] = [];
        const watch = new MutationObserver((changes) => {
          for (const change of changes) {
            const target = change.target as Element;
            if (target !== el && target.getAttribute("data-lit") === "1") order.push(Number(target.getAttribute("aria-label")?.replace("Pad ", "")) - 1);
          }
          if (el.getAttribute("data-state") !== "yours") return;
          watch.disconnect();
          resolve(order);
        });
        watch.observe(el, { attributes: true, subtree: true, attributeFilter: ["data-lit", "data-state"] });
      });
    }, pads);
    await sleep(150);
    await settle();
    await click(...somewhereOn(await page.getByLabel("Pad 1").boundingBox()));
    const order = await shown;
    await sleep(skill === "robot" ? 20 : rand(300, 800));
    for (const padIndex of order) {
      if ((await page.locator(`${pads}[data-state="yours"]`).count()) === 0) return;
      await click(...somewhereOn(await page.getByLabel(`Pad ${padIndex + 1}`).boundingBox()));
      // The page takes presses closer together than this for one finger bouncing, so even a script has to leave a gap.
      await sleep(skill === "robot" ? 70 : between(skill));
    }
    return;
  }

  const prompt: string = (await page.getByRole("heading", { level: 1 }).textContent()) ?? "";
  const target = Number(/(\d+) seconds/.exec(prompt)?.[1] ?? 3) * 1000;
  const button = page.getByLabel("Hold button");
  const box = await button.boundingBox();
  for (let i = 0; i < 3; i++) {
    if ((await button.count()) === 0 || (await button.getAttribute("data-state").catch(() => "done")) === "done") return;
    await page.mouse.move(box.x + box.width * rand(0.35, 0.65), box.y + box.height * rand(0.35, 0.65));
    await sleep(skill === "robot" ? 60 : rand(400, 1100));
    await page.mouse.down();
    await sleep(hold(skill, target));
    await page.mouse.up();
    await sleep(skill === "robot" ? 80 : rand(500, 1000));
  }
}
