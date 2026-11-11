import "./env";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../src/lib/config";
import { leader, poolTokens, ranked } from "../src/lib/game";
import { solanaSetup, toRawAmount } from "../src/lib/payments/solana";
import { readRound, updateRound } from "../src/lib/store";

/**
 * Settle a round: name the winner and, with --execute, send them the pool.
 *
 *   npm run payout -- --round 2026-11-11                 show what would happen
 *   npm run payout -- --round 2026-11-11 --execute       pay it (asks for the treasury key)
 *
 * The treasury key comes from --treasury-key <keypair.json> or the
 * TREASURY_SECRET_KEY environment variable (base58 or JSON array). It is only
 * ever read by this script, never by the web server.
 */
const { values: args } = parseArgs({
  options: {
    round: { type: "string" },
    execute: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    "treasury-key": { type: "string" },
  },
});

function treasuryKeypair(): Keypair {
  const raw = args["treasury-key"] ? readFileSync(args["treasury-key"], "utf8") : process.env.TREASURY_SECRET_KEY;
  if (!raw) throw new Error("Paying out needs the treasury key: pass --treasury-key <file> or set TREASURY_SECRET_KEY.");
  const trimmed = raw.trim();
  return Keypair.fromSecretKey(trimmed.startsWith("[") ? Uint8Array.from(JSON.parse(trimmed)) : bs58.decode(trimmed));
}

async function main() {
  const cfg = config();
  if (!args.round) throw new Error("Which round? Pass --round YYYY-MM-DD.");
  const state = await readRound(args.round);
  if (!state) throw new Error(`No data for round ${args.round}.`);

  const stillOpen = Date.now() < state.round.endsAt;
  const board = ranked(state);
  const winner = leader(state);
  const pool = poolTokens(state);

  console.log(`Round ${args.round}: ${board.length} scored entries, pool ${pool} ${cfg.tokenSymbol}${stillOpen ? " (round still open)" : ""}`);
  for (const [i, e] of board.slice(0, 5).entries()) {
    console.log(`  ${i + 1}. ${e.result!.score.toFixed(2).padStart(6)}  ${e.handle}`);
  }
  if (state.payout && !state.payout.dryRun) {
    console.log(`\nAlready paid: ${state.payout.amountTokens} ${cfg.tokenSymbol} to ${state.payout.winnerHandle} (${state.payout.signature ?? "no signature"}).`);
    return;
  }
  if (!winner) {
    console.log("\nNo paying player has been scored, so there is nobody to pay.");
    return;
  }
  console.log(`\nWinner: ${winner.handle}${winner.wallet ? ` (${winner.wallet})` : ""} takes ${pool} ${cfg.tokenSymbol}.`);

  if (!args.execute) {
    console.log("Dry run. Add --execute to settle the round.");
    return;
  }
  if (stillOpen && !args.force) throw new Error("This round is still open. Wait for it to close, or pass --force.");

  let signature: string | undefined;
  if (cfg.paymentMode === "solana") {
    if (!winner.wallet) throw new Error("The winner has no wallet on record.");
    if (pool <= 0) throw new Error("The pool is empty.");
    const { connection, mint, decimals, tokenProgram, treasury } = await solanaSetup();
    const key = treasuryKeypair();
    if (!key.publicKey.equals(treasury)) {
      throw new Error(`That key is for ${key.publicKey.toBase58()}, but TREASURY_WALLET is ${treasury.toBase58()}.`);
    }
    const to = new PublicKey(winner.wallet);
    const fromAta = getAssociatedTokenAddressSync(mint, treasury, true, tokenProgram);
    const toAta = getAssociatedTokenAddressSync(mint, to, true, tokenProgram);
    const tx = new Transaction()
      .add(createAssociatedTokenAccountIdempotentInstruction(treasury, toAta, to, mint, tokenProgram))
      .add(createTransferCheckedInstruction(fromAta, mint, toAta, treasury, toRawAmount(pool, decimals), decimals, [], tokenProgram));
    try {
      signature = await sendAndConfirmTransaction(connection, tx, [key]);
    } catch (err) {
      const sol = (await connection.getBalance(treasury)) / 1e9;
      throw new Error(`Payout transaction failed (treasury holds ${sol} SOL for fees): ${err instanceof Error ? err.message : err}`);
    }
    console.log(`Sent. Signature: ${signature}`);
  }

  await updateRound(args.round, (s) => {
    s.payout = {
      winnerEntryId: winner.id,
      winnerHandle: winner.handle,
      winnerWallet: winner.wallet,
      amountTokens: pool,
      signature,
      settledAt: Date.now(),
      dryRun: false,
    };
  });
  console.log(`Round ${args.round} settled${cfg.paymentMode === "mock" ? " (test mode: nothing was transferred)" : ""}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
