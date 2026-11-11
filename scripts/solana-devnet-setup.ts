import "./env";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

/**
 * Set up a free rehearsal of the real-money flow on Solana devnet:
 * a throwaway token standing in for the meme coin, a treasury wallet, and a
 * few funded player wallets. Safe to re-run; it picks up where it left off.
 *
 *   npm run solana:setup
 *   npm run solana:setup -- --players 5 --tokens 50000
 *
 * Everything is written to .solana-dev/ (git-ignored). These keys are for
 * devnet only. Never reuse them on mainnet.
 */
const { values: args } = parseArgs({
  options: {
    players: { type: "string", default: "3" },
    tokens: { type: "string", default: "100000" },
    decimals: { type: "string", default: "6" },
    rpc: { type: "string", default: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com" },
    dir: { type: "string", default: ".solana-dev" },
  },
});

const dir = args.dir!;
const SOL_PER_PLAYER = 0.02;

function keypair(file: string): Keypair {
  const full = path.join(dir, file);
  if (existsSync(full)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(full, "utf8"))));
  const kp = Keypair.generate();
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
  return kp;
}

async function main() {
  if (!/devnet|testnet|localhost|127\.0\.0\.1/.test(args.rpc!)) {
    throw new Error(`Refusing to run against ${args.rpc}: this script creates throwaway keys and is for devnet only.`);
  }
  const connection = new Connection(args.rpc!, "confirmed");
  const playerCount = Math.max(1, Number(args.players));
  const decimals = Number(args.decimals);

  const payer = keypair("payer.json");
  const treasury = keypair("treasury.json");
  const players = Array.from({ length: playerCount }, (_, i) => keypair(`players/player-${i + 1}.json`));

  // The payer covers every fee below and is the token's mint authority.
  const needed = (playerCount * SOL_PER_PLAYER + 0.1) * LAMPORTS_PER_SOL;
  let balance = await connection.getBalance(payer.publicKey);
  if (balance < needed) {
    // Works on a local test validator. Public devnet has closed its RPC faucet, so there this falls through.
    try {
      const sig = await connection.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) }, "confirmed");
      balance = await connection.getBalance(payer.publicKey);
    } catch {
      // Fall through to the manual instructions.
    }
  }
  if (balance < needed) {
    console.log(
      `\nThe payer wallet needs about ${(needed / LAMPORTS_PER_SOL).toFixed(2)} devnet SOL and has ${(balance / LAMPORTS_PER_SOL).toFixed(3)}.\n` +
        `Devnet no longer hands out SOL over RPC, so fund it by hand (free), then run this again:\n\n` +
        `  1. Open https://faucet.solana.com\n  2. Choose devnet and paste: ${payer.publicKey.toBase58()}\n`,
    );
    process.exitCode = 1;
    return;
  }

  // The stand-in token.
  const mintFile = path.join(dir, "mint.txt");
  let mint: PublicKey;
  if (existsSync(mintFile)) {
    mint = new PublicKey(readFileSync(mintFile, "utf8").trim());
  } else {
    mint = await createMint(connection, payer, payer.publicKey, null, decimals);
    writeFileSync(mintFile, mint.toBase58());
    console.log(`Created test token ${mint.toBase58()} (${decimals} decimals)`);
  }

  // Give each player a little SOL for fees and a stack of tokens.
  const perPlayerRaw = BigInt(args.tokens!) * BigInt(10) ** BigInt(decimals);
  for (const [i, player] of players.entries()) {
    if ((await connection.getBalance(player.publicKey)) < (SOL_PER_PLAYER / 2) * LAMPORTS_PER_SOL) {
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: player.publicKey, lamports: SOL_PER_PLAYER * LAMPORTS_PER_SOL }),
      );
      await sendAndConfirmTransaction(connection, tx, [payer]);
    }
    const account = await getOrCreateAssociatedTokenAccount(connection, payer, mint, player.publicKey);
    if (account.amount < perPlayerRaw) {
      await mintTo(connection, payer, mint, account.address, payer, perPlayerRaw - account.amount);
    }
    console.log(`player-${i + 1}  ${player.publicKey.toBase58()}  funded with ${args.tokens} tokens`);
  }

  console.log(`
Done. Put this in .env.local and restart the server:

PAYMENT_MODE=solana
SOLANA_CLUSTER=devnet
TOKEN_MINT=${mint.toBase58()}
TOKEN_SYMBOL=TEST
TREASURY_WALLET=${treasury.publicKey.toBase58()}
ENTRY_FEE_TOKENS=1000

Then:
  npm run bots -- --paying --wallets ${dir}/players     paying players, signed with the test wallets
  npm run payout -- --round <date> --treasury-key ${dir}/treasury.json --execute

To play in a browser instead, import a player key from ${dir}/players/ into Phantom and switch Phantom to devnet.
The treasury needs a little SOL to pay out; the payout command tells you if it is short.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
