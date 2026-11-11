"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/lib/client";

const MAX_CHARS = 2000;

/**
 * A way for signed-in players to tell the owner something or ask a question:
 * a button in the bottom right corner that opens a small box. Nobody who
 * isn't signed in sees it, and it stays out of the way during a game, where
 * every keystroke on the page is part of what the judge reads.
 */
export function Feedback() {
  const pathname = usePathname();
  const [signedIn, setSignedIn] = useState(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hidden = pathname?.startsWith("/play") ?? false;

  useEffect(() => {
    if (hidden) return;
    let alive = true;
    api
      .me()
      .then((me) => alive && setSignedIn(me.signedIn))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [hidden]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (hidden || !signedIn) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.feedback(text, email, pathname ?? "");
      setSent(true);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send that.");
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full border border-line bg-ink px-3 py-2 text-sm text-paper placeholder:text-dim/60 focus:border-pulse focus:outline-none";
  return (
    <div className="fixed right-4 bottom-4 z-40 flex flex-col items-end gap-2">
      {open && (
        <div role="dialog" aria-label="Feedback and questions" className="w-80 max-w-[calc(100vw-2rem)] border border-line bg-panel p-4 shadow-lg shadow-black/40">
          {sent ? (
            <div className="space-y-3 text-sm">
              <p>Thanks. It&rsquo;s been passed on.</p>
              <button type="button" className="text-xs underline underline-offset-4" onClick={() => setSent(false)}>
                Send another
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <label htmlFor="feedback-text" className="block text-sm">
                Feedback or a question?
              </label>
              <textarea
                id="feedback-text"
                value={text}
                onChange={(e) => setText(e.target.value.slice(0, MAX_CHARS))}
                rows={4}
                placeholder="What's broken, confusing, or missing?"
                className={`${field} resize-none`}
                autoFocus
                required
              />
              <div>
                <label htmlFor="feedback-email" className="mb-1 block text-xs text-dim">
                  Email, only if you want a reply
                </label>
                <input id="feedback-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="optional" autoComplete="email" className={field} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-dim tabular-nums">
                  {text.length}/{MAX_CHARS}
                </span>
                <button type="submit" disabled={busy || !text.trim()} className="bg-pulse px-4 py-2 text-sm text-ink transition-opacity disabled:opacity-40">
                  {busy ? "Sending…" : "Send"}
                </button>
              </div>
              {error && (
                <p role="alert" className="text-xs text-pulse">
                  {error}
                </p>
              )}
            </form>
          )}
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="border border-line bg-panel px-3 py-2 text-xs text-dim shadow-lg shadow-black/40 hover:border-paper hover:text-paper"
      >
        {open ? "Close" : "Feedback"}
      </button>
    </div>
  );
}
