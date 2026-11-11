import "./env";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../src/lib/config";
import { markPrizePaid, prizesOwed } from "../src/lib/game";
import { solanaSetup, toRawAmount } from "../src/lib/payments/solana";

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
 * Before paying an agent's prize, have its builder show you the agent running:
 * a person answering by hand with an agent key doesn't qualify.
 */
const { values: args } = parseArgs({
  options: {
    execute: { type: "boolean", default: false },
    "treasury-key": { type: "string" },
    only: { type: "string" },
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
  const owed = (await prizesOwed()).filter((e) => !args.only || e.id === args.only);
  if (owed.length === 0) {
    console.log("Nothing is owed.");
    return;
  }
  const total = owed.reduce((n, e) => n + e.prize!.tokens, 0);
  console.log(`${owed.length} prize(s) owed, ${total} ${cfg.tokenSymbol} in all:`);
  for (const e of owed) {
    console.log(
      `  ${String(e.prize!.tokens).padStart(8)} ${cfg.tokenSymbol}  ${e.prize!.reason === "hunter" ? "hunter" : "agent "}  ${e.handle.padEnd(20)}  ${e.wallet ?? "(no address given)"}  [${e.id}]`,
    );
  }
  if (!args.execute) {
    console.log("\nDry run. Add --execute to pay.");
    return;
  }

  if (cfg.paymentMode === "mock") {
    for (const e of owed) await markPrizePaid(e);
    console.log("\nMarked as paid (test mode: nothing was transferred).");
    return;
  }

  const { connection, mint, decimals, tokenProgram, treasury } = await solanaSetup();
  const key = treasuryKeypair();
  if (!key.publicKey.equals(treasury)) {
    throw new Error(`That key is for ${key.publicKey.toBase58()}, but TREASURY_WALLET is ${treasury.toBase58()}.`);
  }
  const from = getAssociatedTokenAddressSync(mint, treasury, true, tokenProgram);
  for (const e of owed) {
    if (!e.wallet) {
      console.log(`  skipped ${e.handle}: no address to pay`);
      continue;
    }
    const to = new PublicKey(e.wallet);
    const toAta = getAssociatedTokenAddressSync(mint, to, true, tokenProgram);
    const tx = new Transaction()
      .add(createAssociatedTokenAccountIdempotentInstruction(treasury, toAta, to, mint, tokenProgram))
      .add(createTransferCheckedInstruction(from, mint, toAta, treasury, toRawAmount(e.prize!.tokens, decimals), decimals, [], tokenProgram));
    try {
      const signature = await sendAndConfirmTransaction(connection, tx, [key]);
      await markPrizePaid(e, signature);
      console.log(`  paid ${e.handle}: ${signature}`);
    } catch (err) {
      const sol = (await connection.getBalance(treasury)) / 1e9;
      console.error(`  FAILED to pay ${e.handle} (treasury holds ${sol} SOL for fees): ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
