import "./env";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import type { Kind, Question } from "../src/lib/types";
import { runBrowserBot } from "./bots/browser";
import { sendDebrief } from "./bots/debrief";
import { fabricateGame, type GameSkill } from "./bots/games";
import { PERSONAS, type Persona } from "./bots/personas";
import { STEALTH_PERSONAS, runStealthBot } from "./bots/stealth";
import { rand } from "./bots/synth";
import { answerText } from "./bots/text";

/**
 * Send the house agents through a running game.
 *
 *   npm run bots                              every persona once, against localhost:3000
 *   npm run bots -- --only humanizer --count 5
 *   npm run bots -- --fast                    don't wait out the fabricated typing time
 *   npm run bots -- --llm                     write real answers with Claude (needs credentials)
 *   npm run bots -- --browser                 also run the Playwright bot through the real page
 *   npm run bots -- --stealth 8               only the hardest agents: a real browser driven like a person,
 *                                             one persona each, answers written by Claude (needs credentials)
 *   npm run bots -- --human                   play the human side instead, as a bot pretending to be a player
 *   npm run bots -- --wallets .solana-dev/players
 *                                             pay each run's fee from these test wallets
 *
 * Agents enter with an agent key: --agent-key, or AGENT_KEY in .env.local.
 * Mark the key as the house's on the owner page and its runs are free and
 * can't win. Every run is recorded as an agent and trains the judge.
 */

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: process.env.PMH_URL ?? "http://localhost:3000" },
    only: { type: "string" },
    count: { type: "string", default: "1" },
    "agent-key": { type: "string", default: process.env.AGENT_KEY },
    fast: { type: "boolean", default: false },
    llm: { type: "boolean", default: false },
    browser: { type: "boolean", default: false },
    stealth: { type: "string" },
    "stealth-from": { type: "string", default: "0" },
    human: { type: "boolean", default: false },
    wallets: { type: "string" },
    rpc: { type: "string", default: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com" },
  },
});

