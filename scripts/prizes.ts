import "./env";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { PAYOUT_AUDIENCE, config } from "../src/lib/config";
import { markPrizePaid, prizesOwed } from "../src/lib/game";
import { MEMO_PROGRAM_ID, solanaSetup, toRawAmount } from "../src/lib/payments/solana";

/**
 * Pay the prizes that have been won: hunters who reached the prize round, and
 * agents that fooled the judge.
 *
 *   npm run prizes                      list what is owed
 *   npm run prizes -- --execute         pay it
 *
 * Paying real tokens needs the treasury key, from --treasury-key <keypair.json>
 * or the TREASURY_SECRET_KEY environment variable (base58 or JSON array). It is
 * only ever read by this script, never by the web server.
 *
 * It also runs unattended, once a day (.github/workflows/payouts.yml), so it
 * is careful in two ways. --cap <tokens> (or PAYOUT_CAP_TOKENS) is the most
 * one run may send: over that, it sends nothing and fails, for a person to
 * look. And every payment carries a memo naming the prize it pays, so a prize
 * that was sent but never recorded (the run died in between) is found on the
 * chain next time and recorded, not paid twice.
 *
 * There are two ways it can know what is owed. Given the store's own secret
 * (STORE_SECRET and the rest, as the website has them) it reads the store
 * directly. Given PAYOUT_SITE instead, as the scheduled job is, it asks the
 * website, proving who it is with the token GitHub signs for the run: it then
 * needs no copy of any of the website's settings, only the treasury's key.
 *
 * Before paying an agent's prize, have its builder show you the agent running:
 * a person answering by hand with an agent key doesn't qualify.
 */
const { values: args } = parseArgs({
  options: {
    execute: { type: "boolean", default: false },
    "treasury-key": { type: "string" },
    only: { type: "string" },
    // How far back to look. Players may leave prizes in their balance for a while before asking for them.
    days: { type: "string", default: "120" },
    // The most one run may send, in whole tokens. Unset or 0: no limit.
    cap: { type: "string", default: process.env.PAYOUT_CAP_TOKENS },
  },
});

function treasuryKeypair(): Keypair {
  const raw = args["treasury-key"] ? readFileSync(args["treasury-key"], "utf8") : process.env.TREASURY_SECRET_KEY;
  if (!raw) throw new Error("Paying needs the treasury key: pass --treasury-key <file> or set TREASURY_SECRET_KEY.");
  const trimmed = raw.trim();
  return Keypair.fromSecretKey(trimmed.startsWith("[") ? Uint8Array.from(JSON.parse(trimmed)) : bs58.decode(trimmed));
}

/**
 * How a prize is named in the output. The scheduled job's log can be read by anyone who can see the
 * repository, and every payment's recipient is public on the chain: naming the player next to it would tie
 * their handle to their wallet. So there the prize goes by its own id.
 */
const who = (e: { id: string; handle: string }) => (process.env.GITHUB_ACTIONS ? `prize ${e.id}` : e.handle);
const where = (wallet: string) => (process.env.GITHUB_ACTIONS ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : wallet);

/** One prize that is owed, as far as paying it goes. */
interface Owed {
  id: string;
  roundId: string;
  handle: string;
  wallet?: string | null;
  prize?: { tokens: number; reason: string };
}

/** Where what is owed is read from, and where what is paid is written down. */
interface Ledger {
  owed(days: number): Promise<Owed[]>;
  paid(prize: { roundId: string; id: string }, signature?: string): Promise<void>;
}

const directLedger: Ledger = { owed: (days) => prizesOwed(days), paid: (prize, signature) => markPrizePaid(prize, signature) };

/** The token GitHub signs for this workflow run, made out to the website. Short-lived, so a fresh one is asked for each time. */
async function runToken(): Promise<string> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error("This run can't prove who it is to the website. The workflow needs `permissions: id-token: write`.");
  const audience = process.env.PAYOUT_AUDIENCE || PAYOUT_AUDIENCE;
  const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, { headers: { authorization: `bearer ${bearer}` } });
  const token = res.ok ? ((await res.json()) as { value?: string }).value : undefined;
  if (!token) throw new Error(`GitHub wouldn't issue this run a token (${res.status}).`);
  return token;
}

/**
 * The website as the ledger. Asking it what is owed also brings back which
 * coin and treasury to pay from, so this job carries no settings of its own
 * that could drift from the website's.
 */
