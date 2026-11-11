"use client";

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

function Board({ summary }: { summary: HumanSummary }) {
  if (summary.board.length === 0) {
    return <p className="py-6 text-sm text-dim">Nobody has finished a game this week. Go first.</p>;
  }
  return (
    <ol className="divide-y divide-line">
      {summary.board.map((row, i) => (
        <li key={i} className="flex items-baseline gap-3 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="break-all">{row.handle}</span>
              {row.won !== undefined && (
                <span className="text-[11px] tracking-widest text-pulse uppercase">
                  won {fmt(row.won)} {summary.symbol}
                </span>
              )}
            </div>
            <div className="text-xs text-dim">&ldquo;{row.quip}&rdquo;</div>
          </div>
          {row.rounds > 0 && (
            <span className="shrink-0 text-xs text-dim">
              round {row.cleared} of {row.rounds}
            </span>
          )}
          <span className="w-12 shrink-0 text-right font-display text-xl tabular-nums" title="How human the judge found them">
            {row.score.toFixed(1)}
          </span>
        </li>
      ))}
    </ol>
  );
}

const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

/** What a player has won and not yet been sent, and where to send it. The address is kept with their account. */
function Balance({ summary, me, onMe }: { summary: HumanSummary; me: Me; onMe: (me: Me) => void }) {
  const [editing, setEditing] = useState(false);
  const [wallet, setWallet] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onChain = summary.paymentMode === "solana";
  if (me.balance <= 0 && !me.wallet) return null;

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
    <div className="border border-line p-4">
      <div className="text-[11px] tracking-widest text-dim uppercase">Your balance</div>
      <div className="font-display text-3xl">
        {fmt(me.balance)} {summary.symbol}
      </div>
      {onChain && me.wallet && !editing && (
        <p className="mt-2 text-sm text-dim">
          {me.balance > 0 ? "It will be sent to" : "Prizes are sent to"} <span className="text-paper">{short(me.wallet)}</span> when
          prizes are next paid out.{" "}
          <button type="button" className="underline underline-offset-4" onClick={() => setEditing(true)}>
            Change address
          </button>
        </p>
      )}
      {onChain && (!me.wallet || editing) && (
        <form onSubmit={save} className="mt-3 space-y-2">
          <label htmlFor="withdraw-to" className="block text-sm text-dim">
            To withdraw, say where to send it. No rush: your balance stays with your account.
          </label>
          <div className="flex gap-2">
            <input
              id="withdraw-to"
              className="w-full border border-line bg-panel px-3 py-2.5 text-paper placeholder:text-dim/60 focus:border-pulse focus:outline-none"
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              placeholder="your Solana address"
              autoComplete="off"
              spellCheck={false}
              required
            />
            <button type="submit" disabled={busy} className="shrink-0 border border-line px-4 hover:border-paper disabled:opacity-40">
              {busy ? "Saving…" : "Withdraw"}
            </button>
          </div>
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
        <p className="max-w-md text-sm text-dim">One Google account, one player. The game keeps a scrambled id for your account, not your email.</p>
        <GoogleSignIn clientId={summary.signIn.clientId} onSignedIn={onMe} />
      </div>
    );
  }

  const account = me.signedIn && (
    <p className="text-xs text-dim">
      Signed in as {me.name}.{" "}
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
      <EnterForm summary={summary} />
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
            <Stat label="Winners this week" value={`${summary.winners} of ${summary.players}`} />
          </section>

          <section className="py-8">
            <Door summary={summary} me={me} onMe={setMe} />
          </section>

          <section>
            <h2 className="border-b border-line pb-2 text-[11px] tracking-widest text-dim uppercase">Recent hunters</h2>
            <Board summary={summary} />
          </section>

          <section className="mt-10 grid gap-6 border-t border-line pt-6 text-sm text-dim sm:grid-cols-3">
            <div>
              <div className="mb-1 text-paper">Be human</div>
              An AI asks you questions and watches how you answer. If it takes you for a bot, you&rsquo;re out.
            </div>
            <div>
              <div className="mb-1 text-paper">Hunt</div>
              Two answers to one question: a person&rsquo;s and a machine&rsquo;s. Pick the person. It gets harder each
              round, and a wrong pick ends the run.
            </div>
            <div>
              <div className="mb-1 text-paper">Win</div>
              {fmt(summary.prizes[0])} {summary.symbol} for proving you&rsquo;re human, more for every round you clear.
              Prizes add up in your balance; withdraw whenever you like.
            </div>
          </section>

          {summary.hunting && (
            <section className="mt-8">
              <h2 className="border-b border-line pb-2 text-[11px] tracking-widest text-dim uppercase">Prizes</h2>
              <ol className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                {summary.prizes.map((tokens, cleared) => (
                  <li key={cleared} className="flex items-baseline gap-2">
                    <span className="text-xs text-dim">{cleared === 0 ? "judged human" : `round ${cleared}`}</span>
                    <span className="tabular-nums">{fmt(tokens)}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <footer className="mt-12 space-y-2 border-t border-line pt-4 text-xs text-dim">
            <p>
              Prizes may change as the site develops.
              {summary.prizesPerPerson > 0 && ` Up to ${summary.prizesPerPerson} prizes a day per person.`} This side is
              for people: automated play and pasted answers end the game, and agents have their own side.
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
