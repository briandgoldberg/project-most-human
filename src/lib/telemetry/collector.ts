import type { AnswerTelemetry, ClientEnv, StrokePoint } from "../types";

/**
 * Records how one answer is produced in the browser: when keys go down and
 * up, what kind of edit each input was, where the pointer travels, and whether
 * the player looked away. One collector per question.
 *
 * Players are told about this before they enter. Nothing is recorded outside
 * a question.
 */

const POINTER_MIN_GAP_MS = 16;
const MAX = { keys: 6000, inputs: 4000, pointer: 3000, clicks: 300, flags: 200 };

const now = () => Math.round(performance.now());

function readEnv(): ClientEnv {
  return {
    ua: navigator.userAgent,
    webdriver: navigator.webdriver === true,
    languages: [...(navigator.languages ?? [])],
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
    screen: [screen.width, screen.height],
    viewport: [window.innerWidth, window.innerHeight],
    dpr: window.devicePixelRatio ?? 1,
    touchPoints: navigator.maxTouchPoints ?? 0,
    cores: navigator.hardwareConcurrency ?? 0,
    plugins: navigator.plugins?.length ?? 0,
  };
}

export class Collector {
  private data: AnswerTelemetry = {
    v: 1,
    shownAt: now(),
    submittedAt: 0,
    keys: [],
    inputs: [],
    pointer: [],
    clicks: [],
    focus: [],
    hidden: [],
    scrolls: 0,
    touches: 0,
  };
  private cleanups: (() => void)[] = [];
  private lastPointerT = -Infinity;
  private pointerDownAt: number | null = null;
  private pasteLen = 0;
  private prevValueLen = 0;

  private on<K extends keyof DocumentEventMap>(
    target: Document | HTMLElement,
    type: K,
    handler: (e: DocumentEventMap[K]) => void,
  ) {
    target.addEventListener(type, handler as EventListener, { passive: true, capture: true });
    this.cleanups.push(() => target.removeEventListener(type, handler as EventListener, { capture: true }));
  }

  /** Start recording page-level activity. */
  start(): this {
    const d = this.data;
    this.on(document, "pointermove", (e) => {
      const t = now();
      if (t - this.lastPointerT < POINTER_MIN_GAP_MS || d.pointer.length >= MAX.pointer) return;
      this.lastPointerT = t;
      d.pointer.push([t, Math.round(e.clientX), Math.round(e.clientY)]);
    });
    this.on(document, "pointerdown", () => {
      this.pointerDownAt = now();
    });
    this.on(document, "pointerup", (e) => {
      if (this.pointerDownAt === null || d.clicks.length >= MAX.clicks) return;
      d.clicks.push([this.pointerDownAt, now(), Math.round(e.clientX), Math.round(e.clientY)]);
      this.pointerDownAt = null;
    });
    this.on(document, "touchstart", () => {
      d.touches++;
    });
    this.on(document, "scroll", () => {
      d.scrolls++;
    });
    this.on(document, "visibilitychange", () => {
      if (d.hidden.length < MAX.flags) d.hidden.push([now(), document.hidden ? 1 : 0]);
    });
    return this;
  }

  /** Record typing in the answer field. */
  attachField(field: HTMLTextAreaElement): this {
    const d = this.data;
    this.prevValueLen = field.value.length;
    this.on(field, "keydown", (e) => {
      if (d.keys.length < MAX.keys) d.keys.push([now(), 0, e.code, e.isTrusted ? 1 : 0]);
    });
    this.on(field, "keyup", (e) => {
      if (d.keys.length < MAX.keys) d.keys.push([now(), 1, e.code, e.isTrusted ? 1 : 0]);
    });
    this.on(field, "paste", (e) => {
      this.pasteLen = e.clipboardData?.getData("text").length ?? 0;
    });
    this.on(field, "input", (e) => {
      if (d.inputs.length >= MAX.inputs) return;
      const ev = e as InputEvent;
      const valueLen = field.value.length;
      const inputType = ev.inputType ?? "";
      const grew = Math.max(0, valueLen - this.prevValueLen);
      const dataLen = inputType === "insertFromPaste" ? this.pasteLen || grew : (ev.data?.length ?? grew);
      d.inputs.push([now(), inputType, dataLen, valueLen]);
      this.prevValueLen = valueLen;
      this.pasteLen = 0;
    });
    this.on(field, "focus", () => {
      if (d.focus.length < MAX.flags) d.focus.push([now(), 1]);
    });
    this.on(field, "blur", () => {
      if (d.focus.length < MAX.flags) d.focus.push([now(), 0]);
    });
    return this;
  }

  /** Stop recording and return everything captured. */
  finish(strokes?: StrokePoint[][]): AnswerTelemetry {
    this.stop();
    return { ...this.data, submittedAt: now(), strokes, env: readEnv() };
  }

  stop(): void {
    for (const off of this.cleanups) off();
    this.cleanups = [];
  }
}
