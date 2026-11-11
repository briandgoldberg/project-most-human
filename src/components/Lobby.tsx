"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { api, type HumanSummary, type Me } from "@/lib/client";
import { EnterForm } from "./EnterForm";
import { GoogleSignIn } from "./GoogleSignIn";
import { Shell } from "./Shell";
import { SideToggle } from "./SideToggle";

const REFRESH_MS = 15_000;
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 flex-1 border-l border-line pl-3 first:border-l-0 first:pl-0">
      <div className="text-[11px] tracking-widest text-dim uppercase">{label}</div>
      <div className="truncate font-display text-2xl sm:text-3xl">{value}</div>
    </div>
  );
}

/** The latest few games, a line each. */
const BOARD_ROWS = 5;

function Board({ summary }: { summary: HumanSummary }) {
  if (summary.board.length === 0) {
    return <p className="py-4 text-sm text-dim">Nobody has finished a game this week. Go first.</p>;
  }
  return (
    <ol className="divide-y divide-line">
      {summary.board.slice(0, BOARD_ROWS).map((row, i) => (
        <li key={i} className="flex items-baseline gap-3 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate">{row.handle}</span>
          <span className={`shrink-0 tabular-nums ${row.won ? "text-pulse" : "text-dim"}`}>
            {row.won ? `${fmt(row.won)} ${summary.symbol}` : "no prize"}
          </span>
        </li>
      ))}
    </ol>
  );
}

const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

/**
 * What a player has won and not yet been sent, and where to send it. Always
 * there once they are in, so they know where to withdraw before they have won
 * anything. The address is kept with their account.
 */
