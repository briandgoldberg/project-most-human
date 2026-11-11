import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { Kind } from "./types";

/**
 * A cohort is a group of trusted testers who share a password to the private
 * training room. Everything they play is labelled and kept as training data.
 */
export interface Cohort {
  id: string;
  /** Ground truth for the cohort's sessions. "ask" = each tester says which they are when they start. */
  label: Kind | "ask";
  password: string;
}

/** Passwords that only work outside production, so local runs need no setup. */
const DEV_COHORTS: Cohort[] = [
  { id: "trainers", label: "ask", password: "train-dev" },
  { id: "house-bots", label: "agent", password: "housebot-dev" },
];

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function num(name: string, fallback: number): number {
  const v = Number(env(name));
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Who may enter the training room:
 *   TRAINING_PASSWORD   you and your friends; each session declares human or agent
 *   HOUSE_BOT_PASSWORD  the house bots; always labelled agent
 * or TRAINING_COHORTS, a JSON array of { id, label, password }, for finer groups.
 */
export function cohorts(): Cohort[] {
  const raw = env("TRAINING_COHORTS");
  if (raw) {
    const parsed = JSON.parse(raw) as Cohort[];
    for (const c of parsed) {
      if (!c.id || !c.password || !["human", "agent", "ask"].includes(c.label)) {
        throw new Error(`TRAINING_COHORTS: invalid cohort ${JSON.stringify(c.id)}`);
      }
    }
    return parsed;
  }
  const fromEnv: Cohort[] = [];
  const trainers = env("TRAINING_PASSWORD");
  const bots = env("HOUSE_BOT_PASSWORD");
  if (trainers) fromEnv.push({ id: "trainers", label: "ask", password: trainers });
  if (bots) fromEnv.push({ id: "house-bots", label: "agent", password: bots });
  if (fromEnv.length) return fromEnv;
  return process.env.NODE_ENV === "production" ? [] : DEV_COHORTS;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time lookup of the cohort a training password belongs to. */
export function cohortForPassword(code: string): Cohort | undefined {
  const given = digest(code);
  let match: Cohort | undefined;
  for (const c of cohorts()) {
    if (timingSafeEqual(given, digest(c.password))) match = c;
  }
  return match;
}

export type PaymentMode = "mock" | "solana";

export function config() {
  const paymentMode = (env("PAYMENT_MODE") ?? "mock") as PaymentMode;
  if (paymentMode !== "mock" && paymentMode !== "solana") {
    throw new Error(`PAYMENT_MODE must be "mock" or "solana", got ${JSON.stringify(paymentMode)}`);
  }
  const cluster = env("SOLANA_CLUSTER") ?? "devnet";
  return {
    dataDir: env("PMH_DATA_DIR") ?? path.join(process.cwd(), "data"),
    paymentMode,
    /** Entry fee in whole tokens. */
    entryFeeTokens: num("ENTRY_FEE_TOKENS", 1000),
    tokenSymbol: env("TOKEN_SYMBOL") ?? (paymentMode === "mock" ? "PLAY" : "TOKEN"),
    /** House cut of the pool, in basis points. */
    rakeBps: num("RAKE_BPS", 0),
    /** How long a player has to finish after entering. */
    sessionMinutes: num("SESSION_MINUTES", 30),
    questionSalt: env("QUESTION_SALT") ?? "",
    questionSource: (env("QUESTION_SOURCE") ?? "bank") as "bank" | "llm",
    solana: {
      cluster,
      rpcUrl: env("SOLANA_RPC_URL") ?? `https://api.${cluster}.solana.com`,
      mint: env("TOKEN_MINT"),
      treasury: env("TREASURY_WALLET"),
    },
    judge: {
      model: env("JUDGE_MODEL") ?? "claude-opus-5-5",
      effort: (env("JUDGE_EFFORT") ?? "medium") as "low" | "medium" | "high",
      /** The LLM judge runs when Anthropic credentials are present, unless switched off. */
      llmEnabled:
        env("JUDGE_LLM") !== "off" && Boolean(env("ANTHROPIC_API_KEY") ?? env("ANTHROPIC_AUTH_TOKEN")),
    },
  };
}

export type Config = ReturnType<typeof config>;
