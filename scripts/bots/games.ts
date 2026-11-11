import type { GamePlay, Question } from "../../src/lib/types";
import { logNormal, rand } from "./synth";

/**
 * How the house's agents play the mini-games. "robot" plays them the way a
 * script does when nobody has thought about it: instantly and exactly.
 * "human" imitates a person: reactions around a quarter of a second that
 * never repeat, and holds that miss the target by a few percent.
 */
export type GameSkill = "robot" | "human";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reaction = (skill: GameSkill) => (skill === "robot" ? rand(8, 14) : Math.max(150, logNormal(265, 0.18)));
const hold = (skill: GameSkill, target: number) => (skill === "robot" ? target + rand(-2, 2) : target * rand(0.86, 1.14));

/** What an agent talking straight to the API sends back for a mini-game, and how long playing it would have taken. */
export function fabricateGame(question: Question, skill: GameSkill): { game: GamePlay; ms: number } | null {
  if (question.kind === "tap") {
    const waits = question.game?.waits ?? [];
    const taps = waits.map(() => Math.round(reaction(skill) * 10) / 10);
    return { game: { taps, early: 0 }, ms: waits.reduce((n, w) => n + w, 0) + taps.reduce((n, t) => n + t, 0) + 600 };
  }
  if (question.kind === "hold") {
    const holds = Array.from({ length: question.game?.tries ?? 3 }, () => Math.round(hold(skill, question.game?.holdMs ?? 3000)));
    return { game: { holds }, ms: holds.reduce((n, h) => n + h, 0) + holds.length * 700 };
  }
  return null;
}

/** Play whichever mini-game is on the page, for agents that drive a browser. `page` is a Playwright page. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function playGameOnPage(page: any, kind: "tap" | "hold", skill: GameSkill): Promise<void> {
  if (kind === "tap") {
    const pad = page.getByLabel("Reaction pad");
    const box = await pad.boundingBox();
    const at = () => [box.x + box.width * rand(0.35, 0.65), box.y + box.height * rand(0.35, 0.65)] as const;
    await page.mouse.move(...at());
    await sleep(skill === "robot" ? 50 : rand(500, 1200));
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
