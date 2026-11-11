"use client";

import { useEffect, useState } from "react";
import { api, type RoundSummary } from "@/lib/client";
import { EnterForm } from "./EnterForm";
import { Shell } from "./Shell";
import { formatCountdown, useNow } from "./useNow";

const REFRESH_MS = 10_000;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 flex-1 border-l border-line pl-3 first:border-l-0 first:pl-0">
      <div className="text-[11px] tracking-widest text-dim uppercase">{label}</div>
      <div className="truncate font-display text-2xl sm:text-3xl">{value}</div>
    </div>
  );
}

function Leaderboard({ round }: { round: RoundSummary }) {
  if (round.leaderboard.length === 0) {
    return <p className="py-6 text-sm text-dim">Nobody has been judged yet today. Go first.</p>;
  }
  return (
    <ol className="divide-y divide-line">
      {round.leaderboard.map((row) => (
        <li key={row.rank} className="flex items-baseline gap-3 py-3">
          <span className="w-6 shrink-0 text-right text-xs text-dim">{row.rank}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="break-all">{row.handle}</span>
              {row.rank === 1 && (
                <span className="text-[11px] tracking-widest text-pulse uppercase">{round.open ? "leading" : "winner"}</span>
              )}
            </div>
            <div className="text-xs text-dim">&ldquo;{row.quip}&rdquo;</div>
          </div>
          <span className="shrink-0 font-display text-xl tabular-nums">{row.score.toFixed(1)}</span>
        </li>
      ))}
    </ol>
  );
}

export function Lobby() {
  const [round, setRound] = useState<RoundSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const now = useNow();

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const next = await api.round();
        if (alive) {
          setRound(next);
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

  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

  return (
    <Shell aside={round ? `Round ${round.roundId}` : undefined}>
      <section className="py-10 sm:py-14">
        <h1 className="font-display text-4xl leading-[1.05] sm:text-6xl">
          Convince the machine
          <br />
          you&rsquo;re a person.
        </h1>
        <p className="mt-5 max-w-xl text-sm text-dim">
          An AI asks you a few questions, some of them about what you just told it, and scores how human you seem. It
          reads your answers, and it watches how you produce them. Bots are playing too. The most human player of the
          day takes the pool.
        </p>
      </section>

      {failed && !round && (
        <p className="border border-line p-4 text-sm">
          Couldn&rsquo;t reach the game server. It will retry on its own.
        </p>
      )}

      {round && (
        <>
          <section className="flex gap-3 border-y border-line py-4">
            <Stat label="Pool" value={`${fmt(round.pool)} ${round.symbol}`} />
            <Stat label="Players" value={String(round.entrants)} />
            <Stat label="Closes in" value={now === null ? "--:--:--" : formatCountdown(round.endsAt - now)} />
          </section>

          <section className="py-8">
            <EnterForm round={round} />
          </section>

          <section>
            <h2 className="border-b border-line pb-2 text-[11px] tracking-widest text-dim uppercase">
              Today&rsquo;s board
            </h2>
            <Leaderboard round={round} />
          </section>

          <section className="mt-10 grid gap-6 border-t border-line pt-6 text-sm text-dim sm:grid-cols-3">
            <div>
              <div className="mb-1 text-paper">1. Enter</div>
              {round.paymentMode === "solana"
                ? `Pay ${fmt(round.entryFee)} ${round.symbol} from a Solana wallet. Every fee goes into today's pool.`
                : `Test mode: entry is ${fmt(round.entryFee)} play tokens and nothing real changes hands.`}
            </div>
            <div>
              <div className="mb-1 text-paper">2. Answer</div>
              {round.questionCount} questions, one at a time, against the clock. Nobody else gets the same ones, and
              some follow up on your own answers, so there&rsquo;s nothing to prepare.
            </div>
            <div>
              <div className="mb-1 text-paper">3. Get judged</div>
              You get a score from 0 to 100. Highest score when the round closes at midnight UTC wins the pool.
            </div>
          </section>
        </>
      )}
    </Shell>
  );
}
