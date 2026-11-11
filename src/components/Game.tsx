"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ApiError, api, loadSession, type HuntReveal, type HuntView, type PlayerResult, type Progress } from "@/lib/client";
import { Collector } from "@/lib/telemetry/collector";
import type { AnswerTelemetry, Question, StrokePoint } from "@/lib/types";
import { Shell } from "./Shell";
import { formatCountdown, useNow } from "./useNow";

const MAX_CHARS = 600;

interface Submission {
  questionId: string;
  text: string;
  telemetry: AnswerTelemetry;
}

interface At {
  index: number;
  total: number;
}

type View =
  | { phase: "loading" }
  | { phase: "no-session" }
  | ({ phase: "question"; question: Question } & At)
  | ({ phase: "sending"; question: Question; pending: Submission; error?: string } & At)
  | ({ phase: "hunt"; hunt: HuntView; picking?: 0 | 1; error?: string } & At)
  /** A hunt just decided: show which answer was the person's before moving on to `next`. */
  | ({ phase: "reveal"; hunt: HuntView; pick: 0 | 1; reveal: HuntReveal; next: Progress } & At)
  | { phase: "result"; result: PlayerResult };

const button = "bg-pulse px-5 py-2.5 text-ink transition-opacity disabled:opacity-40";
const ghost = "border border-line px-4 py-2.5 hover:border-paper disabled:opacity-40";

// ---------------------------------------------------------------------------
// Question types
// ---------------------------------------------------------------------------

function TextQuestion({ question, onSubmit }: { question: Question; onSubmit: (s: Submission) => void }) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const collector = useRef<Collector | null>(null);
  const [text, setText] = useState("");

  useEffect(() => {
    const c = new Collector().start();
    if (fieldRef.current) {
      c.attachField(fieldRef.current);
      fieldRef.current.focus();
    }
    collector.current = c;
    return () => c.stop();
  }, []);

  const submit = () => {
    if (!text.trim() || !collector.current) return;
    onSubmit({ questionId: question.id, text, telemetry: collector.current.finish() });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  };

  return (
    <div>
      <textarea
        ref={fieldRef}
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, MAX_CHARS))}
        onKeyDown={onKeyDown}
        rows={5}
        aria-label="Your answer"
        placeholder="Type your answer"
        className="w-full resize-none border border-line bg-panel p-3 text-paper placeholder:text-dim/60 focus:border-pulse focus:outline-none"
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-xs text-dim tabular-nums">
          {text.length}/{MAX_CHARS}
        </span>
        <button type="button" onClick={submit} disabled={!text.trim()} className={button}>
          Answer
        </button>
      </div>
    </div>
  );
}

