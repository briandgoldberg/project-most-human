"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, api, saveSession, type TrainingSummary } from "@/lib/client";
import type { Kind } from "@/lib/types";
import { Shell } from "./Shell";

const field =
  "w-full border border-line bg-panel px-3 py-2.5 text-paper placeholder:text-dim/60 focus:border-pulse focus:outline-none";
const primary = "bg-pulse px-5 py-2.5 text-ink transition-opacity disabled:opacity-40";
const ghost = "border border-line px-4 py-2 hover:border-paper disabled:opacity-40";
const label = "mb-1 block text-[11px] tracking-widest text-dim uppercase";

const NAME_KEY = "pmh.trainer";
const message = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");
const rate = (right: number, total: number) => (total ? `${Math.round((right / total) * 100)}%` : "n/a");

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

function Gate({ onUnlock }: { onUnlock: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.train.login(password);
      onUnlock();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <section className="py-14">
      <h1 className="font-display text-4xl">Training room</h1>
      <p className="mt-3 max-w-md text-sm text-dim">Private. Sessions played in here teach the judge.</p>
      <form onSubmit={submit} className="mt-8 max-w-sm space-y-4">
        <div>
          <label htmlFor="password" className={label}>
            Password
          </label>
          <input
            id="password"
            type="password"
            className={field}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
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

// ---------------------------------------------------------------------------
// Starting a session
// ---------------------------------------------------------------------------

function StartSession({ summary }: { summary: TrainingSummary }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fixed = summary.cohort.label === "ask" ? null : summary.cohort.label;

  // Remember the trainer's name between sessions on this browser.
  useEffect(() => {
    const saved = localStorage.getItem(NAME_KEY);
    const restore = setTimeout(() => saved && setName(saved), 0);
    return () => clearTimeout(restore);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api.train.enter(name, fixed ?? (kind || undefined));
      localStorage.setItem(NAME_KEY, name);
      saveSession(session);
      router.push("/play");
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor="name" className={label}>
          Your name
        </label>
        <input
          id="name"
          className={field}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={20}
          autoComplete="off"
          required
        />
      </div>

      {fixed ? (
        <p className="text-sm text-dim">
          Sessions from this login are recorded as {fixed === "human" ? "human" : "AI agent"}.
        </p>
      ) : (
        <fieldset>
          <legend className={label}>Who is answering this session?</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {(
              [
                ["human", "Me, a human"],
                ["agent", "An AI agent"],
              ] as const
            ).map(([value, text]) => (
              <label key={value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="kind"
                  className="accent-pulse"
                  checked={kind === value}
                  onChange={() => setKind(value)}
                  required
                />
                {text}
              </label>
            ))}
          </div>
          <p className="mt-2 max-w-lg text-xs text-dim">
            Be accurate: this is the answer key. Pick &ldquo;AI agent&rdquo; if a model writes or types any of it,
            including answers you paste in from a chatbot. The judge isn&rsquo;t told until after it has scored you.
          </p>
        </fieldset>
      )}

      <button type="submit" disabled={busy} className={primary}>
        {busy ? "Starting…" : "Start a session"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-pulse">
          {error}
        </p>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

/** Owner only: say what players on the public board really were. */
function BoardLabels({ summary, onChange }: { summary: TrainingSummary; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function mark(roundId: string, entryId: string, kind: Kind) {
    setBusy(entryId);
    setError(null);
    try {
      await api.train.label(roundId, entryId, kind);
      onChange();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  const choice = (active: boolean) =>
    `border px-2.5 py-1 text-xs disabled:opacity-40 ${active ? "border-pulse text-pulse" : "border-line text-dim hover:border-paper hover:text-paper"}`;

  return (
    <section className="mb-10">
      <h2 className="border-b border-line pb-2 text-[11px] tracking-widest text-dim uppercase">
        The public board · only you see this
      </h2>
      <p className="mt-3 max-w-xl text-xs text-dim">
        If you know who a player really was, say so. It becomes training data. Their score, their place and the pool
        don&rsquo;t change, and nobody else can see what you marked.
      </p>
      {summary.board.length === 0 ? (
        <p className="py-6 text-sm text-dim">Nobody has finished the public competition in the last few days.</p>
      ) : (
        <ol className="mt-2 divide-y divide-line">
          {summary.board.map((row) => (
            <li key={row.entryId} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 text-sm">
              <span className="min-w-0 flex-1 break-all">
                {row.handle} <span className="text-xs text-dim">{row.roundId.slice(5)}</span>
              </span>
              <span className="text-xs text-dim">judged {row.verdict === "human" ? "human" : "machine"}</span>
              <span className="w-12 text-right font-display text-lg tabular-nums">{row.score.toFixed(1)}</span>
              <span className="flex gap-2">
                {(["human", "agent"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    disabled={busy === row.entryId}
                    aria-pressed={row.label === kind}
                    onClick={() => mark(row.roundId, row.entryId, kind)}
                    className={choice(row.label === kind)}
                  >
                    {kind === "human" ? "Human" : "Agent"}
                  </button>
                ))}
              </span>
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-pulse">
          {error}
        </p>
      )}
    </section>
  );
}

function Room({ summary, onChange, onLock }: { summary: TrainingSummary; onChange: () => void; onLock: () => void }) {
  const [retraining, setRetraining] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const { human, agent, model } = summary;

  async function retrain() {
    setRetraining(true);
    setNote(null);
    try {
      await api.train.retrain();
      setNote("Retrained. The judge is using the new model from its next verdict.");
      onChange();
    } catch (err) {
      setNote(message(err));
    } finally {
      setRetraining(false);
    }
  }

  return (
    <>
      <section className="py-10">
        <h1 className="font-display text-4xl">Training room</h1>
        <p className="mt-3 max-w-xl text-sm text-dim">
          Play a session as yourself, or point an AI agent at it. The judge scores every session blind, then learns
          what it really was. Nothing here touches the daily competition or its pool.
        </p>
      </section>

      <section className="border-y border-line py-6">
        <StartSession summary={summary} />
      </section>

      <section className="grid gap-6 py-8 sm:grid-cols-3">
        <div>
          <div className={label}>Human sessions</div>
          <div className="font-display text-3xl">{human.total}</div>
          <div className="text-xs text-dim">judge recognised {rate(human.judgedRight, human.total)}</div>
        </div>
        <div>
          <div className={label}>Agent sessions</div>
          <div className="font-display text-3xl">{agent.total}</div>
          <div className="text-xs text-dim">judge caught {rate(agent.judgedRight, agent.total)}</div>
        </div>
        <div>
          <div className={label}>Behaviour model</div>
          {model ? (
            <div className="text-sm">
              Trained on {model.examples.human} human, {model.examples.agent} agent
              {model.looAccuracy !== null && (
                <div className="text-xs text-dim">{Math.round(model.looAccuracy * 100)}% on held-out sessions</div>
              )}
            </div>
          ) : (
            <div className="text-sm text-dim">Not trained yet. The judge is using its starting rules.</div>
          )}
          <button type="button" onClick={retrain} disabled={!summary.canTrain || retraining} className={`${ghost} mt-3 text-sm`}>
            {retraining ? "Retraining…" : "Retrain now"}
          </button>
          {!summary.canTrain && (
            <div className="mt-2 text-xs text-dim">
              Needs {summary.neededPerKind} sessions of each kind. Short by {Math.max(0, summary.neededPerKind - human.total)}{" "}
              human, {Math.max(0, summary.neededPerKind - agent.total)} agent.
            </div>
          )}
          {note && <div className="mt-2 text-xs text-paper">{note}</div>}
        </div>
      </section>

      {!summary.llmJudge && (
        <p className="mb-8 border border-line p-3 text-xs text-dim">
          The AI judge is off because the server has no Anthropic API key, so scores come from behaviour alone and
          answers aren&rsquo;t being read.
        </p>
      )}

      {summary.owner && <BoardLabels summary={summary} onChange={onChange} />}

      <section>
        <h2 className="border-b border-line pb-2 text-[11px] tracking-widest text-dim uppercase">
          {summary.owner ? "Recent training data" : "Recent sessions"}
        </h2>
        {summary.recent.length === 0 ? (
          <p className="py-6 text-sm text-dim">No sessions yet.</p>
        ) : (
          <ol className="divide-y divide-line">
            {summary.recent.map((s) => (
              <li key={s.id} className="flex items-baseline gap-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 break-all">
                  {s.handle}
                  {s.fromBoard && <span className="ml-2 text-xs text-dim">from the board</span>}
                </span>
                <span className="w-14 shrink-0 text-xs text-dim">{s.truth}</span>
                <span className={`w-20 shrink-0 text-xs ${s.judgeCorrect ? "text-dim" : "text-pulse"}`}>
                  {s.truth === "human" ? (s.judgeCorrect ? "recognised" : "misjudged") : s.judgeCorrect ? "caught" : "fooled it"}
                </span>
                <span className="w-12 shrink-0 text-right font-display text-lg tabular-nums">{s.score.toFixed(1)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <p className="mt-10 max-w-xl text-xs text-dim">
        Sessions here record keystroke timing, edits, pointer movement, drawing strokes and browser details. By playing
        you agree they are kept with their human-or-agent label and may be used or shared, without your name, for
        research into telling people from AI.
      </p>

      <button type="button" onClick={onLock} className="mt-4 block text-xs text-dim underline underline-offset-4">
        Lock the room on this browser
      </button>
    </>
  );
}

export function TrainingRoom() {
  const [summary, setSummary] = useState<TrainingSummary | null>(null);
  const [state, setState] = useState<"loading" | "locked" | "open" | "error">("loading");

  const load = useCallback(async () => {
    try {
      setSummary(await api.train.summary());
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
    await api.train.logout().catch(() => undefined);
    setSummary(null);
    setState("locked");
  };

  return (
    <Shell aside="Training">
      {state === "loading" && <p className="py-16 text-sm text-dim">Checking the door…</p>}
      {state === "error" && <p className="py-16 text-sm">Couldn&rsquo;t reach the server. Reload to try again.</p>}
      {state === "locked" && <Gate onUnlock={load} />}
      {state === "open" && summary && <Room summary={summary} onChange={load} onLock={lock} />}
    </Shell>
  );
}
