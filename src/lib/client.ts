import type { AnswerTelemetry, Kind, Question } from "./types";

/** Browser-side API client and wallet helpers. */

export interface RoundSummary {
  roundId: string;
  endsAt: number;
  open: boolean;
  questionCount: number;
  entrants: number;
  scored: number;
  pool: number;
  entryFee: number;
  symbol: string;
  paymentMode: "mock" | "solana";
  cluster?: string;
  sessionMinutes: number;
  payout?: { winnerHandle: string; amountTokens: number; signature?: string; dryRun: boolean };
  leaderboard: {
    rank: number;
    handle: string;
    score: number;
    quip: string;
    wallet?: string;
  }[];
}

export interface Session {
  token: string;
  roundId: string;
  handle: string;
  training: boolean;
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
  roundId: string;
  handle: string;
  rank?: number;
  scored?: number;
  training?: { truth: Kind; judgeCorrect: boolean };
  impostor?: { fooled: boolean; rank: number; of: number };
}

export interface BountySummary {
  roundId: string;
  bounty: number;
  symbol: string;
  fooledAt: number;
  entriesPerKey: number;
  payout?: { winnerHandle: string; amountTokens: number; signature?: string };
  board: { rank: number; handle: string; builder: string; score: number; quip: string; fooled: boolean; leading: boolean }[];
}

export interface TrainingSummary {
  cohort: { id: string; label: Kind | "ask" };
  owner: boolean;
  board: { roundId: string; entryId: string; handle: string; score: number; verdict: Kind; label?: Kind }[];
  agentKeys: { id: string; name: string; wallet: string; disabled: boolean; entriesToday: number; bestToday: number | null }[];
  human: { total: number; judgedRight: number };
  agent: { total: number; judgedRight: number };
  neededPerKind: number;
  canTrain: boolean;
  model: {
    trainedAt: number;
    examples: { human: number; agent: number };
    looAccuracy: number | null;
    signals: { key: string; weight: number }[];
  } | null;
  llmJudge: boolean;
  recent: { id: string; at: number; handle: string; truth: Kind; fromBoard: boolean; score: number; judgeCorrect: boolean }[];
}

export type Progress =
  | { done: false; question: Question; index: number; total: number }
  | { done: true; result: PlayerResult };

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
  round: (roundId?: string) => call<RoundSummary>(`/api/round${roundId ? `?round=${roundId}` : ""}`),
  enter: (body: Record<string, unknown>) => call<Session>("/api/enter", body),
  answer: (token: string, questionId: string, text: string, telemetry: AnswerTelemetry) =>
    call<Progress>("/api/answer", { token, questionId, text, telemetry }),
  session: (token: string) => call<Progress>("/api/session", { token }),
  train: {
    summary: () => call<TrainingSummary>("/api/train"),
    login: (password: string) => call<{ ok: true }>("/api/train/login", { password }),
    logout: () => call<{ ok: true }>("/api/train/logout", {}),
    enter: (handle: string, declaredKind?: Kind) => call<Session>("/api/train/enter", { handle, declaredKind }),
    retrain: () => call<TrainingSummary["model"]>("/api/train/retrain", {}),
    label: (roundId: string, entryId: string, label: Kind) =>
      call<{ handle: string; label: Kind; judgeCorrect: boolean }>("/api/train/label", { roundId, entryId, label }),
    setAgentKey: (id: string, disabled: boolean) => call<{ ok: true }>("/api/train/agent-key", { id, disabled }),
  },
  agents: {
    summary: () => call<BountySummary>("/api/agents"),
    requestKey: (name: string, wallet: string) => call<{ key: string; name: string }>("/api/agents/keys", { name, wallet }),
    enter: (key: string, handle: string) => call<Session>("/api/agents/enter", { key, handle }),
  },
};

// --- Session persistence (survives a reload, not a closed tab) ---------------

const KEY = "pmh.session";

type SavedSession = Pick<Session, "token" | "handle" | "expiresAt" | "training" | "agent">;

export function saveSession({ token, handle, expiresAt, training, agent }: SavedSession): void {
  sessionStorage.setItem(KEY, JSON.stringify({ token, handle, expiresAt, training, agent }));
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

/** Have the wallet sign and send the entry-fee transaction the server prepared. */
export async function payEntryFee(provider: WalletProvider, payment: PaymentRequest): Promise<string> {
  const { Transaction } = await import("@solana/web3.js");
  const bytes = Uint8Array.from(atob(payment.transaction), (c) => c.charCodeAt(0));
  const { signature } = await provider.signAndSendTransaction(Transaction.from(bytes));
  return signature;
}
