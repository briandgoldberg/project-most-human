import "./env";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../src/lib/config";
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

async function main() {
  const cfg = config();
  const owed = (await prizesOwed(Math.max(1, Number(args.days) || 120))).filter((e) => !args.only || e.id === args.only);
  if (owed.length === 0) {
    console.log("Nothing is owed.");
    return;
  }
  const total = owed.reduce((n, e) => n + e.prize!.tokens, 0);
  console.log(`${owed.length} prize(s) owed, ${total} ${cfg.tokenSymbol} in all:`);
  for (const e of owed) {
    console.log(
      `  ${String(e.prize!.tokens).padStart(8)} ${cfg.tokenSymbol}  ${e.prize!.reason === "hunter" ? "hunter" : "agent "}  ${e.handle.padEnd(20)}  ${e.wallet ?? "(in their balance: no address yet)"}  [${e.id}]`,
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
    for (const e of owed) await markPrizePaid(e);
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
      await record(e, sentBefore);
      console.log(`  ${e.handle} was already paid (${sentBefore}); recorded it`);
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
      console.error(`  FAILED to pay ${e.handle} (treasury holds ${sol} SOL for fees): ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
      continue;
    }
    try {
      await record(e, signature);
      console.log(`  paid ${e.handle}: ${signature}`);
    } catch (err) {
      // Sent, but the game doesn't know. Stop here: the next run finds this payment by its memo and records it.
      console.error(`  PAID ${e.handle} (${signature}) BUT COULD NOT RECORD IT: ${err instanceof Error ? err.message : err}. Stopping.`);
      process.exitCode = 2;
      return;
    }
  }
  const waiting = owed.length - payable.length;
  if (waiting) console.log(`  ${waiting} prize(s) left in their owners' balances: no address given yet`);
}

/** Record a payment that has gone out. The store can be briefly unreachable, and this must not be lost, so it tries a few times. */
async function record(e: { roundId: string; id: string }, signature: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await markPrizePaid(e, signature);
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