export interface BotResult {
  persona: string;
  handle: string;
  score: number;
  verdict: Kind;
  quip: string;
  /** What the judge said moved the score, when the run reports it. */
  why?: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(pathname: string, body: unknown, userAgent?: string) {
  const res = await fetch(new URL(pathname, args.url), {
    method: "POST",
    headers: { "content-type": "application/json", ...(userAgent ? { "user-agent": userAgent } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function loadWallets(): Keypair[] {
  if (!args.wallets) return [];
  return readdirSync(args.wallets)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.join(args.wallets!, f), "utf8")))));
}

/** Sign and send the entry-fee transaction the server prepared, as a wallet would. */
async function pay(wallet: Keypair, transactionBase64: string): Promise<string> {
  const connection = new Connection(args.rpc!, "confirmed");
  const tx = Transaction.from(Buffer.from(transactionBase64, "base64"));
  tx.partialSign(wallet);
  const signature = await connection.sendRawTransaction(tx.serialize());
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  return signature;
}

async function play(persona: Persona, wallet?: Keypair): Promise<BotResult> {
  const handle = `${persona.name}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 20);
  const ua = persona.name === "api-bot" ? undefined : persona.respond({ id: "", kind: "text", category: "", prompt: "" }, "x", 0).env?.ua;
  // The bot side by default; the human side, as an impostor, with --human.
  const path = args.human ? "/api/enter" : "/api/agents/enter";
  const entry = args.human ? { handle, wallet: wallet?.publicKey.toBase58() } : { handle, key: args["agent-key"] };

  let entered = await post(path, entry, ua);
  if (entered.status === 402 && entered.json.payment) {
    if (!wallet) throw new Error("The server wants a fee. Pass --wallets <dir of keypairs>, or use a house key.");
    const payment = entered.json.payment as { roundId: string; intentId: string; transaction: string };
    const signature = await pay(wallet, payment.transaction);
    entered = await post(path, { ...entry, roundId: payment.roundId, intentId: payment.intentId, signature }, ua);
  }
  if (entered.status !== 200) throw new Error(`${handle}: could not enter: ${entered.json.message}`);

  const token = entered.json.token as string;
  let step = entered.json as { question?: Question; hunt?: { id: string } };
  let clock = rand(3000, 9000);
  for (;;) {
    let res;
    if (step.hunt) {
      // A bot on the human side has to hunt too. This one guesses.
      await sleep(args.fast ? 100 : rand(2500, 7000));
      res = await post("/api/hunt", { token, huntId: step.hunt.id, pick: Math.random() < 0.5 ? 0 : 1, reason: "the other one read more naturally to me" }, ua);
    } else {
      const question = step.question!;
      // An answer that breaks the rules of play comes back; a canned line can do that by repeating one. Try another.
      for (let attempt = 0; ; attempt++) {
        const text = await answerText(question, persona.voice, args.llm!);
        const telemetry = persona.respond(question, text, clock);
        // Mini-games: the crude personas play like scripts, the careful ones like people.
        const skill: GameSkill = ["api-bot", "paster", "metronome"].includes(persona.name) ? "robot" : "human";
        const played = fabricateGame(question, skill);
        if (played) {
          telemetry.game = played.game;
          telemetry.submittedAt += Math.round(played.ms);
        }
        const wait = played && skill === "human" ? telemetry.submittedAt - telemetry.shownAt : (persona.latencyMs?.(telemetry) ?? telemetry.submittedAt - telemetry.shownAt);
        await sleep(args.fast ? wait / 25 : wait);
        res = await post("/api/answer", { token, questionId: question.id, text, telemetry }, ua);
        clock = telemetry.submittedAt + rand(300, 900);
        if (!(res.status === 400 && res.json.error === "answer_rejected" && attempt < 4)) break;
      }
    }
    if (res.status !== 200) throw new Error(`${handle}: move rejected: ${res.json.message}`);
    if (res.json.done) {
      const r = res.json.result as { score: number; verdict: Kind; quip: string; prize?: { tokens: number }; cancelled?: boolean; why?: { reasons: string[] } };
      // An agent that fooled the judge owes it an account of how.
      const debriefed = !args.human && (await sendDebrief(args.url!, token, { what: `Persona "${persona.name}": ${persona.about}`, file: "scripts/bots/personas.ts" }));
      const note = (r.prize ? ` [won ${r.prize.tokens}]` : r.cancelled ? " [cancelled]" : "") + (debriefed ? " [debriefed]" : "");
      return { persona: persona.name, handle, score: r.score, verdict: r.verdict, quip: r.quip + note, why: r.why?.reasons };
    }
    step = res.json as typeof step;
  }
}

async function main() {
  const wanted = args.only?.split(",").map((s) => s.trim());
  const stealth = Math.max(0, Number(args.stealth) || 0);
  // Asking for stealth sessions alone runs just those.
  const roster = PERSONAS.filter((p) => (wanted ? wanted.includes(p.name) : stealth === 0));
  if (wanted && roster.length !== wanted.filter((w) => w !== "browser").length) {
    throw new Error(`Unknown persona in --only. Available: ${PERSONAS.map((p) => p.name).join(", ")}, browser`);
  }
  const count = Math.max(1, Number(args.count) || 1);
  const wallets = loadWallets();

  const jobs: Promise<BotResult>[] = [];
  let w = 0;
  for (const persona of roster) {
    // An agent key pays from its builder's wallet, so every agent run signs with the first one.
    for (let i = 0; i < count; i++) jobs.push(play(persona, wallets.length ? wallets[args.human ? w++ % wallets.length : 0] : undefined));
  }
  if (!args.human && !args["agent-key"]) {
    throw new Error("Agents need a key: pass --agent-key, or set AGENT_KEY in .env.local. Get one at /agents.");
  }
  if (args.browser || wanted?.includes("browser")) jobs.push(runBrowserBot(args.url!, args["agent-key"]!, { llm: args.llm! }));
  for (let i = 0; i < stealth; i++) jobs.push(runStealthBot(args.url!, args["agent-key"]!, Number(args["stealth-from"]) + i));
  if (stealth) console.log(`Stealth personas: ${STEALTH_PERSONAS.join(", ")}`);

  console.log(`Running ${jobs.length} bot(s) against ${args.url}${args.fast ? " (fast)" : ", in real time; this takes a minute or two"}…`);
  const settled = await Promise.allSettled(jobs);
  const results = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  const failures = settled.flatMap((s) => (s.status === "rejected" ? [String(s.reason?.message ?? s.reason)] : []));

  results.sort((a, b) => b.score - a.score);
  console.log("\n  score  verdict  persona            judge said");
  for (const r of results) {
    console.log(`  ${r.score.toFixed(1).padStart(5)}  ${r.verdict.padEnd(7)}  ${r.persona.padEnd(22)}  ${r.quip}`);
    // The judge's reasons, as the agent's builder is given them.
    for (const reason of r.why ?? []) console.log(`${" ".repeat(18)}· ${reason}`);
  }
  if (results.length) {
    const fooled = results.filter((r) => r.verdict === "human").length;
    console.log(`\n${fooled} of ${results.length} bots passed as human.`);
  }
  for (const f of failures) console.error(`FAILED: ${f}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
