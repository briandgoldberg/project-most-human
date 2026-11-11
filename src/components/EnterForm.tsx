"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  ApiError,
  api,
  connectWallet,
  findWallet,
  payEntryFee,
  saveSession,
  type PaymentRequest,
  type RoundSummary,
} from "@/lib/client";

const field =
  "w-full border border-line bg-panel px-3 py-2.5 text-paper placeholder:text-dim/60 focus:border-pulse focus:outline-none";

/** The public entry form for the daily competition: a handle and, when fees are live, a wallet. */
export function EnterForm({ round }: { round: RoundSummary }) {
  const router = useRouter();
  const [handle, setHandle] = useState("");
  const [wallet, setWallet] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A fee that has been sent but not yet confirmed. Retrying re-checks it instead of charging again.
  const [sent, setSent] = useState<{ payment: PaymentRequest; signature: string } | null>(null);

  const needsWallet = round.paymentMode === "solana";
  const fee = `${round.entryFee.toLocaleString("en-US")} ${round.symbol}`;

  async function connect() {
    setError(null);
    const provider = findWallet();
    if (!provider) {
      setError("No Solana wallet found in this browser. Install Phantom or Solflare, then reload.");
      return;
    }
    try {
      setWallet(await connectWallet(provider));
    } catch {
      setError("The wallet connection was cancelled.");
    }
  }

  const confirmPaid = (body: Record<string, unknown>, payment: PaymentRequest, signature: string) =>
    api.enter({ ...body, roundId: payment.roundId, intentId: payment.intentId, signature });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const body = { handle, wallet: wallet ?? undefined };
    try {
      let session;
      if (sent) {
        setBusy("Checking your payment…");
        session = await confirmPaid(body, sent.payment, sent.signature);
      } else {
        setBusy("Entering…");
        try {
          session = await api.enter(body);
        } catch (err) {
          // 402 with a transaction attached means: pay the fee, then come back with the signature.
          if (!(err instanceof ApiError) || err.code !== "payment_required") throw err;
          const payment = err.body.payment as PaymentRequest;
          const provider = findWallet();
          if (!provider) throw new Error("Wallet disconnected. Reconnect and try again.");
          setBusy(`Approve ${fee} in your wallet…`);
          const signature = await payEntryFee(provider, payment);
          setSent({ payment, signature });
          setBusy("Waiting for the payment to confirm…");
          session = await confirmPaid(body, payment, signature);
        }
      }
      saveSession(session);
      router.push("/play");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(null);
    }
  }

  if (!round.open) {
    return <p className="border border-line p-4 text-sm">This round has closed. The next one opens at midnight UTC.</p>;
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor="handle" className="mb-1 block text-[11px] tracking-widest text-dim uppercase">
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

      {needsWallet && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button type="button" onClick={connect} className="border border-line px-3 py-2 hover:border-paper">
            {wallet ? "Wallet connected" : "Connect wallet"}
          </button>
          {wallet && <span className="text-dim">{`${wallet.slice(0, 4)}…${wallet.slice(-4)}`}</span>}
          {round.cluster && round.cluster !== "mainnet-beta" && (
            <span className="text-xs text-dim">Network: {round.cluster}. Set your wallet to match.</span>
          )}
        </div>
      )}

      <button
        type="submit"
        disabled={Boolean(busy) || (needsWallet && !wallet)}
        className="w-full bg-pulse px-4 py-3 text-ink transition-opacity disabled:opacity-40 sm:w-auto sm:min-w-64"
      >
        {busy ?? (sent ? "Check my payment again" : needsWallet ? `Pay ${fee} and play` : `Play (${fee})`)}
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
        are kept and may be used or shared, without your handle or wallet, for research into telling people from AI.
        Don&rsquo;t share anything private.
      </p>
    </form>
  );
}
