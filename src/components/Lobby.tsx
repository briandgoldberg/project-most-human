"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type HumanSummary } from "@/lib/client";
import { EnterForm } from "./EnterForm";
import { Shell } from "./Shell";

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

export function Lobby() {
  const [summary, setSummary] = useState<HumanSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const next = await api.summary();
        if (alive) {
          setSummary(next);
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
    <Shell aside="For humans">
      <section className="py-10 sm:py-14">
        <h1 className="font-display text-4xl leading-[1.05] sm:text-6xl">
          Prove you&rsquo;re a person.
          <br />
          Then hunt the bots.
        </h1>
        <p className="mt-5 max-w-xl text-sm text-dim">
          An AI asks you a few questions and decides whether you&rsquo;re human. In between, you do its job: two answers
          to the same question, one from a real person and one from a machine. Pick the person. It gets harder every
          round.
        </p>
      </section>

      {failed && !summary && <p className="border border-line p-4 text-sm">Couldn&rsquo;t reach the game server. It will retry on its own.</p>}

      {summary && (
        <>
          <section className="flex gap-3 border-y border-line py-4">
            <Stat label="Hunter prize" value={`${fmt(summary.prize)} ${summary.symbol}`} />
            <Stat label="Reach round" value={summary.hunting ? String(summary.prizeRound) : "soon"} />
            <Stat label="Winners this week" value={`${summary.winners} of ${summary.players}`} />
          </section>

          <section className="py-8">
            <EnterForm summary={summary} />
          </section>

          <section>
            <h2 className="border-b border-line pb-2 text-[11px] tracking-widest text-dim uppercase">Recent hunters</h2>
            <Board summary={summary} />
          </section>

          <section className="mt-10 grid gap-6 border-t border-line pt-6 text-sm text-dim sm:grid-cols-3">
            <div>
              <div className="mb-1 text-paper">1. Be human</div>
              {summary.questionCount} questions, written for you as you go, some about what you just said. If the judge
              takes you for a bot, your game is cancelled.
            </div>
            <div>
              <div className="mb-1 text-paper">2. Hunt</div>
              {summary.hunting
                ? `Up to ${summary.huntRounds} rounds between the questions. Each machine answer is harder to spot than the last. One wrong pick ends your climb.`
                : "Hunting rounds start once enough people have played to hunt with. Until then, it's the questions alone."}
            </div>
            <div>
              <div className="mb-1 text-paper">3. Win</div>
              Clear round {summary.prizeRound} and the judge still believes you&rsquo;re human: {fmt(summary.prize)}{" "}
              {summary.symbol}. Your own answers become what other players hunt with.
            </div>
          </section>

          <p className="mt-8 text-xs text-dim">
            Prizes may change as the site develops.{" "}
            <Link href="/agents" className="text-paper underline underline-offset-4">
              Building an agent? There&rsquo;s a prize for fooling the judge
            </Link>
            .
          </p>
        </>
      )}
    </Shell>
  );
}
