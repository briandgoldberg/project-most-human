"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, connectWallet, enterPaying, findWallet, saveSession, type HumanSummary, type PaymentRequest } from "@/lib/client";

const field =
  "w-full border border-line bg-panel px-3 py-2.5 text-paper placeholder:text-dim/60 focus:border-pulse focus:outline-none";
const label = "mb-1 block text-[11px] tracking-widest text-dim uppercase";

/**
 * Start a game on the human side. A returning player, or one whose first name
 * will do, just presses Play; the handle is a small thing they can change.
 * A wallet comes into it only if there is a fee to pay.
 */
export function EnterForm({ summary, known }: { summary: HumanSummary; known?: string }) {
  const router = useRouter();
  const [handle, setHandle] = useState(known ?? "");
  // Asked for only when there is nothing to call them yet, or they want a different one.
  const [choosing, setChoosing] = useState(!known);
  const [wallet, setWallet] = useState("");
  // Not shown to people. A script filling in every field fills this one too.
  const [website, setWebsite] = useState("");
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
      const session = await enterPaying(api.enter, { handle, wallet: wallet.trim() || undefined, website: website || undefined }, sent, (stage, sentNow) => {
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
      {choosing ? (
        <div className="flex items-baseline gap-3 text-sm">
          <label htmlFor="handle" className="shrink-0 text-dim">
            Play as
          </label>
          <input
            id="handle"
            className="w-48 border-b border-line bg-transparent py-1 text-paper placeholder:text-dim/60 focus:border-pulse focus:outline-none"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="your handle"
            maxLength={20}
            autoComplete="off"
            required
          />
        </div>
      ) : (
        <p className="text-sm text-dim">
          Playing as <span className="text-paper">{handle}</span>{" "}
          <button type="button" onClick={() => setChoosing(true)} className="text-xs underline underline-offset-4">
            change
          </button>
        </p>
      )}

      <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </div>

      {onChain && hasFee && (
        <div>
          <label htmlFor="wallet" className={label}>
            Solana address
          </label>
          <div className="flex gap-2">
            <input
              id="wallet"
              className={field}
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              placeholder="connect a wallet to pay the fee"
              autoComplete="off"
              spellCheck={false}
              required
            />
            <button type="button" onClick={connect} className="shrink-0 border border-line px-3 hover:border-paper">
              Connect
            </button>
          </div>
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

    </form>
  );
}
