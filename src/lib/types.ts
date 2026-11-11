/** Ground truth for a participant. The judge never sees this before scoring. */
export type Kind = "human" | "agent";

export type QuestionKind = "text" | "draw";

export interface Question {
  id: string;
  kind: QuestionKind;
  category: string;
  prompt: string;
  hint?: string;
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
  /** Ground truth. Only present for training sessions. */
  label?: Kind;
  /** Training sessions get their own draw of questions instead of the day's set. */
  questions?: Question[];
  prizeEligible: boolean;
  status: "playing" | "scoring" | "scored";
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

export interface RoundState {
  round: Round;
  entries: Record<string, Entry>;
  intents: Record<string, PaymentIntent>;
  /** Payment signature -> entry id. Prevents replaying one payment. */
  signatures: Record<string, string>;
  payout?: Payout;
}

/** One line of data/training/<round>.jsonl. */
export interface TrainingExample {
  entryId: string;
  roundId: string;
  recordedAt: number;
  label: Kind;
  cohortId: string;
  handle: string;
  questions: Question[];
  answers: { questionId: string; text: string; serverLatencyMs: number; features: AnswerFeatures }[];
  features: Features;
  env?: ClientEnv;
  /** What the judge said before the label was revealed. */
  judge: JudgeResult;
  judgeCorrect: boolean;
  /** Raw per-question telemetry, for retraining with new features later. */
  telemetry: Record<string, AnswerTelemetry>;
}
