import Link from "next/link";
import type { ReactNode } from "react";
import { Feedback } from "./Feedback";

/** Page frame shared by the lobby and the game. */
export function Shell({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 pb-10 sm:px-6">
      <header className="flex items-center justify-between gap-4 border-b border-line py-4">
        <Link href="/" className="flex items-center gap-2 text-sm tracking-[0.25em]">
          <span className="pulse-dot inline-block size-2 rounded-full bg-pulse" aria-hidden />
          SPOT THE BOT
        </Link>
        <div className="text-xs text-dim">{aside}</div>
      </header>
      <main className="flex-1">{children}</main>
      {/* Signed-in players only, and not during a game. */}
      <Feedback />
    </div>
  );
}
