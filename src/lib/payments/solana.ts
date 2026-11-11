import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { config } from "../config";

/**
 * Entry fees are paid in one SPL token, set by TOKEN_MINT. Nothing else here
 * is specific to a coin: switching to a different token (or from devnet to
 * mainnet) is a change of environment variables.
 *
 * The server builds the transfer, the player's wallet signs and sends it, and
 * the server then checks the confirmed transaction on-chain before admitting
 * the player. The check looks at the treasury's balance change, so it holds
 * for both the classic token program and Token-2022.
 */

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export interface SolanaSetup {
  connection: Connection;
  mint: PublicKey;
  treasury: PublicKey;
  decimals: number;
  tokenProgram: PublicKey;
}

let cached: { key: string; setup: Promise<SolanaSetup> } | undefined;

export function solanaSetup(): Promise<SolanaSetup> {
  const { rpcUrl, mint, treasury } = config().solana;
  if (!mint || !treasury) {
    throw new Error("PAYMENT_MODE=solana needs TOKEN_MINT and TREASURY_WALLET to be set");
  }
  const key = `${rpcUrl}|${mint}|${treasury}`;
  if (cached?.key !== key) {
    const load = async (): Promise<SolanaSetup> => {
      const connection = new Connection(rpcUrl, "confirmed");
      const mintKey = new PublicKey(mint);
      const info = await connection.getAccountInfo(mintKey);
      if (!info) throw new Error(`TOKEN_MINT ${mint} does not exist on ${config().solana.cluster}`);
      const tokenProgram = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      if (!info.owner.equals(tokenProgram)) throw new Error(`TOKEN_MINT ${mint} is not an SPL token mint`);
      const { decimals } = await getMint(connection, mintKey, "confirmed", tokenProgram);
      return { connection, mint: mintKey, treasury: new PublicKey(treasury), decimals, tokenProgram };
    };
    const setup = load();
    cached = { key, setup };
    // Don't cache a failure (e.g. the RPC was briefly unreachable).
    setup.catch(() => {
      if (cached?.key === key) cached = undefined;
    });
  }
  return cached.setup;
}

/** Whole tokens -> base units, exactly. */
export function toRawAmount(tokens: number, decimals: number): bigint {
  const [whole, frac = ""] = tokens.toFixed(decimals).split(".");
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

export function fromRawAmount(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/**
 * Build the unsigned entry-fee transaction for a player: create the treasury's
 * token account if it doesn't exist yet, transfer the fee, and tag it with the
 * intent's memo so this payment can only be redeemed for this entry.
 */
export async function buildEntryTransaction(wallet: string, memo: string, amountRaw: bigint): Promise<string> {
  const { connection, mint, treasury, decimals, tokenProgram } = await solanaSetup();
  const payer = new PublicKey(wallet);
  const from = getAssociatedTokenAddressSync(mint, payer, true, tokenProgram);
  const to = getAssociatedTokenAddressSync(mint, treasury, true, tokenProgram);

  const tx = new Transaction();
  tx.add(createAssociatedTokenAccountIdempotentInstruction(payer, to, treasury, mint, tokenProgram));
  tx.add(createTransferCheckedInstruction(from, mint, to, payer, amountRaw, decimals, [], tokenProgram));
  tx.add(new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(memo, "utf8") }));
  tx.feePayer = payer;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** The parts of a parsed transaction the check relies on. */
export interface ParsedTxLike {
  blockTime?: number | null;
  meta: {
    err: unknown;
    logMessages?: string[] | null;
    preTokenBalances?: TokenBalanceLike[] | null;
    postTokenBalances?: TokenBalanceLike[] | null;
  } | null;
  transaction: {
    message: {
      accountKeys: { pubkey: { toBase58(): string }; signer: boolean }[];
      instructions: { programId: { toBase58(): string }; parsed?: unknown }[];
    };
  };
}

interface TokenBalanceLike {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

export interface PaymentExpectation {
  wallet: string;
  treasury: string;
  mint: string;
  memo: string;
  amountRaw: bigint;
  /** Reject transactions older than this (unix seconds). */
  notBefore: number;
}

export type PaymentCheck = { ok: true; receivedRaw: bigint } | { ok: false; reason: string };

function ownedBalance(balances: TokenBalanceLike[] | null | undefined, owner: string, mint: string): bigint {
  return (balances ?? [])
    .filter((b) => b.owner === owner && b.mint === mint)
    .reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), BigInt(0));
}

/** Decide whether a confirmed transaction is the payment we asked for. */
export function checkPayment(tx: ParsedTxLike, expect: PaymentExpectation): PaymentCheck {
  if (!tx.meta) return { ok: false, reason: "Transaction has no metadata" };
  if (tx.meta.err) return { ok: false, reason: "Transaction failed on-chain" };
  if (tx.blockTime && tx.blockTime < expect.notBefore) {
    return { ok: false, reason: "Transaction is older than this entry request" };
  }

  const signed = tx.transaction.message.accountKeys.some((k) => k.signer && k.pubkey.toBase58() === expect.wallet);
  if (!signed) return { ok: false, reason: "Transaction was not signed by the entering wallet" };

  const memoId = MEMO_PROGRAM_ID.toBase58();
  const hasMemo = tx.transaction.message.instructions.some(
    (ix) => ix.programId.toBase58() === memoId && ix.parsed === expect.memo,
  );
  if (!hasMemo) return { ok: false, reason: "Transaction does not carry this entry's memo" };

  const received =
    ownedBalance(tx.meta.postTokenBalances, expect.treasury, expect.mint) -
    ownedBalance(tx.meta.preTokenBalances, expect.treasury, expect.mint);
  if (received < expect.amountRaw) {
    return { ok: false, reason: `Treasury received ${received} base units, entry fee is ${expect.amountRaw}` };
  }
  return { ok: true, receivedRaw: received };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for the transaction to confirm (up to `timeoutMs`), then check it. */
export async function verifyEntryPayment(
  signature: string,
  expect: Omit<PaymentExpectation, "treasury" | "mint">,
  timeoutMs = 45_000,
): Promise<PaymentCheck> {
  const { connection, mint, treasury } = await solanaSetup();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let tx: ParsedTxLike | null = null;
    try {
      tx = await connection.getParsedTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
    } catch (err) {
      // A malformed signature is the caller's mistake; anything else may be transient.
      if (/invalid|WrongSize|base58/i.test(String(err))) return { ok: false, reason: "Not a valid transaction signature" };
      // Entry payments are built by this server in a format it can read. One it can't read is someone else's transaction.
      if (/Transaction version/i.test(String(err))) return { ok: false, reason: "That transaction is not an entry payment" };
      if (Date.now() >= deadline) throw err;
    }
    if (tx) return checkPayment(tx, { ...expect, treasury: treasury.toBase58(), mint: mint.toBase58() });
    if (Date.now() >= deadline) {
      return { ok: false, reason: "Transaction not confirmed yet. Wait a few seconds and try again." };
    }
    await sleep(2000);
  }
}
