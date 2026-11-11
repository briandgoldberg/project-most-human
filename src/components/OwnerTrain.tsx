"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SeedTurn } from "@/lib/client";
import { Collector } from "@/lib/telemetry/collector";

const MAX_CHARS = 600;
const label = "text-[11px] tracking-widest text-dim uppercase";

/** One question's answer box. Mounted fresh for every question, so each recording is of that answer alone. */
function AnswerBox({ busy, onSubmit }: { busy: boolean; onSubmit: (text: string, collector: Collector) => void }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const collector = useRef<Collector | null>(null);
  const [text, setText] = useState("");

  useEffect(() => {
    const c = new Collector().start();
    if (field.current) {
      c.attachField(field.current);
      field.current.focus();
    }
    collector.current = c;
    return () => c.stop();
  }, []);

  const submit = () => {
    if (text.trim() && collector.current && !busy) onSubmit(text, collector.current);
  };

  return (
    <div>
      <textarea
        ref={field}
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, MAX_CHARS))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
        rows={4}
        aria-label="Your answer"
        placeholder="Type your answer. Don't paste: how it is typed is what gets learned."
        className="w-full resize-none border border-line bg-panel p-3 text-paper placeholder:text-dim/60 focus:border-pulse focus:outline-none"
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-xs text-dim">Ctrl or ⌘ + Enter saves and moves on</span>
        <button type="button" onClick={submit} disabled={!text.trim() || busy} className="bg-pulse px-5 py-2.5 text-ink disabled:opacity-40">
          {busy ? "Saving…" : "Save and next"}
        </button>
      </div>
    </div>
  );
}

/**
 * The training area. Whoever is here answers question after question as
 * themselves; every answer, with the recording of how it was typed, becomes
 * a real answer players hunt with and a human example the judge learns from.
 * It never runs out of questions.
 */
export function OwnerTrain() {
  const [turn, setTurn] = useState<SeedTurn | null>(null);
  const [n, setN] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const next = useCallback(async () => {
    setError(null);
    try {
      setTurn(await api.owner.seedQuestion());
      setN((x) => x + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't fetch a question.");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(next, 0);
    return () => clearTimeout(first);
  }, [next]);

  async function save(text: string, collector: Collector) {
    if (!turn) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.owner.seedAnswer(turn, text, collector.finish());
      setNote(`Saved. On typing alone the judge would have put that at ${saved.judged.toFixed(0)} out of 100 human.`);
      setTurn(saved.next);
      setN((x) => x + 1);
    } catch (err) {
      // The recording stopped when it was sent, so the answer is typed again from clean.
      setError(`${err instanceof Error ? err.message : "Couldn't save that."} Type it again.`);
      setN((x) => x + 1);
    } finally {
      setBusy(false);
    }
  }

  if (!turn) return <p className="py-4 text-sm text-dim">{error ?? "Fetching a question…"}</p>;

  return (
    <div className="space-y-4 pt-4">
      <p className="text-sm text-dim">
        Answer as yourself, for as long as you like. Each answer joins the real answers players hunt with, and teaches the
        judge what a person looks like. <span className="text-paper">{turn.answered}</span> given so far;{" "}
        <span className="text-paper">{turn.pool}</span> real answers in the game.
      </p>
      <div className="border border-line p-4">
        <div className={label}>{turn.question.style === "wild" ? "A wild one" : "About you"}</div>
        <p className="mt-2 font-display text-2xl leading-snug">{turn.question.prompt}</p>
        <p className="mt-3 inline-block border border-pulse px-2 py-1 text-xs text-pulse">{turn.depth.ask}</p>
        <div className="mt-4">
          <AnswerBox key={n} busy={busy} onSubmit={save} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-dim">
        <span role="status">{note}</span>
        <button type="button" onClick={next} disabled={busy} className="underline underline-offset-4 disabled:opacity-40">
          Skip this question
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-pulse">
          {error}
        </p>
      )}
    </div>
  );
}