async function siteLedger(site: string): Promise<Ledger> {
  const call = async (method: "GET" | "POST", query: string, body?: unknown) => {
    const res = await fetch(new URL(`/api/payouts${query}`, site), {
      method,
      headers: { authorization: `Bearer ${await runToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`The website refused (${res.status}): ${String(json.message ?? json.error ?? "no reason given")}`);
    return json;
  };
  return {
    async owed(days) {
      const brief = (await call("GET", `?days=${days}`)) as unknown as {
        owed: Owed[];
        pay: { paymentMode: string; symbol: string; cluster: string; mint: string | null; treasury: string | null; rpcUrl: string };
      };
      const { pay } = brief;
      // The connection to the chain carries a key. Tell the runner to keep it out of the log before anything can print it.
      if (!process.env.SOLANA_RPC_URL && pay.rpcUrl) {
        const key = /[?&][^=]*key[^=]*=([^&]+)/i.exec(pay.rpcUrl)?.[1];
        if (process.env.GITHUB_ACTIONS) for (const hide of [pay.rpcUrl, key]) if (hide) console.log(`::add-mask::${hide}`);
        process.env.SOLANA_RPC_URL = pay.rpcUrl;
      }
      process.env.PAYMENT_MODE = pay.paymentMode;
      process.env.TOKEN_SYMBOL = pay.symbol;
      process.env.SOLANA_CLUSTER = pay.cluster;
      if (pay.mint) process.env.TOKEN_MINT = pay.mint;
      if (pay.treasury) process.env.TREASURY_WALLET = pay.treasury;
      return brief.owed;
    },
    paid: async (prize, signature) => void (await call("POST", "", { roundId: prize.roundId, id: prize.id, signature })),
  };
}

async function main() {
  const site = process.env.PAYOUT_SITE;
  const ledger = site ? await siteLedger(site) : directLedger;
  const owed = (await ledger.owed(Math.max(1, Number(args.days) || 120))).filter((e) => !args.only || e.id === args.only);
  // Read after the ledger has been asked: with the website as the ledger, that is where the coin and treasury come from.
  const cfg = config();
  console.log(`Paying in ${cfg.tokenSymbol}${cfg.paymentMode === "solana" ? ` on Solana ${cfg.solana.cluster}, from ${cfg.solana.treasury}` : " (test mode)"}${site ? `, as told by ${new URL(site).host}` : ""}.`);
  if (owed.length === 0) {
    console.log("Nothing is owed.");
    return;
  }
  const total = owed.reduce((n, e) => n + e.prize!.tokens, 0);
  console.log(`${owed.length} prize(s) owed, ${total} ${cfg.tokenSymbol} in all:`);
  for (const e of owed) {
    console.log(
      `  ${String(e.prize!.tokens).padStart(8)} ${cfg.tokenSymbol}  ${e.prize!.reason === "hunter" ? "hunter" : "agent "}  ${who(e).padEnd(20)}  ${e.wallet ? where(e.wallet) : "(in their balance: no address yet)"}  [${e.id}]`,
    );
  }
  // What this run would actually send: prizes with somewhere to go. The rest stay in their owners' balances.
  const payable = owed.filter((e) => e.wallet);
  const sending = payable.reduce((n, e) => n + e.prize!.tokens, 0);
  const cap = Number(args.cap) > 0 ? Number(args.cap) : Infinity;
  const overCap = sending > cap;
  console.log(`\n${payable.length} of them can be sent now: ${sending} ${cfg.tokenSymbol}.${overCap ? ` That is over the cap of ${cap}.` : ""}`);
  if (!args.execute) {
    console.log("Dry run. Add --execute to pay.");
    return;
  }
  if (overCap) {
    throw new Error(`This run would send ${sending} ${cfg.tokenSymbol}, over the cap of ${cap}. Nothing was sent. Look at what is owed, then raise the cap or pay by hand.`);
  }

  if (cfg.paymentMode === "mock") {
    for (const e of owed) await ledger.paid(e);
    console.log("\nMarked as paid (test mode: nothing was transferred).");
    return;
  }
  if (payable.length === 0) {
    console.log("Nothing to send: nobody owed a prize has given an address yet.");
    return;
  }

  const { connection, mint, decimals, tokenProgram, treasury } = await solanaSetup();
  const key = treasuryKeypair();
  if (!key.publicKey.equals(treasury)) {
    throw new Error(`That key is for ${key.publicKey.toBase58()}, but TREASURY_WALLET is ${treasury.toBase58()}.`);
  }
  const from = getAssociatedTokenAddressSync(mint, treasury, true, tokenProgram);

  // Each payment is tagged with the prize it pays. One already on the chain was sent by a run that died before
  // recording it: record it now and don't send it again.
  const memoFor = (e: { roundId: string; id: string }) => `pmh:prize:${e.roundId}:${e.id}`;
  const recent = await connection.getSignaturesForAddress(treasury, { limit: 1000 });
  const alreadySent = (e: { roundId: string; id: string }) => recent.find((tx) => !tx.err && tx.memo?.includes(memoFor(e)))?.signature;

  for (const e of payable) {
    const sentBefore = alreadySent(e);
    if (sentBefore) {
      await record(ledger, e, sentBefore);
      console.log(`  ${who(e)} was already paid (${sentBefore}); recorded it`);
      continue;
    }
    const to = new PublicKey(e.wallet!);
    const toAta = getAssociatedTokenAddressSync(mint, to, true, tokenProgram);
    const tx = new Transaction()
      .add(createAssociatedTokenAccountIdempotentInstruction(treasury, toAta, to, mint, tokenProgram))
      .add(createTransferCheckedInstruction(from, mint, toAta, treasury, toRawAmount(e.prize!.tokens, decimals), decimals, [], tokenProgram))
      .add(new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(memoFor(e), "utf8") }));
    let signature: string;
    try {
      signature = await sendAndConfirmTransaction(connection, tx, [key]);
    } catch (err) {
      const sol = (await connection.getBalance(treasury)) / 1e9;
      console.error(`  FAILED to pay ${who(e)} (treasury holds ${sol} SOL for fees): ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
      continue;
    }
    try {
      await record(ledger, e, signature);
      console.log(`  paid ${who(e)}: ${signature}`);
    } catch (err) {
      // Sent, but the game doesn't know. Stop here: the next run finds this payment by its memo and records it.
      console.error(`  PAID ${who(e)} (${signature}) BUT COULD NOT RECORD IT: ${err instanceof Error ? err.message : err}. Stopping.`);
      process.exitCode = 2;
      return;
    }
  }
  const waiting = owed.length - payable.length;
  if (waiting) console.log(`  ${waiting} prize(s) left in their owners' balances: no address given yet`);
}

/** Record a payment that has gone out. The store can be briefly unreachable, and this must not be lost, so it tries a few times. */
async function record(ledger: Ledger, e: { roundId: string; id: string }, signature: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ledger.paid(e, signature);
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
