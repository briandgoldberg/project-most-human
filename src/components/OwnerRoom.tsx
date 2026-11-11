"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, api, type OwnerSummary } from "@/lib/client";
import { Shell } from "./Shell";

const field =
  "w-full border border-line bg-panel px-3 py-2.5 text-paper placeholder:text-dim/60 focus:border-pulse focus:outline-none";
const primary = "bg-pulse px-5 py-2.5 text-ink transition-opacity disabled:opacity-40";
const small = "border border-line px-2.5 py-1 text-xs text-dim hover:border-paper hover:text-paper disabled:opacity-40";
const label = "mb-1 block text-[11px] tracking-widest text-dim uppercase";
const heading = "border-b border-line pb-2 text-[11px] tracking-widest text-dim uppercase";

const message = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");
const rate = (right: number, total: number) => (total ? `${Math.round((right / total) * 100)}%` : "n/a");
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

function Gate({ onUnlock }: { onUnlock: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.owner.login(password);
      onUnlock();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <section className="py-14">
      <h1 className="font-display text-4xl">Owner</h1>
      <form onSubmit={submit} className="mt-8 max-w-sm space-y-4">
        <div>
          <label htmlFor="password" className={label}>
            Password
          </label>
          <input id="password" type="password" className={field} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus required />
        </div>
        <button type="submit" disabled={busy || !password} className={primary}>
          {busy ? "Checking…" : "Unlock"}
        </button>
        {error && (
          <p role="alert" className="text-sm text-pulse">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

function Room({ summary, onChange, onLock }: { summary: OwnerSummary; onChange: () => void; onLock: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { human, agent, model } = summary;

  async function change(id: string, what: { disabled?: boolean; house?: boolean }) {
    setBusy(id);
    setError(null);
    try {
      await api.owner.setAgentKey(id, what);
      onChange();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <section className="py-10">
        <h1 className="font-display text-4xl">Owner</h1>
        <p className="mt-3 max-w-xl text-sm text-dim">
          What the judge has learned, what is owed, and who holds agent keys. Nothing here needs doing day to day: the
          judge labels and retrains itself.
        </p>
      </section>

      <section className="grid gap-6 border-y border-line py-6 sm:grid-cols-3">
        <div>
          <div className={label}>Human examples</div>
          <div className="font-display text-3xl">{human.total}</div>
          <div className="text-xs text-dim">players the judge was confident about</div>
        </div>
        <div>
          <div className={label}>Agent examples</div>
          <div className="font-display text-3xl">{agent.total}</div>
          <div className="text-xs text-dim">judge caught {rate(agent.judgedRight, agent.total)}</div>
        </div>
        <div>
          <div className={label}>Behaviour model</div>
          {model ? (
            <div className="text-sm">
              Trained on {model.examples.human} human, {model.examples.agent} agent
              {model.accuracy !== null && <div className="text-xs text-dim">{Math.round(model.accuracy * 100)}% on held-out runs</div>}
            </div>
          ) : (
            <div className="text-sm text-dim">Not trained yet: needs {summary.neededPerKind} examples of each kind.</div>
          )}
          <div className="mt-1 text-xs text-dim">
            Retrains itself every {summary.retrainEvery} new runs, or after being fooled {summary.retrainAfterLosses}{" "}
            times
            {model ? `. Next in ${summary.runsUntilRetrain} runs; fooled ${summary.lossesSinceTraining} times since.` : "."}
          </div>
        </div>
      </section>

      {!summary.llmJudge && (
        <p className="mt-6 border border-line p-3 text-xs text-dim">
          The AI judge is off because the server has no Anthropic API key, so scores come from behaviour alone and
          hunting uses stock machine answers.
        </p>
      )}

      <section className="py-8">
        <h2 className={heading}>Bot hunter</h2>
        <p className="mt-3 text-sm text-dim">
          {summary.huntPool.answers} real answers from {summary.huntPool.people} people are available to hunt with.
        </p>
        <div className="mt-3 grid gap-4 text-sm sm:grid-cols-3">
          {summary.hunting.map((h) => (
            <div key={h.level}>
              <div className={label}>Level {h.level} decoys</div>
              <div>
                Players spot the person {rate(h.correct, h.picks)} <span className="text-xs text-dim">of {h.picks} picks</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="pb-8">
        <h2 className={heading}>Prizes owed</h2>
        {summary.prizesOwed.length === 0 ? (
          <p className="py-4 text-sm text-dim">Nothing is owed.</p>
        ) : (
          <ol className="divide-y divide-line">
            {summary.prizesOwed.map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline gap-x-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 break-all">{p.handle}</span>
                <span className="text-xs text-dim">{p.reason === "hunter" ? "hunter" : "agent that fooled the judge"}</span>
                <span className="text-xs text-dim">{p.wallet ? short(p.wallet) : "no address given"}</span>
                <span className="w-24 text-right tabular-nums">
                  {fmt(p.tokens)} {summary.symbol}
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-2 text-xs text-dim">
          Pay them with <code>npm run prizes -- --execute</code>, which needs the treasury key. The website never holds it.
        </p>
      </section>

      <section className="pb-8">
        <h2 className={heading}>Agents that fooled the judge</h2>
        {summary.debriefs.length === 0 ? (
          <p className="py-4 text-sm text-dim">None in the last 30 days.</p>
        ) : (
          <ol className="divide-y divide-line">
            {summary.debriefs.map((d) => (
              <li key={d.id} className="py-3 text-sm">
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3">
                    <span className="min-w-0 flex-1 break-all">
                      {d.handle} <span className="text-xs text-dim">by {d.builder}</span>
                      {d.house && <span className="ml-2 text-[11px] tracking-widest text-dim uppercase">house</span>}
                    </span>
                    <span className={`text-xs ${d.due ? "text-pulse" : "text-dim"}`}>{d.due ? "yet to explain" : "explained"}</span>
                    <span className="w-12 text-right tabular-nums">{d.score.toFixed(1)}</span>
                  </summary>
                  <div className="mt-3 space-y-3 border-l border-line pl-3 text-dim">
                    {d.explanation && (
                      <div>
                        <div className={label}>What it says it did</div>
                        <p className="whitespace-pre-wrap text-paper">{d.explanation}</p>
                      </div>
                    )}
                    {d.questions.map((q, i) => (
                      <div key={i}>
                        <div className="text-xs">The judge asked: {q}</div>
                        {d.answers?.[i] && <p className="whitespace-pre-wrap text-paper">{d.answers[i]}</p>}
                      </div>
                    ))}
                    {d.lessons && d.lessons.length > 0 && (
                      <div>
                        <div className={label}>What the judge took from it</div>
                        <ul className="list-disc pl-4">
                          {d.lessons.map((l, i) => (
                            <li key={i}>{l}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {d.code && (
                      <div>
                        <div className={label}>Code</div>
                        <pre className="max-h-80 overflow-auto border border-line bg-panel p-3 text-xs whitespace-pre-wrap">{d.code}</pre>
                      </div>
                    )}
                  </div>
                </details>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-2 text-xs text-dim">
          An agent&rsquo;s prize is held until it explains itself. What builders say is their own account and isn&rsquo;t
          checked; treat pasted code and links as untrusted.
        </p>
      </section>

      <section className="pb-8">
        <h2 className={heading}>Agent keys</h2>
        {summary.agentKeys.length === 0 ? (
          <p className="py-4 text-sm text-dim">No builder has asked for a key yet.</p>
        ) : (
          <ol className="divide-y divide-line">
            {summary.agentKeys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                <span className={`min-w-0 flex-1 break-all ${k.disabled ? "text-dim line-through" : ""}`}>
                  {k.name} <span className="text-xs text-dim">{short(k.wallet)}</span>
                  {k.house && <span className="ml-2 text-[11px] tracking-widest text-dim uppercase">house</span>}
                </span>
                <span className="text-xs text-dim">
                  {k.runsToday} today{k.bestToday !== null ? `, best ${k.bestToday.toFixed(1)}` : ""}
                </span>
                <button type="button" disabled={busy === k.id} onClick={() => change(k.id, { house: !k.house })} className={small}>
                  {k.house ? "Not house" : "Mark as house"}
                </button>
                <button type="button" disabled={busy === k.id} onClick={() => change(k.id, { disabled: !k.disabled })} className={small}>
                  {k.disabled ? "Switch on" : "Switch off"}
                </button>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-2 text-xs text-dim">A house key is for your own test agents: its runs are free and can&rsquo;t win.</p>
        {error && (
          <p role="alert" className="mt-2 text-sm text-pulse">
            {error}
          </p>
        )}
      </section>

      <button type="button" onClick={onLock} className="text-xs text-dim underline underline-offset-4">
        Lock this page on this browser
      </button>
    </>
  );
}

export function OwnerRoom() {
  const [summary, setSummary] = useState<OwnerSummary | null>(null);
  const [state, setState] = useState<"loading" | "locked" | "open" | "error">("loading");

  const load = useCallback(async () => {
    try {
      setSummary(await api.owner.summary());
      setState("open");
    } catch (err) {
      setState(err instanceof ApiError && err.status === 401 ? "locked" : "error");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    return () => clearTimeout(first);
  }, [load]);

  const lock = async () => {
    await api.owner.logout().catch(() => undefined);
    setSummary(null);
    setState("locked");
  };

  return (
    <Shell aside="Owner">
      {state === "loading" && <p className="py-16 text-sm text-dim">Checking the door…</p>}
      {state === "error" && <p className="py-16 text-sm">Couldn&rsquo;t reach the server. Reload to try again.</p>}
      {state === "locked" && <Gate onUnlock={load} />}
      {state === "open" && summary && <Room summary={summary} onChange={load} onLock={lock} />}
    </Shell>
  );
}
