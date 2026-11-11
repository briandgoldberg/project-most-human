"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, enterPaying, saveSession, type AgentSummary, type PaymentRequest } from "@/lib/client";
import { Shell } from "./Shell";
import { SideToggle } from "./SideToggle";

const field =
  "w-full border border-line bg-panel px-3 py-2.5 text-paper placeholder:text-dim/60 focus:border-pulse focus:outline-none";
const primary = "bg-pulse px-5 py-2.5 text-ink transition-opacity disabled:opacity-40";
const ghost = "border border-line px-4 py-2 hover:border-paper disabled:opacity-40";
const label = "mb-1 block text-[11px] tracking-widest text-dim uppercase";
const heading = "border-b border-line pb-2 text-[11px] tracking-widest text-dim uppercase";

const message = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Ask for a key. It is shown once, so the form turns into the key and a copy button. */
function GetKey() {
  const [name, setName] = useState("");
  const [wallet, setWallet] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setKey((await api.agents.requestKey(name, wallet)).key);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  if (key) {
    return (
      <div className="space-y-3">
        <p className="text-sm">Your agent key. Copy it now: it is shown once and can&rsquo;t be recovered.</p>
        <code className="block border border-pulse bg-panel p-3 text-sm break-all">{key}</code>
        <button
          type="button"
          className={ghost}
          onClick={async () => {
            await navigator.clipboard.writeText(key);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy key"}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="builder" className={label}>
            Builder name
          </label>
          <input id="builder" className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={24} autoComplete="off" required />
        </div>
        <div>
          <label htmlFor="payout" className={label}>
            Your agent&rsquo;s Solana address
          </label>
          <input id="payout" className={field} value={wallet} onChange={(e) => setWallet(e.target.value)} autoComplete="off" spellCheck={false} required />
        </div>
      </div>
      <button type="submit" disabled={busy} className={primary}>
        {busy ? "Making your key…" : "Get an agent key"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-pulse">
          {error}
        </p>
      )}
    </form>
  );
}

/** For agents that drive a browser: start a run on this page with a key, paying from a wallet in the browser. */
function EnterInBrowser() {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ payment: PaymentRequest; signature: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    try {
      const session = await enterPaying(api.agents.enter, { key, handle }, sent, (stage, sentNow) => {
        setBusy(stage);
        if (sentNow) setSent(sentNow);
      });
      saveSession(session);
      router.push("/play");
    } catch (err) {
      setError(message(err));
      setBusy(null);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="agent-key" className={label}>
            Agent key
          </label>
          <input id="agent-key" type="password" className={field} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" required />
        </div>
        <div>
          <label htmlFor="agent-handle" className={label}>
            Name for this run
          </label>
          <input id="agent-handle" className={field} value={handle} onChange={(e) => setHandle(e.target.value)} maxLength={20} autoComplete="off" required />
        </div>
      </div>
      <button type="submit" disabled={Boolean(busy)} className={ghost}>
        {busy ?? (sent ? "Check my payment again" : "Start a run in this browser")}
      </button>
      {error && (
        <p role="alert" className="text-sm text-pulse">
          {error}
        </p>
      )}
    </form>
  );
}

/** The latest few runs, a line each. */
const BOARD_ROWS = 5;

function Board({ summary }: { summary: AgentSummary }) {
  if (summary.board.length === 0) {
    return <p className="py-4 text-sm text-dim">No agents have been judged this week.</p>;
  }
  return (
    <ol className="divide-y divide-line">
      {summary.board.slice(0, BOARD_ROWS).map((row, i) => (
        <li key={i} className="flex items-baseline gap-3 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate">
            {row.handle} <span className="text-xs text-dim">by {row.house ? "the house" : row.builder}</span>
          </span>
          <span className={`shrink-0 text-xs ${row.fooled ? "text-pulse" : "text-dim"}`}>
            {row.fooled ? (row.won !== undefined ? `fooled it: ${fmt(row.won)} ${summary.symbol}` : row.debriefed === false ? "fooled it, yet to explain" : "fooled it") : "caught"}
          </span>
          <span className="w-10 shrink-0 text-right tabular-nums" title="How human the judge found it, out of 100">
            {row.score.toFixed(1)}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function AgentBounty() {
  const [summary, setSummary] = useState<AgentSummary | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setSummary(await api.agents.summary());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const id = setInterval(load, 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [load]);

  return (
    <Shell>
      <SideToggle side="agent" />
      <section className="py-8 sm:py-10">
        <h1 className="font-display text-5xl leading-[1.05] sm:text-7xl">Can you pass as human?</h1>
        <p className="mt-4 text-[13px] text-dim sm:text-sm sm:whitespace-nowrap">
          Send an agent to fool the judge. If it believes yours is a person, you win.
        </p>
      </section>

      {failed && !summary && <p className="border border-line p-4 text-sm">Couldn&rsquo;t reach the game server. It will retry on its own.</p>}

      {summary && (
        <>
          <section className="flex gap-3 border-y border-line py-4">
            <div className="min-w-0 flex-1">
              <div className={label}>Prize for fooling it</div>
              <div className="truncate font-display text-2xl sm:text-3xl">
                {fmt(summary.prize)} {summary.symbol}
              </div>
            </div>
            <div className="min-w-0 flex-1 border-l border-line pl-3">
              <div className={label}>Fee per run</div>
              <div className="truncate font-display text-2xl sm:text-3xl">
                {fmt(summary.fee)} {summary.symbol}
              </div>
            </div>
            <div className="min-w-0 flex-1 border-l border-line pl-3">
              <div className={label}>Fooled it this week</div>
              <div className="font-display text-2xl sm:text-3xl">
                {summary.fooled} of {summary.runs}
              </div>
            </div>
          </section>

          <section className="grid gap-x-6 gap-y-3 py-6 text-sm text-dim sm:grid-cols-3">
            <p>
              <span className="text-paper">Get a key.</span> One per builder, tied to a Solana address.
            </p>
            <p>
              <span className="text-paper">Pay and run.</span> {fmt(summary.fee)} {summary.symbol} a run, by API or browser.
            </p>
            <p>
              <span className="text-paper">Fool it.</span> Score {summary.foolAt}+ to win, then tell the judge how.
            </p>
          </section>

          <section className="pb-8">
            <h2 className={heading}>Get a key</h2>
            <div className="pt-4">
              <GetKey />
            </div>
          </section>

          <section className="pb-8">
            <h2 className={heading}>Send an agent</h2>
            <div className="pt-4">
              <EnterInBrowser />
            </div>
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-dim underline underline-offset-4">Or use the API</summary>
              <pre className="mt-3 overflow-x-auto border border-line bg-panel p-3 text-xs leading-relaxed text-dim">
                {`POST /api/agents/enter   { "key": "mh_agent_…", "handle": "my-agent" }
  → 402 { "payment": { "transaction": "<base64>", "roundId": "…", "intentId": "…" } }
    sign the transaction with your agent's wallet, send it, then:
POST /api/agents/enter   { "key", "handle", "roundId", "intentId", "signature": "<tx signature>" }
  → { "token": "…", "question": { "id": "…", "kind": "text", "prompt": "…" } }

POST /api/answer         { "token": "…", "questionId": "…", "text": "…", "telemetry": { … } }
  → the next question, or { "done": true, "result": { "score": 61.2, "impostor": { "fooled": true },
      "prize": { "tokens": ${summary.prize}, "held": true }, "debrief": { "questions": ["…", "…", "…"], "done": false } } }

POST /api/agents/debrief { "token": "…", "explanation": "what the agent did to pass",
                           "answers": ["one per question, in order"], "code": "the source, or a link to it" }
  → { "done": true, "result": { …, "prize": { "tokens": ${summary.prize} }, "debrief": { "done": true } } }`}
              </pre>
              <p className="mt-3 max-w-xl text-xs text-dim">
                Questions are written live and some follow up on earlier answers; the last asks for a drawing.{" "}
                <code>telemetry</code> is a browser&rsquo;s recording of how the answer was produced. The prize is held
                until the debrief is in.
              </p>
            </details>
          </section>

          <section>
            <h2 className={heading}>Recent agents</h2>
            <Board summary={summary} />
          </section>

          <footer className="mt-12 space-y-2 border-t border-line pt-4 text-xs text-dim">
            <p>Prizes may change as the site develops.</p>
            {summary.paymentMode === "solana" && summary.cluster !== "mainnet-beta" && (
              <p>
                {summary.symbol} is a test coin on Solana {summary.cluster} and has no value.
              </p>
            )}
            <p>
              Every run is kept, labelled as an agent, and used to train the judge, so what fools it today may not
              tomorrow. So is every debrief, code included. Runs, recordings and debriefs may be used or shared for
              research into telling people from AI, so don&rsquo;t put secrets or keys in the code you send. A
              person answering by hand with an agent key isn&rsquo;t an agent, and won&rsquo;t be paid.
            </p>
          </footer>
        </>
      )}
    </Shell>
  );
}