function DrawQuestion({ question, onSubmit }: { question: Question; onSubmit: (s: Submission) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const collector = useRef<Collector | null>(null);
  const strokes = useRef<StrokePoint[][]>([]);
  const drawing = useRef(false);
  const [strokeCount, setStrokeCount] = useState(0);

  useEffect(() => {
    const c = new Collector().start();
    collector.current = c;
    const canvas = canvasRef.current;
    if (canvas) {
      // Match the backing store to the display size so lines stay sharp.
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.scale(dpr, dpr);
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "#ece6da";
      }
    }
    return () => c.stop();
  }, []);

  const point = (e: PointerEvent<HTMLCanvasElement>): StrokePoint => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [
      Math.round(performance.now()),
      Math.round((e.clientX - rect.left) * 10) / 10,
      Math.round((e.clientY - rect.top) * 10) / 10,
      e.pressure,
    ];
  };

  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    strokes.current.push([point(e)]);
  };

  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const stroke = strokes.current[strokes.current.length - 1];
    const prev = stroke[stroke.length - 1];
    const next = point(e);
    stroke.push(next);
    const ctx = e.currentTarget.getContext("2d");
    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(prev[1], prev[2]);
      ctx.lineTo(next[1], next[2]);
      ctx.stroke();
    }
  };

  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    setStrokeCount(strokes.current.length);
  };

  const clear = () => {
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    strokes.current = [];
    setStrokeCount(0);
  };

  const submit = () => {
    if (!strokes.current.length || !collector.current) return;
    onSubmit({ questionId: question.id, text: "", telemetry: collector.current.finish(strokes.current) });
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        aria-label="Drawing area"
        className="h-72 w-full touch-none border border-line bg-panel"
        style={{ cursor: "crosshair" }}
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <button type="button" onClick={clear} disabled={strokeCount === 0} className={ghost}>
          Clear
        </button>
        <button type="button" onClick={submit} disabled={strokeCount === 0} className={button}>
          Done
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bot Hunter
// ---------------------------------------------------------------------------

/** Two answers to one question. One was typed by a person; the player picks which. */
function HuntRound({
  hunt,
  picking,
  reveal,
  pick,
  onPick,
}: {
  hunt: HuntView;
  picking?: 0 | 1;
  reveal?: HuntReveal;
  pick?: 0 | 1;
  onPick?: (choice: 0 | 1) => void;
}) {
  return (
    <div>
      <p className="mb-4 text-sm text-dim">
        {reveal
          ? reveal.correct
            ? "Right. That one was the person."
            : "Wrong. The machine fooled you, and your climb ends here."
          : "One of these was typed by a person, the other written by a machine. Pick the person."}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {([0, 1] as const).map((i) => {
          const isPerson = reveal?.humanIndex === i;
          const chosen = (reveal ? pick : picking) === i;
          const edge = reveal ? (isPerson ? "border-pulse" : "border-line opacity-60") : chosen ? "border-pulse" : "border-line hover:border-paper";
          return (
            <button
              key={i}
              type="button"
              disabled={!onPick || picking !== undefined}
              onClick={() => onPick?.(i)}
              aria-label={`Answer ${i === 0 ? "A" : "B"}`}
              className={`flex min-h-36 flex-col border bg-panel p-4 text-left transition-colors disabled:cursor-default ${edge}`}
            >
              <span className="mb-2 text-[11px] tracking-widest text-dim uppercase">
                {i === 0 ? "A" : "B"}
                {reveal && (isPerson ? " · a person" : " · the machine")}
                {reveal && chosen && " · your pick"}
              </span>
              <span className="break-words whitespace-pre-wrap">{hunt.options[i]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function Result({ result }: { result: PlayerResult }) {
  const { hunt, prize, impostor, cancelled } = result;
  return (
    <section className="py-12 text-center sm:py-16">
      <div className="text-[11px] tracking-widest text-dim uppercase">The judge&rsquo;s read on {result.handle}</div>
      <div className="mt-4 font-display text-8xl leading-none tabular-nums sm:text-9xl">{result.score.toFixed(1)}</div>
      <div className="mt-2 text-xs text-dim">out of 100 human</div>
      <p className="mx-auto mt-8 max-w-md font-display text-2xl">&ldquo;{result.quip}&rdquo;</p>

      <div className="mx-auto mt-8 max-w-md space-y-3 text-sm">
        {cancelled && (
          <p className="border border-pulse p-3 text-pulse">
            The judge took you for a bot, so this game is cancelled: it isn&rsquo;t on the board and can&rsquo;t win a
            prize. If you&rsquo;re a person, play again and just be yourself.
          </p>
        )}
        {hunt && !cancelled && (
          <p className="border border-line p-3">
            You cleared hunting round {hunt.cleared} of {hunt.rounds}.{" "}
            {prize ? null : <span className="text-dim">The prize is for reaching round {hunt.prizeRound}.</span>}
          </p>
        )}
        {impostor && (
          <p className={`border p-3 ${impostor.fooled ? "border-pulse text-pulse" : "border-line"}`}>
            {impostor.fooled ? "The judge took this agent for a person." : "The judge caught this agent."} The run is now
            training data.
          </p>
        )}
        {prize && (
          <p className="border border-pulse p-3">
            <span className="text-pulse">
              You won {prize.tokens.toLocaleString("en-US")} {prize.symbol}.
            </span>{" "}
            {prize.payable
              ? "It will be sent to the address you gave."
              : "You didn't give an address to send it to, so it can't be paid out this time."}
          </p>
        )}
      </div>

      <Link href={impostor ? "/agents" : "/"} className={`${ghost} mt-8 inline-block`}>
        {impostor ? "Back to the agents' side" : "Play again"}
      </Link>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

function fromProgress(p: Progress): View {
  if (p.done) return { phase: "result", result: p.result };
  const at = { index: p.index, total: p.total };
  if (p.hunt) return { phase: "hunt", hunt: p.hunt, ...at };
  return { phase: "question", question: p.question!, ...at };
}

export function Game() {
  const [view, setView] = useState<View>({ phase: "loading" });
  const [session, setSession] = useState<ReturnType<typeof loadSession>>(null);
  const now = useNow();

  useEffect(() => {
    let alive = true;
    const resume = async () => {
      const saved = loadSession();
      if (!saved) {
        setView({ phase: "no-session" });
        return;
      }
      setSession(saved);
      try {
        const progress = await api.session(saved.token);
        if (alive) setView(fromProgress(progress));
      } catch {
        if (alive) setView({ phase: "no-session" });
      }
    };
    resume();
    return () => {
      alive = false;
    };
  }, []);

  const send = useCallback(
    async (at: { question: Question } & At, pending: Submission) => {
      if (!session) return;
      setView({ ...at, phase: "sending", pending });
      try {
        setView(fromProgress(await api.answer(session.token, pending.questionId, pending.text, pending.telemetry)));
      } catch (err) {
        if (err instanceof ApiError && (err.code === "wrong_question" || err.code === "already_finished")) {
          // The server is ahead of us (e.g. a retry that had actually landed). Catch up.
          setView(fromProgress(await api.session(session.token)));
          return;
        }
        setView({ ...at, phase: "sending", pending, error: err instanceof Error ? err.message : "Couldn't send that." });
      }
    },
    [session],
  );

  const pick = useCallback(
    async (at: { hunt: HuntView } & At, choice: 0 | 1) => {
      if (!session) return;
      setView({ ...at, phase: "hunt", picking: choice, error: undefined });
      try {
        const next = await api.hunt(session.token, at.hunt.id, choice);
        if (next.lastHunt) setView({ ...at, phase: "reveal", pick: choice, reveal: next.lastHunt, next });
        else setView(fromProgress(next));
      } catch (err) {
        if (err instanceof ApiError && (err.code === "wrong_hunt" || err.code === "already_finished")) {
          setView(fromProgress(await api.session(session.token)));
          return;
        }
        setView({ ...at, phase: "hunt", picking: undefined, error: err instanceof Error ? err.message : "Couldn't send that." });
      }
    },
    [session],
  );

  const inPlay = view.phase === "question" || view.phase === "sending" || view.phase === "hunt" || view.phase === "reveal";
  const timeLeft = session && now !== null ? session.expiresAt - now : null;
  const aside = inPlay ? `${session?.handle ?? ""}${timeLeft !== null ? ` · ${formatCountdown(timeLeft)}` : ""}` : session?.handle;

  return (
    <Shell aside={aside}>
      {view.phase === "loading" && <p className="py-16 text-sm text-dim">Finding your seat…</p>}

      {view.phase === "no-session" && (
        <section className="py-16">
          <p className="font-display text-3xl">You&rsquo;re not in a game.</p>
          <Link href="/" className={`${ghost} mt-6 inline-block`}>
            Start one
          </Link>
        </section>
      )}

      {(view.phase === "question" || view.phase === "sending") && (
        <section className="py-10">
          <div className="text-[11px] tracking-widest text-dim uppercase">
            Step {view.index + 1} of {view.total} · prove you&rsquo;re human
          </div>
          <h1 className="mt-3 mb-6 font-display text-3xl leading-tight sm:text-4xl">{view.question.prompt}</h1>

          {view.phase === "question" &&
            (view.question.kind === "draw" ? (
              <DrawQuestion key={view.question.id} question={view.question} onSubmit={(s) => send(view, s)} />
            ) : (
              <TextQuestion key={view.question.id} question={view.question} onSubmit={(s) => send(view, s)} />
            ))}

          {view.phase === "sending" && !view.error && (
            <p className="flex items-center gap-2 py-8 text-sm text-dim" role="status">
              <span className="pulse-dot inline-block size-2 rounded-full bg-pulse" aria-hidden />
              {view.index + 1 === view.total ? "The judge is making up its mind…" : "Noted. Setting up what comes next…"}
            </p>
          )}

          {view.phase === "sending" && view.error && (
            <div className="py-6">
              <p role="alert" className="text-sm text-pulse">
                {view.error}
              </p>
              <button type="button" onClick={() => send(view, view.pending)} className={`${ghost} mt-4`}>
                Send it again
              </button>
            </div>
          )}

          {view.question.hint && view.phase === "question" && <p className="mt-4 text-xs text-dim">{view.question.hint}</p>}
        </section>
      )}

      {(view.phase === "hunt" || view.phase === "reveal") && (
        <section className="py-10">
          <div className="text-[11px] tracking-widest text-dim uppercase">
            Step {view.index + 1} of {view.total} · bot hunter, round {view.hunt.round}
          </div>
          <h1 className="mt-3 mb-6 font-display text-3xl leading-tight sm:text-4xl">{view.hunt.prompt}</h1>

          {view.phase === "hunt" ? (
            <HuntRound key={view.hunt.id} hunt={view.hunt} picking={view.picking} onPick={(choice) => pick(view, choice)} />
          ) : (
            <>
              <HuntRound hunt={view.hunt} reveal={view.reveal} pick={view.pick} />
              <button type="button" onClick={() => setView(fromProgress(view.next))} className={`${button} mt-6`} autoFocus>
                {view.next.done ? "See how you did" : "Carry on"}
              </button>
            </>
          )}

          {view.phase === "hunt" && view.error && (
            <p role="alert" className="mt-4 text-sm text-pulse">
              {view.error}
            </p>
          )}
        </section>
      )}

      {view.phase === "result" && <Result result={view.result} />}
    </Shell>
  );
}