function Balance({ summary, me, onMe }: { summary: HumanSummary; me: Me; onMe: (me: Me) => void }) {
  const [editing, setEditing] = useState(false);
  const [wallet, setWallet] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onChain = summary.paymentMode === "solana";

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onMe(await api.saveWallet(wallet));
      setEditing(false);
      setWallet("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 text-sm">
      <p className="text-dim">
        Balance{" "}
        <span className="text-paper tabular-nums">
          {fmt(me.balance)} {summary.symbol}
        </span>
        {onChain && me.wallet && (
          <>
            {" "}
            · goes to <span className="text-paper">{short(me.wallet)}</span> at the next payout
          </>
        )}
        {onChain && !editing && (
          <>
            {" "}
            <button type="button" className="text-xs underline underline-offset-4" onClick={() => setEditing(true)}>
              {me.wallet ? "change address" : "withdraw"}
            </button>
          </>
        )}
      </p>
      {onChain && editing && (
        <form onSubmit={save} className="space-y-2">
          <div className="flex max-w-xl gap-2">
            <input
              id="withdraw-to"
              aria-label="Solana address to withdraw to"
              className="w-full border border-line bg-panel px-3 py-2 text-paper placeholder:text-dim/60 focus:border-pulse focus:outline-none"
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              placeholder="Solana address to send your balance to"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              required
            />
            <button type="submit" disabled={busy} className="shrink-0 border border-line px-4 hover:border-paper disabled:opacity-40">
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" className="shrink-0 px-1 text-xs text-dim underline underline-offset-4" onClick={() => setEditing(false)}>
              cancel
            </button>
          </div>
          <p className="text-xs text-dim">Saved with your account. Your balance, and anything you win later, is sent there at the next payout.</p>
          {error && (
            <p role="alert" className="text-sm text-pulse">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

/** The way into a game: sign in if the site asks for it, then the form, unless there is nothing new to show this player. */
function Door({ summary, me, onMe }: { summary: HumanSummary; me: Me | null; onMe: (me: Me | null) => void }) {
  if (!me) return <p className="text-sm text-dim">One moment…</p>;

  if (summary.signIn.required && !me.signedIn) {
    return (
      <div className="space-y-3">
        <h2 className="font-display text-2xl">Sign in to play</h2>
        <GoogleSignIn clientId={summary.signIn.clientId} onSignedIn={onMe} />
      </div>
    );
  }

  const account = me.signedIn && (
    <p className="text-xs text-dim">
      <button
        type="button"
        className="underline underline-offset-4"
        onClick={async () => {
          await api.signOut().catch(() => undefined);
          onMe(await api.me().catch(() => null));
        }}
      >
        Sign out
      </button>
    </p>
  );

  if (!me.canPlay) {
    return (
      <div className="space-y-3">
        <div className="border border-line p-4">
          <h2 className="font-display text-2xl">You&rsquo;ve seen nearly everyone</h2>
          <p className="mt-2 max-w-md text-sm text-dim">
            You&rsquo;ve judged almost every real answer we have. Come back once more people have played and there will
            be new ones to hunt.
          </p>
        </div>
        <Balance summary={summary} me={me} onMe={onMe} />
        {account}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <EnterForm summary={summary} known={me.handle} />
      <Balance summary={summary} me={me} onMe={onMe} />
      {account}
    </div>
  );
}

export function Lobby() {
  const [summary, setSummary] = useState<HumanSummary | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [next, who] = await Promise.all([api.summary(), api.me()]);
        if (alive) {
          setSummary(next);
          setMe(who);
          setFailed(false);
        }
      } catch {
        if (alive) setFailed(true);
      }
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <Shell>
      <SideToggle side="human" />
      <section className="py-8 sm:py-10">
        <h1 className="font-display text-5xl leading-[1.05] sm:text-7xl">Can you spot the bot?</h1>
        <p className="mt-4 text-[13px] text-dim sm:text-sm sm:whitespace-nowrap">
          Prove you&rsquo;re human. Then spot the bots. The further you get, the more you win.
        </p>
      </section>

      {failed && !summary && <p className="border border-line p-4 text-sm">Couldn&rsquo;t reach the game server. It will retry on its own.</p>}

      {summary && (
        <>
          <section className="flex gap-3 border-y border-line py-4">
            <Stat label="Prizes from" value={`${fmt(summary.prizes[0])} ${summary.symbol}`} />
            <Stat label="Up to" value={`${fmt(summary.prizes[summary.hunting ? summary.prizes.length - 1 : 0])} ${summary.symbol}`} />
            <Stat label="Winners this week" value={fmt(summary.winners)} />
          </section>

          <section className="py-8">
            <Door summary={summary} me={me} onMe={setMe} />
          </section>

          <section className="grid gap-x-6 gap-y-3 border-t border-line pt-5 text-sm text-dim sm:grid-cols-3">
            <p>
              <span className="text-paper">Be human.</span> Answer a few questions for the AI judge.
            </p>
            <p>
              <span className="text-paper">Hunt.</span> Pick the person&rsquo;s answer, not the machine&rsquo;s.
            </p>
            <p>
              <span className="text-paper">Win.</span>{" "}
              {summary.hunting ? `More ${summary.symbol} for every round you clear.` : `${fmt(summary.prizes[0])} ${summary.symbol} for proving it.`}
            </p>
          </section>

          <section className="mt-8">
            <h2 className="border-b border-line pb-2 text-[11px] tracking-widest text-dim uppercase">Recent hunters</h2>
            <Board summary={summary} />
          </section>

          <footer className="mt-12 space-y-2 border-t border-line pt-4 text-xs text-dim">
            <p>
              Humans only on this side. Using a bot or pasting an answer ends your game. Bots play on the{" "}
              <Link href="/agents" className="underline underline-offset-4">
                agent side
              </Link>
              .
            </p>
            <p>
              Prizes may change as the site develops.
              {summary.prizesPerPerson > 0 && ` Up to ${summary.prizesPerPerson} prizes a day per person.`}
            </p>
            {summary.paymentMode === "solana" && summary.cluster !== "mainnet-beta" && (
              <p>
                {summary.symbol} is a test coin on Solana {summary.cluster} and has no value.
              </p>
            )}
            <p>
              {summary.signIn.required &&
                "Signing in with Google is only to tell one player from another: the game keeps a scrambled id for your account, not your name or email. "}
              {summary.paymentMode === "solana" && "A Solana address you give to withdraw is kept with your account. "}
              While you play, the game records your keystroke timing, edits, pointer movement, drawing strokes and
              browser details, and the judge uses them along with your answers. By playing you agree these recordings
              and your answers are kept; that your answers and a summary of how you typed them may be shown, without
              your handle, to other players as part of the game; and that both may be used or shared for research into
              telling people from AI. Don&rsquo;t share anything private.
            </p>
          </footer>
        </>
      )}
    </Shell>
  );
}
