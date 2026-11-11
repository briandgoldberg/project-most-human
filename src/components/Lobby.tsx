"use client";

import { useEffect, useState } from "react";
import { api, type HumanSummary } from "@/lib/client";
import { EnterForm } from "./EnterForm";
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
    <Shell>
      <SideToggle side="human" />
      <section className="py-8 sm:py-10">
        <h1 className="font-display text-5xl leading-[1.05] sm:text-7xl">Can you spot the bot?</h1>
        <p className="mt-4 text-[13px] text-dim sm:text-sm sm:whitespace-nowrap">
          Prove you&rsquo;re human. Then pick the real person. One mistake and you&rsquo;re out.
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
            <EnterForm summary={summary} />
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
              round, and one wrong pick ends your game.
            </div>
            <div>
              <div className="mb-1 text-paper">Win</div>
              {fmt(summary.prizes[0])} {summary.symbol} for proving you&rsquo;re human. More for every round you clear,
              and you say what gave the machine away.
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
