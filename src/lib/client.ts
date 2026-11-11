import type { AnswerTelemetry, Evidence, Kind, Question } from "./types";

/** Browser-side API client and wallet helpers. */

export interface HumanSummary {
  hunting: boolean;
  questionCount: number;
  huntRounds: number;
  /** What a player judged human has won after clearing 0, 1, 2... hunting rounds. */
  prizes: number[];
  prizesPerPerson: number;
  /** Whether players must sign in with Google, and the public id its button needs. */
  signIn: { required: true; clientId: string } | { required: false };
  entryFee: number;
  symbol: string;
  paymentMode: "mock" | "solana";
  cluster?: string;
  sessionMinutes: number;
  players: number;
  board: { handle: string; cleared: number; rounds: number; score: number; quip: string; won?: number; wallet?: string }[];
}

/** Who is at this browser on the human side. */
export interface Me {
  signedIn: boolean;
  name?: string;
  /** False once they have judged nearly every real answer there is. */
  canPlay: boolean;
  /** Prizes won and not yet sent. */
  balance: number;
  /** Where they have asked for their balance to be sent. */
  wallet?: string;
}

export interface AgentSummary {
  fee: number;
  prize: number;
  symbol: string;
  foolAt: number;
  paymentMode: "mock" | "solana";
  cluster?: string;
  runs: number;
  fooled: number;
  board: { handle: string; builder: string; house: boolean; score: number; quip: string; fooled: boolean; won?: number; debriefed?: boolean }[];
}

/** A hunting round as the player sees it. */
export interface HuntView {
  id: string;
  round: number;
  level: number;
  prompt: string;
  options: [string, string];
  evidence?: [Evidence, Evidence];
}

export interface HuntReveal {
  correct: boolean;
  humanIndex: 0 | 1;
  level: number;
}

export interface Session {
  token: string;
  handle: string;
  agent: boolean;
  question: Question;
  index: number;
  total: number;
  expiresAt: number;
}

export interface PlayerResult {
  score: number;
  verdict: Kind;
  quip: string;
  handle: string;
  hunt?: { cleared: number; fooled: boolean };
  missedPrize?: { tokens: number; why: "no_address" | "already_won" };
  cancelled?: boolean;
  impostor?: { fooled: boolean };
  prize?: { tokens: number; symbol: string; payable: boolean; held?: boolean; banked?: boolean };
  debrief?: { questions: string[]; done: boolean };
}

export type Progress = (
  | { done: false; question?: Question; hunt?: HuntView; index: number; total: number }
  | { done: true; result: PlayerResult }
) & { lastHunt?: HuntReveal };

export interface OwnerSummary {
  human: { total: number; judgedRight: number };
  agent: { total: number; judgedRight: number };
  model: {
    trainedAt: number;
    examples: { human: number; agent: number };
    accuracy: number | null;
    signals: { key: string; weight: number }[];
  } | null;
  retrainEvery: number;
  retrainAfterLosses: number;
  lossesSinceTraining: number;
  runsUntilRetrain: number;
  neededPerKind: number;
  llmJudge: boolean;
  googleSignIn: boolean;
  hunting: { level: number; picks: number; correct: number }[];
  huntPool: { answers: number; people: number };
  symbol: string;
  prizesOwed: { id: string; handle: string; reason: "hunter" | "fooled"; tokens: number; wallet: string | null; wonAt: number }[];
  debriefs: {
    id: string;
    handle: string;
    builder: string;
    house: boolean;
    score: number;
    at: number;
    /** Not answered yet: the prize is waiting on it. */
    due: boolean;
    questions: string[];
    explanation?: string;
    answers?: string[];
    code?: string;
    lessons?: string[];
  }[];
  agentKeys: { id: string; name: string; wallet: string; disabled: boolean; house: boolean; runsToday: number; bestToday: number | null }[];
}

export interface PaymentRequest {
  roundId: string;
  intentId: string;
  transaction: string;
  amount: number;
  symbol: string;
  cluster: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(res.status, String(json.error ?? "error"), String(json.message ?? `Request failed (${res.status})`), json);
  }
  return json as T;
}

