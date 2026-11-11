"use client";

import Script from "next/script";
import { useCallback, useRef, useState } from "react";
import { api, type Me } from "@/lib/client";

/** The part of Google's sign-in library this page uses. */
interface GoogleIdentity {
  initialize(options: { client_id: string; callback: (response: { credential?: string }) => void; ux_mode?: "popup"; auto_select?: boolean }): void;
  renderButton(parent: HTMLElement, options: { type: "standard"; theme: "filled_black"; size: "large"; text: "signin_with"; shape: "rectangular"; logo_alignment: "left" }): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdentity } };
  }
}

/**
 * Google's own sign-in button. Google hands the browser a signed token saying
 * who the account is; the server checks it and answers with who they are here.
 */
export function GoogleSignIn({ clientId, onSignedIn }: { clientId: string; onSignedIn: (me: Me) => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "checking" | "failed">("loading");
  const [error, setError] = useState<string | null>(null);

  const ready = useCallback(() => {
    const google = window.google?.accounts.id;
    if (!google || !holder.current) return;
    google.initialize({
      client_id: clientId,
      ux_mode: "popup",
      callback: async ({ credential }) => {
        if (!credential) return;
        setState("checking");
        setError(null);
        try {
          onSignedIn(await api.signIn(credential));
        } catch (err) {
          setError(err instanceof Error ? err.message : "Sign-in failed. Try again.");
          setState("ready");
        }
      },
    });
    holder.current.replaceChildren();
    google.renderButton(holder.current, { type: "standard", theme: "filled_black", size: "large", text: "signin_with", shape: "rectangular", logo_alignment: "left" });
    setState("ready");
  }, [clientId, onSignedIn]);

  return (
    <div className="space-y-3">
      <Script src="https://accounts.google.com/gsi/client" onReady={ready} onError={() => setState("failed")} />
      {/* Google draws its button in here. It sits on a light patch because the button is Google's to style. */}
      <div ref={holder} className="min-h-11 max-w-xs" style={{ colorScheme: "light" }} />
      {state === "loading" && <p className="text-sm text-dim">Loading Google sign-in…</p>}
      {state === "checking" && <p className="text-sm text-dim">Checking with Google…</p>}
      {state === "failed" && (
        <p role="alert" className="text-sm text-pulse">
          Couldn&rsquo;t load Google sign-in. Check your connection or any blocker, then reload.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-pulse">
          {error}
        </p>
      )}
    </div>
  );
}
