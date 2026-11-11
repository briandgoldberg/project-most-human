"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, connectWallet, enterPaying, findWallet, saveSession, type HumanSummary, type PaymentRequest } from "@/lib/client";

const field =
  "w-full border border-line bg-panel px-3 py-2.5 text-paper placeholder:text-dim/60 focus:border-pulse focus:outline-none";
const label = "mb-1 block text-[11px] tracking-widest text-dim uppercase";

/** Start a game on the human side: a handle, and, when prizes are paid in real tokens, somewhere to send one. */
export function EnterForm({ summary }: { summary: HumanSummary }) {
  const router = useRouter();
  const [handle, setHandle] = useState("");
  const [wallet, setWallet] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A fee that has been sent but not yet confirmed. Retrying re-checks it instead of charging again.
  const [sent, setSent] = useState<{ payment: PaymentRequest; signature: string } | null>(null);

  const onChain = summary.paymentMode === "solana";
  const hasFee = summary.entryFee > 0;
  const fee = `${summary.entryFee.toLocaleString("en-US")} ${summary.symbol}`;

  async function connect() {
    setError(null);
    const provider = findWallet();
    if (!provider) {
      setError("No Solana wallet found in this browser. Paste an address instead, or install Phantom or Solflare.");
      return;
    }
    try {
      setWallet(await connectWallet(provider));
    } catch {
      setError("The wallet connection was cancelled.");
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    try {
      const session = await enterPaying(api.enter, { handle, wallet: wallet.trim() || undefined }, sent, (stage, sentNow) => {
        setBusy(stage);
        if (sentNow) setSent(sentNow);
      });
      saveSession(session);
      router.push("/play");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(null);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor="handle" className={label}>
          Your handle
        </label>
        <input
          id="handle"
          className={field}
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="what the board will call you"
          maxLength={20}
          autoComplete="off"
          required
        />
      </div>

      {onChain && (
        <div>
          <label htmlFor="wallet" className={label}>
            Solana address {hasFee ? "" : "for your prize (optional)"}
          </label>
          <div className="flex gap-2">
            <input
              id="wallet"
              className={field}
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              placeholder={hasFee ? "connect a wallet to pay the fee" : "where to send it if you win"}
              autoComplete="off"
              spellCheck={false}
              required={hasFee}
            />
            <button type="button" onClick={connect} className="shrink-0 border border-line px-3 hover:border-paper">
              Connect
            </button>
          </div>
          {summary.cluster && summary.cluster !== "mainnet-beta" && (
            <p className="mt-1 text-xs text-dim">Network: {summary.cluster}. This is a test coin with no value.</p>
          )}
        </div>
      )}

      <button
        type="submit"
        disabled={Boolean(busy)}
        className="w-full bg-pulse px-4 py-3 text-ink transition-opacity disabled:opacity-40 sm:w-auto sm:min-w-64"
      >
        {busy ?? (sent ? "Check my payment again" : hasFee ? `Pay ${fee} and play` : "Play")}
      </button>

      {error && (
        <p role="alert" className="text-sm text-pulse">
          {error}
        </p>
      )}

      {sent && !busy && (
        <p className="text-xs text-dim">
          Your payment was sent ({sent.signature.slice(0, 8)}…) and won&rsquo;t be charged again. If it never confirms,
          it didn&rsquo;t go through:{" "}
          <button type="button" onClick={() => setSent(null)} className="underline underline-offset-4">
            start over
          </button>
          .
        </p>
      )}

      <p className="max-w-xl text-xs text-dim">
        While you answer, the game records your keystroke timing, edits, pointer movement, drawing strokes and browser
        details, and the judge uses them along with your answers. By playing you agree these recordings and your answers
        are kept; that your answers may be shown, without your handle, to other players as part of the game; and that
        both may be used or shared for research into telling people from AI. Don&rsquo;t share anything private.
      </p>
    </form>
  );
}