export const api = {
  summary: () => call<HumanSummary>("/api/round"),
  me: () => call<Me>("/api/me"),
  signIn: (credential: string) => call<Me>("/api/auth/google", { credential }),
  signOut: () => call<{ ok: true }>("/api/auth/signout", {}),
  saveWallet: (wallet: string) => call<Me>("/api/me/wallet", { wallet }),
  enter: (body: Record<string, unknown>) => call<Session>("/api/enter", body),
  answer: (token: string, questionId: string, text: string, telemetry: AnswerTelemetry) =>
    call<Progress>("/api/answer", { token, questionId, text, telemetry }),
  hunt: (token: string, huntId: string, pick: 0 | 1, reason: string, telemetry: AnswerTelemetry) =>
    call<Progress>("/api/hunt", { token, huntId, pick, reason, telemetry }),
  session: (token: string) => call<Progress>("/api/session", { token }),
  agents: {
    summary: () => call<AgentSummary>("/api/agents"),
    requestKey: (name: string, wallet: string) => call<{ key: string; name: string }>("/api/agents/keys", { name, wallet }),
    enter: (body: Record<string, unknown>) => call<Session>("/api/agents/enter", body),
    debrief: (token: string, explanation: string, answers: string[], code: string) =>
      call<{ done: true; result: PlayerResult }>("/api/agents/debrief", { token, explanation, answers, code }),
  },
  owner: {
    summary: () => call<OwnerSummary>("/api/owner"),
    login: (password: string) => call<{ ok: true }>("/api/owner/login", { password }),
    logout: () => call<{ ok: true }>("/api/owner/logout", {}),
    setAgentKey: (id: string, change: { disabled?: boolean; house?: boolean }) =>
      call<{ ok: true }>("/api/owner/agent-key", { id, ...change }),
  },
};

/**
 * Enter, paying the fee on the way if one is due: the server answers 402 with
 * a transaction, the wallet signs and sends it, and the entry is retried with
 * the signature. `onStage` reports what is being waited on.
 */
export async function enterPaying(
  enter: (body: Record<string, unknown>) => Promise<Session>,
  body: Record<string, unknown>,
  sent: { payment: PaymentRequest; signature: string } | null,
  onStage: (stage: string, sentNow?: { payment: PaymentRequest; signature: string }) => void,
): Promise<Session> {
  const proof = (p: { payment: PaymentRequest; signature: string }) => ({
    ...body,
    roundId: p.payment.roundId,
    intentId: p.payment.intentId,
    signature: p.signature,
  });
  if (sent) {
    onStage("Checking your payment…");
    return enter(proof(sent));
  }
  try {
    onStage("Starting…");
    return await enter(body);
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== "payment_required") throw err;
    const payment = err.body.payment as PaymentRequest;
    const provider = findWallet();
    if (!provider) throw new Error("No Solana wallet found in this browser. Install Phantom or Solflare, then reload.");
    onStage(`Approve ${payment.amount.toLocaleString("en-US")} ${payment.symbol} in your wallet…`);
    const signature = await payEntryFee(provider, payment);
    onStage("Waiting for the payment to confirm…", { payment, signature });
    return enter(proof({ payment, signature }));
  }
}

// --- Session persistence (survives a reload, not a closed tab) ---------------

const KEY = "pmh.session";
type SavedSession = Pick<Session, "token" | "handle" | "expiresAt" | "agent">;

export function saveSession({ token, handle, expiresAt, agent }: SavedSession): void {
  sessionStorage.setItem(KEY, JSON.stringify({ token, handle, expiresAt, agent }));
}

export function loadSession(): SavedSession | null {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
}

// --- Wallet ------------------------------------------------------------------

/** The part of the wallet-provider interface shared by Phantom, Solflare and Backpack. */
export interface WalletProvider {
  publicKey?: { toBase58(): string } | null;
  connect(): Promise<unknown>;
  signAndSendTransaction(tx: unknown): Promise<{ signature: string }>;
}

export function findWallet(): WalletProvider | null {
  const w = window as unknown as {
    phantom?: { solana?: WalletProvider };
    solana?: WalletProvider;
    solflare?: WalletProvider;
    backpack?: WalletProvider;
  };
  return w.phantom?.solana ?? w.solana ?? w.solflare ?? w.backpack ?? null;
}

export async function connectWallet(provider: WalletProvider): Promise<string> {
  await provider.connect();
  const address = provider.publicKey?.toBase58();
  if (!address) throw new Error("The wallet didn't share an address");
  return address;
}

/** Have the wallet sign and send the fee transaction the server prepared. */
export async function payEntryFee(provider: WalletProvider, payment: PaymentRequest): Promise<string> {
  const { Transaction } = await import("@solana/web3.js");
  const bytes = Uint8Array.from(atob(payment.transaction), (c) => c.charCodeAt(0));
  const { signature } = await provider.signAndSendTransaction(Transaction.from(bytes));
  return signature;
}
