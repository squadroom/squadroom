import { cutBytes, Redactor, truncateBytes } from "./redact.ts";
import { LIMITS, type EventBody, type EventKind } from "./types.ts";

// One turn's event stream into the store: streamed text and thinking are
// coalesced into one row per ~250 ms; every row is redacted; each tool
// output is cut to 64 KB; and a turn stores at most 4 MB, after which
// nothing more is written and the turn is stopped ("output limit").
//
// Redaction comes before every cut: a tool output is read past its limit by
// the redactor's reach and then cut by the redactor; a stream row's end is
// chosen by the redactor so that no credential is divided between two rows.

export interface EventSink {
  /** Write one row; returns the bytes it stored. */
  write(kind: EventKind, body: EventBody): number;
}

/** Room for one "… truncated" note past the tool-output limit, so a row
 * cut once is not cut again for its note. */
const NOTE_BYTES = 80;

export class TurnEvents {
  private buffer: { kind: "text" | "thinking"; text: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private bytes: number;
  /** Set once the turn reached its byte limit. */
  full = false;
  onFull: () => void = () => {};

  private sink: EventSink;
  private redactor: Redactor;
  private limits: Pick<typeof LIMITS, "coalesceMs" | "toolOutputBytes" | "turnBytes">;
  constructor(
    sink: EventSink,
    redactor: Redactor,
    startBytes = 0,
    limits: Pick<typeof LIMITS, "coalesceMs" | "toolOutputBytes" | "turnBytes"> = LIMITS,
  ) {
    this.sink = sink;
    this.redactor = redactor;
    this.limits = limits;
    this.bytes = startBytes;
  }

  /** Streamed text or thinking: buffered, written at most every ~250 ms. */
  stream(kind: "text" | "thinking", text: string) {
    if (this.full || !text) return;
    if (this.buffer && this.buffer.kind !== kind) this.flush();
    if (!this.buffer) this.buffer = { kind, text: "" };
    this.buffer.text += text;
    // A buffer never grows past one tool output's size before it is written
    // (keeping its tail, as a timed flush does).
    if (Buffer.byteLength(this.buffer.text) >= this.limits.toolOutputBytes) this.flush(true);
    else this.timer ??= setTimeout(() => this.flush(true), this.limits.coalesceMs);
  }
  /** Any other row; pending streamed text is written first, so order holds. */
  emit(kind: EventKind, body: EventBody) {
    this.flush();
    this.write(kind, body);
  }
  /** A tool's output, redacted and then cut to 64 KB. The redactor sees the
   * output past the cut by its reach, so a credential across the cut is
   * masked whole and nothing of one is left at the cut. */
  toolResult(id: string, text: string, error: boolean) {
    const limit = this.limits.toolOutputBytes;
    const seen = cutBytes(text, limit + 4 * this.redactor.reach);
    const cut = this.redactor.cut(seen, limit);
    const truncated = cut.truncated || seen.length < text.length;
    const omitted = Math.max(0, Buffer.byteLength(text, "utf8") - Buffer.byteLength(cut.text, "utf8"));
    this.emit("tool_result", { id, text: truncated ? `${cut.text}\n… truncated, ${omitted} bytes omitted` : cut.text, error });
  }
  /** Write the buffer. Every flush before the end of the stream (`keepTail`)
   * ends its row where the redactor says nothing can be divided: a handed-
   * out value or a key shape still arriving stays in the buffer, so it is
   * masked whole when its rest comes (the next flush, or close()). Only
   * emit() and close() write everything. */
  flush(keepTail = false) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.buffer;
    this.buffer = null;
    if (!pending?.text) return;
    let text = pending.text;
    if (keepTail) {
      const cut = this.redactor.splitPoint(text, text.length);
      // Nothing can be written yet: the next chunk's timer, or close(),
      // writes it.
      if (cut === 0) {
        this.buffer = pending;
        return;
      }
      if (cut < text.length) {
        this.buffer = { kind: pending.kind, text: text.slice(cut) };
        text = text.slice(0, cut);
      }
    }
    this.write(pending.kind, { text });
  }
  /** End of turn: write what is buffered. */
  close() {
    this.flush();
  }
  private write(kind: EventKind, body: EventBody) {
    if (this.full) return;
    const clean = this.redactor.value(body);
    const hasText = "text" in clean && typeof clean.text === "string";
    // The 64 KB cut is for tool output only, done by toolResult(); this is
    // the backstop for a redaction that lengthened a row past its note.
    // The agent's own text and thinking are bounded by the turn's allowance
    // alone.
    if (hasText && kind === "tool_result" && Buffer.byteLength(clean.text as string, "utf8") > this.limits.toolOutputBytes + NOTE_BYTES)
      (clean as { text: string }).text = truncateBytes(clean.text as string, this.limits.toolOutputBytes).text;
    // The turn's bound holds before the write: a row that would pass it is
    // cut to what remains (text) or not written, and the turn is then full.
    const remaining = this.limits.turnBytes - this.bytes;
    if (Buffer.byteLength(JSON.stringify(clean)) > remaining) {
      if (hasText && remaining > 512) {
        (clean as { text: string }).text = truncateBytes((clean as { text: string }).text, remaining - 512).text;
        this.bytes += this.sink.write(kind, clean);
      }
      return this.fill();
    }
    this.bytes += this.sink.write(kind, clean);
    if (this.bytes >= this.limits.turnBytes) this.fill();
  }
  /** The store's count for this turn moved on (its team payload):
   * the bound counts it too. */
  atLeast(stored: number) {
    if (stored <= this.bytes) return;
    this.bytes = stored;
    if (this.bytes >= this.limits.turnBytes) this.fill();
  }
  /** Count bytes stored elsewhere for this turn (a permission request's
   * input) against its bound. False when the turn is already full. */
  charge(bytes: number): boolean {
    if (this.full) return false;
    if (this.bytes + bytes > this.limits.turnBytes) {
      this.fill();
      return false;
    }
    this.bytes += bytes;
    return true;
  }
  private fill() {
    if (this.full) return;
    this.full = true;
    this.onFull();
  }
  get stored() {
    return this.bytes;
  }
}
