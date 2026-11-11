/** Ground truth for a participant. The judge never sees this before scoring. */
export type Kind = "human" | "agent";

/**
 * What a question asks for: typed words, a drawing, or a mini-game.
 * "tap": tap the moment a light comes on, several times. "hold": hold a button
 * down for a stated time with no clock to go by. "aim": hit dots as they appear.
 * "beat": watch a light pulse, then tap the same beat back. "recall": watch
 * four pads light in some order, then press them in that order.
 */
export type QuestionKind = "text" | "draw" | "tap" | "hold" | "aim" | "beat" | "recall";

export type Device = "phone" | "tablet" | "desktop";

/** One step of a game: a question to answer, or a Bot Hunter round. */
/**
 * "fresh": a question about the player's own life. "wild": an imaginative one.
 * "followup": about their last answer. "game": a mini-game or a drawing.
 * "draw" is an older name for a drawing step.
 */
export type StepKind = "fresh" | "wild" | "followup" | "game" | "draw" | "hunt";

/**
 * How one answer was produced, in the terms the judge itself works from. Shown
 * beside each answer in a hunt so the hunter has the same kind of evidence.
 */
export interface Evidence {
  device: Device | "unknown";
  /** Time from seeing the question to the first keystroke. */
  startDelayMs: number | null;
  /** Time from the first keystroke to the last. */
  writingMs: number | null;
  charsPerSecond: number | null;
  /** How uneven the gaps between keystrokes were: near 0 is metronomic, 0.5 and up is ordinary typing. */
  rhythm: number | null;
  /** Stops of more than a second or so mid-answer. */
  pauses: number;
  corrections: number;
  /** Share of the answer that was pasted in rather than typed, 0 to 1. */
  pasted: number;
  /** How often one key went down before the last came up, 0 to 1. Fingers do this; scripts mostly don't. */
  keyOverlap: number | null;
  /** The pause before each keystroke, in ms, in order: the rhythm of the typing, drawn for the hunter as a strip. */
  gaps?: number[];
  /** The longest stop mid-answer. */
  longestPauseMs?: number | null;
  /** How long keys were held down, on average. */
  keyHoldMs?: number | null;
  /** Whether the mouse or a finger moved about while the answer was being written. */
  pointerMoved?: boolean | null;
  /** How many times they left the page or the answer box mid-answer. */
  leftPage?: number;
  /** From seeing the question to sending the answer. */
  totalMs?: number | null;
}

/**
 * One Bot Hunter round: a real person's answer to a question next to a
 * machine-written answer to the same question. The player picks the person.
 */
export interface Hunt {
  id: string;
  /** 1 = a generic machine answer, 2 = a casual one, 3 = one imitating this particular person. */
  level: number;
  prompt: string;
  options: [string, string];
  /** How each option was produced: recorded for the person, forged by the house for the machine. */
  evidence?: [Evidence, Evidence];
  /** Which option the person wrote. Never sent to the player before they pick. */
  humanIndex: 0 | 1;
  /** Whose answer the human option is. */
  sourceEntryId: string;
  servedAt: number;
  pick?: 0 | 1;
  correct?: boolean;
  answeredAt?: number;
  /** The player's explanation of what gave the machine away, and how they typed it. */
  reason?: string;
  reasonFeatures?: AnswerFeatures;
}

export interface Question {
  id: string;
  kind: QuestionKind;
  category: string;
  prompt: string;
  hint?: string;
  /** Text questions: a word or two is a natural answer to this one. Otherwise an answer that short is sent back. */
  shortOk?: boolean;
  /** Mini-games: how this one is set up. The server decides, so a script can't pick easy numbers. */
  game?: GameSpec;
  /**
   * A line addressed to machines, placed in the page where people can't see it.
   * A person never reads it; an agent reading the page's text does, and one
   * that obeys gives itself away.
   */
  note?: string;
  /** The phrase the note asks for. Kept on the server; never sent on its own. */
  canary?: string;
}

