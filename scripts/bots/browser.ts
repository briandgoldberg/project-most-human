import { createRequire } from "node:module";
import path from "node:path";
import type { BotResult } from "../run-bots";
import { SESSION_KEY, sendDebrief } from "./debrief";
import { playGameOnPage } from "./games";
import { answerText } from "./text";

/**
 * A bot that plays through the real page in a real (headless) browser, so the
 * game's own collector records it. This is what a typical automation script
 * looks like, and it doubles as an end-to-end test of the UI.
 *
 * Needs Playwright: npm i -D playwright && npx playwright install chromium
 */
export async function runBrowserBot(url: string, agentKey: string, opts: { llm: boolean; keyDelayMs?: number }): Promise<BotResult> {
  // Playwright is optional, so it is resolved at run time and left untyped.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chromium: any;
  try {
    ({ chromium } = createRequire(path.join(process.cwd(), "package.json"))("playwright"));
  } catch {
    throw new Error("The browser bot needs Playwright: npm i -D playwright && npx playwright install chromium");
  }
  const handle = `browser-${Math.random().toString(36).slice(2, 6)}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // In through the agents' page, like a builder's browser-driving agent would.
    await page.goto(new URL("/agents", url).href);
    await page.getByLabel("Agent key").fill(agentKey);
    await page.getByLabel("Name for this run").fill(handle);
    await page.getByRole("button", { name: "Start a run in this browser" }).click();
    await page.waitForURL("**/play");

    for (;;) {
      const next = await Promise.race([
        page.getByLabel("Your answer").waitFor().then(() => "text" as const),
        page.getByLabel("Drawing area").waitFor().then(() => "draw" as const),
        page.getByLabel("Reaction pad").waitFor().then(() => "tap" as const),
        page.getByLabel("Hold button").waitFor().then(() => "hold" as const),
        page.getByText("out of 100 human").waitFor().then(() => "result" as const),
      ]);
      if (next === "result") break;
      const prompt = (await page.getByRole("heading", { level: 1 }).textContent()) ?? "";
      if (next === "tap" || next === "hold") {
        await playGameOnPage(page, next, "robot");
      } else if (next === "text") {
        const text = await answerText({ id: "", kind: "text", category: "", prompt }, "assistant", opts.llm);
        await page.getByLabel("Your answer").click();
        await page.keyboard.type(text, { delay: opts.keyDelayMs ?? 35 });
        await page.getByRole("button", { name: "Answer" }).click();
      } else {
        const box = (await page.getByLabel("Drawing area").boundingBox())!;
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await page.mouse.move(cx + 80, cy);
        await page.mouse.down();
        for (let a = 0; a <= 2 * Math.PI + 0.01; a += Math.PI / 24) {
          await page.mouse.move(cx + 80 * Math.cos(a), cy + 80 * Math.sin(a));
        }
        await page.mouse.up();
        await page.getByRole("button", { name: "Done" }).click();
      }
      // Wait for this question to be replaced by the next one (or the result).
      await page.getByRole("heading", { level: 1, name: prompt, exact: true }).waitFor({ state: "detached" });
    }

    const score = Number(await page.locator(".text-8xl").textContent());
    const quip = ((await page.locator("p.font-display").textContent()) ?? "").replace(/[“”]/g, "");
    const token = await page.evaluate((key: string) => JSON.parse(sessionStorage.getItem(key) ?? "null")?.token as string | undefined, SESSION_KEY);
    if (token) {
      await sendDebrief(url, token, {
        what: "A headless browser driven by Playwright: answers written by a language model, typed with Playwright's keyboard at a fixed delay, pointer moved in straight steps.",
        file: "scripts/bots/browser.ts",
      });
    }
    return { persona: "browser", handle, score, verdict: score >= 50 ? "human" : "agent", quip };
  } finally {
    await browser.close();
  }
}
