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

/**
 * What signs the passes of signed-in players and scrambles their account ids.
 * Changing it signs everyone out and makes every player look new.
 */
export function sessionSecret(): string {
  const secret = env("SESSION_SECRET") ?? env("STORE_SECRET") ?? (process.env.NODE_ENV === "production" ? undefined : "dev-session-secret");
  if (!secret) throw new Error("SESSION_SECRET (or STORE_SECRET) is needed for Google sign-in");
  return secret;
}

function payoutHour(value: string | undefined): number | undefined {
  const hour = Number(value);
  return value !== undefined && Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : undefined;
}

/** What the payout job asks GitHub to make its token out to, so a token made for anything else is no use here. */
export const PAYOUT_AUDIENCE = "spot-the-bot-payouts";

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
    /** Which mini-games are in play, by kind (draw, tap, hold, aim, beat, recall). Empty = all of them. A way to bench one without a deploy. */
    miniGames: (env("MINI_GAMES") ?? "").split(",").map((k) => k.trim()).filter(Boolean),
    /** "off" removes the Bot Hunter rounds from players' games. */
    hunting: (env("BOT_HUNTER") ?? "on") as "on" | "off",
    /**
     * The Google OAuth client id for this site. When set, the human side needs a Google sign-in:
     * one account, one player. Unset, anyone can play and a browser cookie stands in for the account.
     */
    googleClientId: env("GOOGLE_CLIENT_ID"),
    /** How many games broken off for breaking the rules (pasting, automation and the like) get an account banned. */
    banAfterStrikes: num("BAN_AFTER_STRIKES", 3),
    /** A ceiling on Claude tokens (in and out) per day. Past it the game runs on its question bank and the behaviour judge alone. 0 = no ceiling. */
    llmDailyTokens: num("LLM_DAILY_TOKENS", 0),
    /** "on" lets a player be shown real answers they have already judged. Off by default: when they run out, they wait for more. */
    huntRepeats: (env("HUNT_REPEATS") ?? "off") as "on" | "off",
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
    /**
     * The hour of the day, UTC (0 to 23), at which the scheduled payout run starts. Set it once that run exists
     * (.github/workflows/payouts.yml) and players are told when their balance will be sent. Unset, prizes are paid
     * by hand and no time is promised.
     */
    payoutHourUtc: payoutHour(env("PAYOUT_HOUR_UTC")),
    /**
     * Who the payout job is. It runs on GitHub and proves it with a token GitHub signs for it; the website
     * then tells it what is owed and takes its word on what was paid. Unset, nothing can ask.
     */
    payoutJob: {
      /** "owner/name" of the repository whose workflow may ask. */
      repository: env("PAYOUT_REPOSITORY"),
      /** GitHub's own numbers for that repository and its owner, which survive renames. Checked when set. */
      repositoryId: env("PAYOUT_REPOSITORY_ID"),
      ownerId: env("PAYOUT_REPOSITORY_OWNER_ID"),
      workflow: env("PAYOUT_WORKFLOW") ?? ".github/workflows/payouts.yml",
      branch: env("PAYOUT_BRANCH") ?? "main",
      audience: env("PAYOUT_AUDIENCE") ?? PAYOUT_AUDIENCE,
    },
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