/** How a mini-game is set up. */
export interface GameSpec {
  /** Reaction game: how long each go waits before the light comes on, in ms. */
  waits?: number[];
  /** Timing game: how long to hold for, in ms, and how many tries. */
  holdMs?: number;
  tries?: number;
  /** Aim game: where each dot appears, as fractions of the play area's width and height; its radius in px; the wait before the next one, in ms. */
  targets?: [number, number][];
  radius?: number;
  gapMs?: number;
  /** Rhythm game: the gap between pulses in ms, how many pulses are shown, and how many taps are wanted back. */
  beatMs?: number;
  pulses?: number;
  beats?: number;
  /** Memory game: which of the four pads (0 to 3) light, in order, and how long each stays lit, in ms. */
  sequence?: number[];
  showMs?: number;
}

/** What the player did in a mini-game. */
export interface GamePlay {
  /** Reaction game: per go, ms from the light coming on to the tap. */
  taps?: number[];
  /** Reaction game: how many times they tapped before the light. */
  early?: number;
  /** Timing game: how long each hold lasted, in ms. */
  holds?: number[];
  /** Aim game: per dot, ms from it appearing to being hit, and how far from its centre the hit landed (0 = dead centre, 1 = its edge). */
  hits?: number[];
  offsets?: number[];
  /** Aim game: taps that landed outside the dot. */
  misses?: number;
  /** Rhythm game: the gaps between the player's taps, in ms. */
  beatGaps?: number[];
  /** Memory game: the pads pressed, in order, and the ms before each press (the first counted from the end of the showing). */
  picks?: number[];
  pickGaps?: number[];
}

// ---------------------------------------------------------------------------
// Raw telemetry wire format. Tuples keep payloads small. All times are
// milliseconds on the client's monotonic clock (performance.now()).
// ---------------------------------------------------------------------------

/** [time, phase (0 = down, 1 = up), KeyboardEvent.code, isTrusted] */
export type KeyEv = [t: number, phase: 0 | 1, code: string, trusted: 0 | 1];
/** [time, InputEvent.inputType, length of inserted data, value length after] */
export type InputEv = [t: number, inputType: string, dataLen: number, valueLen: number];
/** [time, clientX, clientY] */
export type PointerEv = [t: number, x: number, y: number];
/** [time down, time up, clientX, clientY] */
export type ClickEv = [tDown: number, tUp: number, x: number, y: number];
/** [time, on] */
export type FlagEv = [t: number, on: 0 | 1];
/** [time, x, y, pressure] */
export type StrokePoint = [t: number, x: number, y: number, pressure: number];

export interface ClientEnv {
  ua: string;
  webdriver: boolean;
  languages: string[];
  tz: string;
  screen: [number, number];
  viewport: [number, number];
  dpr: number;
  touchPoints: number;
  cores: number;
  plugins: number;
}

