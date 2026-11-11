import path from "node:path";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function num(name: string, fallback: number): number {
  const v = Number(env(name));
  return Number.isFinite(v) ? v : fallback;
}

/**
 * The password to the owner's page, where players are labelled, agent keys are
 * managed and the judge is retrained. Outside production there is a default so
 * local runs need no setup; in production there is none.
 */
export function ownerPassword(): string | undefined {
  return env("OWNER_PASSWORD") ?? (process.env.NODE_ENV === "production" ? undefined : "owner-dev");
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
    /** What a player pays to play, in whole tokens. 0 = free. */
    entryFeeTokens: num("ENTRY_FEE_TOKENS", 0),
    tokenSymbol: env("TOKEN_SYMBOL") ?? (paymentMode === "mock" ? "PLAY" : "TOKEN"),
    /** "off" removes the Bot Hunter rounds from players' games. */
    hunting: (env("BOT_HUNTER") ?? "on") as "on" | "off",
    /** What a player wins for being judged human, and what each hunting round they clear adds, in order. */
    humanPrizeTokens: num("HUMAN_PRIZE_TOKENS", 20),
    huntRoundPrizes: (env("HUNT_ROUND_PRIZES") ?? "20,40,60,80,120,160").split(",").map((x) => Number(x.trim()) || 0),
    /** How many prizes a day one person may win on the human side. 0 means no limit. */
    prizesPerPerson: num("PRIZES_PER_PERSON", 0),
    /** How many games a day one network address may start on the human side: a brake on floods, not on players. 0 means no limit. */
    gamesPerAddress: num("HUMAN_GAMES_PER_ADDRESS", 100),
    /** What an agent pays per run, and what it wins if the judge takes it for human. */
    agentFeeTokens: num("AGENT_FEE_TOKENS", 100),
    agentPrizeTokens: num("AGENT_PRIZE_TOKENS", 1000),
    /** Ceiling on agent runs per day across all keys. */
    agentDailyCap: num("AGENT_DAILY_CAP", 500),
    /** The behaviour model retrains itself once this many new labelled runs have come in. */
    retrainEvery: num("RETRAIN_EVERY", 10),
    /** ...or sooner, once it has been fooled this many times since it was last trained. */
    retrainAfterLosses: num("RETRAIN_AFTER_LOSSES", 3),
    /** How long a player has to finish after entering. */
    sessionMinutes: num("SESSION_MINUTES", 30),
    questionSalt: env("QUESTION_SALT") ?? "",
    /** "llm": the judge model writes each player's questions live. "bank": drawn at random from the built-in bank. */
    questionSource: (env("QUESTION_SOURCE") ?? "llm") as "bank" | "llm",
    solana: {
      cluster,
      rpcUrl: env("SOLANA_RPC_URL") ?? `https://api.${cluster}.solana.com`,
      mint: env("TOKEN_MINT"),
      treasury: env("TREASURY_WALLET"),
    },
    /** Database storage for serverless hosting. Unset = files under dataDir. */
    supabase: {
      url: env("SUPABASE_URL")?.replace(/\/+$/, ""),
      key: env("SUPABASE_PUBLISHABLE_KEY"),
      secret: env("STORE_SECRET"),
    },
    judge: {
      model: env("JUDGE_MODEL") ?? "claude-opus-5-5",
      /** Model that writes the questions. Players wait on it between questions, so speed matters here. */
      questionModel: env("QUESTION_MODEL") ?? env("JUDGE_MODEL") ?? "claude-opus-5-5",
      effort: (env("JUDGE_EFFORT") ?? "medium") as "low" | "medium" | "high",
      /** The LLM judge runs when Anthropic credentials are present, unless switched off. */
      llmEnabled:
        env("JUDGE_LLM") !== "off" && Boolean(env("ANTHROPIC_API_KEY") ?? env("ANTHROPIC_AUTH_TOKEN")),
    },
  };
}

export type Config = ReturnType<typeof config>;
