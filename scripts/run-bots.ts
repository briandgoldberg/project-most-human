import "./env";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import type { Kind, Question } from "../src/lib/types";
import { runBrowserBot } from "./bots/browser";
import { PERSONAS, type Persona } from "./bots/personas";
import { STEALTH_PERSONAS, runStealthBot } from "./bots/stealth";
import { rand } from "./bots/synth";
import { answerText } from "./bots/text";

/**
 * Send the house bots through a running game.
 *
 *   npm run bots                              every persona once, against localhost:3000
 *   npm run bots -- --only humanizer --count 5
 *   npm run bots -- --fast                    don't wait out the fabricated typing time
 *   npm run bots -- --llm                     write real answers with Claude (needs credentials)
 *   npm run bots -- --browser                 also run the Playwright bot through the real page
 *   npm run bots -- --stealth 8               only the hardest agents: a real browser driven like a person,
 *                                             one persona each, answers written by Claude (needs credentials)
 *   npm run bots -- --paying --wallets .solana-dev/players
 *                                             enter the public competition as paying players instead
 *
 * By default the bots play in the private training room using the house-bot
 * password, so every run adds agent-labelled examples to data/training/.
 */

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: process.env.PMH_URL ?? "http://localhost:3000" },
    only: { type: "string" },
    count: { type: "string", default: "1" },
    password: { type: "string", default: process.env.HOUSE_BOT_PASSWORD ?? "housebot-dev" },
    fast: { type: "boolean", default: false },
    llm: { type: "boolean", default: false },
    browser: { type: "boolean", default: false },
    stealth: { type: "string" },
    "stealth-from": { type: "string", default: "0" },
    paying: { type: "boolean", default: false },
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
  // Training room by default; the public competition (and its entry fee) with --paying.
  const entry = args.paying ? { handle, wallet: wallet?.publicKey.toBase58() } : { handle, password: args.password };

  let entered = await post(args.paying ? "/api/enter" : "/api/train/enter", entry, ua);
  if (entered.status === 402 && entered.json.payment) {
    if (!wallet) throw new Error("The server wants an entry fee. Pass --wallets <dir of keypairs> with --paying.");
    const payment = entered.json.payment as { roundId: string; intentId: string; transaction: string };
    const signature = await pay(wallet, payment.transaction);
    entered = await post("/api/enter", { ...entry, roundId: payment.roundId, intentId: payment.intentId, signature }, ua);
  }
  if (entered.status !== 200) throw new Error(`${handle}: could not enter: ${entered.json.message}`);

  const token = entered.json.token as string;
  let question = entered.json.question as Question;
  let clock = rand(3000, 9000);
  for (;;) {
    const text = await answerText(question, persona.voice, args.llm!);
    const telemetry = persona.respond(question, text, clock);
    const wait = persona.latencyMs?.(telemetry) ?? telemetry.submittedAt - telemetry.shownAt;
    await sleep(args.fast ? wait / 25 : wait);
    const res = await post("/api/answer", { token, questionId: question.id, text, telemetry }, ua);
    if (res.status !== 200) throw new Error(`${handle}: answer rejected: ${res.json.message}`);
    if (res.json.done) {
      const r = res.json.result as { score: number; verdict: Kind; quip: string };
      return { persona: persona.name, handle, score: r.score, verdict: r.verdict, quip: r.quip };
    }
    question = res.json.question as Question;
    clock = telemetry.submittedAt + rand(300, 900);
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
    for (let i = 0; i < count; i++) jobs.push(play(persona, wallets.length ? wallets[w++ % wallets.length] : undefined));
  }
  if (args.browser || wanted?.includes("browser")) jobs.push(runBrowserBot(args.url!, args.password!, { llm: args.llm! }));
  for (let i = 0; i < stealth; i++) jobs.push(runStealthBot(args.url!, args.password!, Number(args["stealth-from"]) + i));
  if (stealth) console.log(`Stealth personas: ${STEALTH_PERSONAS.join(", ")}`);

  console.log(`Running ${jobs.length} bot(s) against ${args.url}${args.fast ? " (fast)" : ", in real time; this takes a minute or two"}…`);
  const settled = await Promise.allSettled(jobs);
  const results = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  const failures = settled.flatMap((s) => (s.status === "rejected" ? [String(s.reason?.message ?? s.reason)] : []));

  results.sort((a, b) => b.score - a.score);
  console.log("\n  score  verdict  persona            judge said");
  for (const r of results) {
    console.log(`  ${r.score.toFixed(1).padStart(5)}  ${r.verdict.padEnd(7)}  ${r.persona.padEnd(22)}  ${r.quip}`);
  }
  if (results.length && !args.paying) {
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