export interface AnswerTelemetry {
  v: 1;
  /** When the question became visible. */
  shownAt: number;
  /** When the answer was submitted. */
  submittedAt: number;
  keys: KeyEv[];
  inputs: InputEv[];
  pointer: PointerEv[];
  clicks: ClickEv[];
  /** Focus changes of the answer field. */
  focus: FlagEv[];
  /** Page visibility changes (1 = hidden). */
  hidden: FlagEv[];
  scrolls: number;
  touches: number;
  /** Draw questions only. */
  strokes?: StrokePoint[][];
  /** Mini-games only. */
  game?: GamePlay;
  env?: ClientEnv;
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

/** Per-answer measurements. `null` means "not measurable for this answer". */
export interface AnswerFeatures {
  kind: QuestionKind;
  len: number;
  insertCount: number;
  deleteCount: number;
  typedChars: number;
  pastedChars: number;
  ikiMedian: number | null;
  ikiCv: number | null;
  ikiEntropy: number | null;
  pauses: number;
  keyCount: number;
  dwellMean: number | null;
  dwellCv: number | null;
  rolloverRatio: number | null;
  untrustedRatio: number;
  firstInputDelay: number | null;
  composeMs: number | null;
  clientMs: number;
  pointerSamples: number;
  pointerStraightness: number | null;
  pointerSpeedCv: number | null;
  pointerJitter: number | null;
  clicks: number;
  clickDwellMean: number | null;
  touches: number;
  focusLoss: number;
  hiddenCount: number;
  drawStrokes: number;
  drawPoints: number;
  drawMs: number | null;
  drawSpeedCv: number | null;
  drawJitter: number | null;
  /** Reaction game: typical reaction, how much it varied, and taps made too early. Absent on answers from before the games existed. */
  tapMedian?: number | null;
  tapCv?: number | null;
  tapEarly?: number;
  /** Timing game: how far off the target the holds were on average (0.1 = 10%), and how much they varied. */
  holdError?: number | null;
  holdCv?: number | null;
  /** Aim game: typical time to reach a dot, how much it varied, and how far off centre the hits landed on average (0 to 1). */
  aimMedian?: number | null;
  aimCv?: number | null;
  aimOffset?: number | null;
  /** Rhythm game: how far the gaps between taps were from the beat on average (0.1 = 10%), and how much they varied. */
  beatError?: number | null;
  beatCv?: number | null;
  /** Memory game: the share of the sequence got right, the typical gap between presses, and how much it varied. */
  recallRight?: number | null;
  recallMedian?: number | null;
  recallCv?: number | null;
}

/** Entry-level feature vector: what the behaviour model and the judge see. */
export type Features = Record<string, number | null>;

// ---------------------------------------------------------------------------
// Game records
// ---------------------------------------------------------------------------

export interface Round {
  /** UTC date, YYYY-MM-DD. */
  id: string;
  startsAt: number;
  endsAt: number;
  questions: Question[];
  questionSource: "bank" | "llm";
  createdAt: number;
}

export interface EntryPayment {
  mode: "mock" | "solana" | "waived";
  /** Whole tokens that count toward the pool. */
  amountTokens: number;
  amountRaw?: string;
  signature?: string;
  intentId?: string;
}

export interface EntryAnswer {
  questionId: string;
  text: string;
  answeredAt: number;
  /** Server-observed time between serving the question and receiving the answer. */
  serverLatencyMs: number;
  /** The answer contains the phrase only a machine was asked for. */
  trapped?: boolean;
  /** Mini-games: what the player did, in words, for the judge to read. */
  played?: string;
  /** Typed answers: the pause before each keystroke, in ms, in order. What a hunter is shown as the rhythm of the typing. */
  gaps?: number[];
  features: AnswerFeatures;
}

export interface JudgeResult {
  /** Final humanness score, 0-100. Higher = more human. */
  score: number;
  /** Rules + learned model over behaviour, 0-100. */
  behaviorScore: number;
  heuristicScore: number;
  /** Learned model P(human), 0-1, if a trained model exists. */
  modelProb?: number;
  /** LLM judge score, 0-100, if the LLM judge ran. */
  llmScore?: number;
  verdict: Kind;
  /** One line shown to the player. */
  quip: string;
  /** Private notes: rule hits and LLM tells. */
  reasons: string[];
  llmReasoning?: string;
  judgeModel?: string;
  /** Which version of the judging logic produced this (see JUDGE_VERSION). */
  judgeVersion?: string;
  /** When the behaviour model in use was trained, if one was. */
  behaviorModelTrainedAt?: number;
  scoredAt: number;
}

export interface Entry {
  id: string;
  roundId: string;
  handle: string;
  wallet?: string;
  createdAt: number;
  tokenHash: string;
  payment: EntryPayment;
  /** Set for sessions played in the training room. */
  cohortId?: string;
  /** Ground truth, when known: declared up front in the training room, or added later for a competition entry. */
  label?: Kind;
  /** Set for entries made with an agent key, competing for the bounty: which key. */
  agentKeyId?: string;
  /** Set when a trainer labelled this competition entry after the fact: the cohort that did it. */
  labelledBy?: string;
  /**
   * The questions this player has been asked so far. Every player gets their
   * own, written as they go, so nothing can be prepared in advance. (Entries
   * from before this was introduced have none and used the round's shared set.)
   */
  questions?: Question[];
  /** True when questions are being written one at a time for this player. */
  adaptive?: boolean;
  /** The order of this player's game: which steps are questions and which are hunts. */
  plan?: StepKind[];
  /** Bot Hunter rounds played so far. */
  hunts?: Hunt[];
  /** The judge took this player for a bot, so their game doesn't count: no board, no prize. */
  cancelled?: boolean;
  /** What caused a cancellation, for the owner. Players are only told that it happened. */
  cancelReason?: string;
  /**
   * One-way hashes of who is playing, used to limit games and prizes per
   * person: the network address, a cookie set in the browser, and the make-up
   * of the machine (screen, timezone, languages and so on).
   */
  addressHash?: string;
  deviceHash?: string;
  machineHash?: string;
  /** Players who signed in: a one-way hash of their Google account id. */
  player?: string;
  /** Made with the house's own agent key: never in line for a prize. */
  house?: boolean;
  /** What this entry won, if anything. */
  prize?: Prize;
  /** What it would have won, had there been an address to pay or had that address not already won today. */
  missedPrize?: { tokens: number; why: "no_address" | "already_won" };
  /** How many answers were sent back for breaking the rules of play. */
  rejections?: number;
  /** Players whose game was broken off for breaking the rules: where that leaves their account. */
  strike?: { count: number; limit: number; banned: boolean };
  /** Agents that fooled the judge: the questions put to them afterwards, and what they said. */
  debrief?: Debrief;
  prizeEligible: boolean;
  status: "playing" | "scoring" | "scored";
  /** Which wording of the data notice this player was shown when they entered. */
  consent?: string;
  /** What they played on, as far as the browser reports. */
  device?: Device;
  /** Index of the question currently being answered. */
  progress: number;
  servedAt: number[];
  answers: EntryAnswer[];
  env?: ClientEnv;
  userAgent?: string;
  features?: Features;
  result?: JudgeResult;
}

export interface PaymentIntent {
  id: string;
  wallet: string;
  handle: string;
  memo: string;
  amountRaw: string;
  createdAt: number;
  usedByEntry?: string;
}

export interface Payout {
  winnerEntryId: string;
  winnerHandle: string;
  winnerWallet?: string;
  amountTokens: number;
  signature?: string;
  settledAt: number;
  dryRun: boolean;
}

/**
 * What an agent that fooled the judge owes afterwards: how it did it, answers
 * to what the judge wants to know, and its code. Its prize waits on this.
 */
export interface Debrief {
  /** What the judge asks about this run. */
  questions: string[];
  askedAt: number;
  answeredAt?: number;
  /** In the builder's or agent's own words: what it did to pass. */
  explanation?: string;
  /** One answer per question. */
  answers?: string[];
  /** The agent's code, or where to read it. */
  code?: string;
  /** Short notes for the judge on catching a run like this, distilled from the above. */
  lessons?: string[];
}

export interface Prize {
  tokens: number;
  /** "hunter": a player, for how far they got. "fooled": an agent the judge took for human. */
  reason: "hunter" | "fooled";
  wonAt: number;
  paid?: boolean;
  signature?: string;
}

/** A builder's licence to enter agents. */
export interface AgentKey {
  id: string;
  /** What the board calls this builder. */
  name: string;
  /** Where a bounty would be paid. Also what makes a builder one builder: one key per wallet. */
  wallet: string;
  secretHash: string;
  createdAt: number;
  disabled?: boolean;
  /** The house's own key, for its test agents. Runs with it can't win the bounty. */
  house?: boolean;
}

export interface RoundState {
  round: Round;
  entries: Record<string, Entry>;
  intents: Record<string, PaymentIntent>;
  /** Payment signature -> entry id. Prevents replaying one payment. */
  signatures: Record<string, string>;
  payout?: Payout;
  /** The agent bounty for this round, once settled. */
  bountyPayout?: Payout;
}

/** One line of data/training/<round>.jsonl. */
export interface TrainingExample {
  entryId: string;
  roundId: string;
  recordedAt: number;
  label: Kind;
  /** The cohort that vouches for the label. */
  cohortId: string;
  /**
   * How the label is known. "session": an agent, known by its key. "auto": a
   * player the judge was confident about, taken to be human. "board": an older
   * entry the owner labelled by hand.
   */
  source?: "session" | "board" | "auto" | "seed";
  handle: string;
  /** Who this was, as far as the game can tell them from others: a hash of their account, or else of their browser's cookie. */
  player?: string;
  device?: Device;
  consent?: string;
  questions: Question[];
  answers: { questionId: string; text: string; serverLatencyMs: number; features: AnswerFeatures; played?: string; gaps?: number[] }[];
  features: Features;
  env?: ClientEnv;
  /** What the judge said before the label was revealed. */
  judge: JudgeResult;
  judgeCorrect: boolean;
  /** Agents that fooled the judge: what they said about how. */
  debrief?: Debrief;
  /** Raw per-question telemetry, for retraining with new features later. */
  telemetry: Record<string, AnswerTelemetry>;
}
