// Secrets never stored: before any event, message or tool result is
// written, every exact value the worker handed to an agent, and every
// common key shape, is replaced by `[redacted …last4]`. So an agent running
// `env`, or a verbose error, cannot copy a credential into the store.
//
// Redaction always comes before any cut: a value cut in two is two strings
// nothing recognizes. Callers that must shorten text use `cut()`,
// `shorten()` or `splitPoint()`, never a plain truncation of raw text.

const mask = (value: string) => `[redacted …${value.slice(-4)}]`;

// Common key shapes: Anthropic and OpenAI (`sk-…`, which covers Claude's
// `sk-ant-oat01-…` login token), GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`,
// `ghr_`, `github_pat_`), xAI (`xai-`), Google (`AIza…`), and bearer headers.
const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxai-[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
];
const BEARER = /\b(bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
/** The start of a key shape, which a cut must never leave behind. */
const SHAPE_START = /(\bsk-|\bgh[pousr]_|\bgithub_pat_|\bxai-|\bAIza|\bbearer\s+)[A-Za-z0-9._~+/=-]*$/gi;
/** Characters a key shape is made of: a run of them is held back as one. */
const KEY_RUN = /[A-Za-z0-9._~+/=-]+$/g;

/** Values shorter than this are not treated as secrets (they would mask
 * ordinary words). Every credential the worker issues is far longer. */
export const MIN_SECRET_LENGTH = 12;
/** How far past a cut a key shape may still be recognized: a reader keeps
 * at least this much beyond the cut before redacting. No real key is
 * longer; a run of key characters past it is cut like any other text. */
const SHAPE_REACH = 1024;

/** Where `pattern` (one of the two above: they end in `$`, and carry `g`
 * so a search can start part way) matches at the end of `text`, looked for
 * in the last `reach` characters only; -1 when it does not. Over the whole
 * text such a pattern takes time that grows with the square of its length
 * (34 s on 512 KB), and nothing longer than `reach` is a key. Starting the
 * search there, rather than on a slice, lets `\b` see the character
 * before. */
function endMatch(pattern: RegExp, text: string, reach: number): number {
  pattern.lastIndex = Math.max(0, text.length - reach);
  return pattern.exec(text)?.index ?? -1;
}

export class Redactor {
  private secrets = new Set<string>();
  private longest = 0;
  /** Remember a value handed to an agent (a login token, a key, an MCP
   * bearer token). */
  add(value: string | null | undefined) {
    if (value && value.length >= MIN_SECRET_LENGTH) {
      this.secrets.add(value);
      this.longest = Math.max(this.longest, value.length);
    }
  }
  /** How much text past a cut must be read before redacting, so that any
   * credential across the cut is seen whole: the longest handed-out value,
   * or the longest key shape recognized, in characters. */
  get reach(): number {
    return Math.max(SHAPE_REACH, this.longest);
  }
  /** Whether text holds any exact value handed to an agent. */
  holdsSecret(input: string): boolean {
    for (const secret of this.secrets) if (input.includes(secret)) return true;
    return false;
  }
  /** Whether raw bytes (a Git blob, say) hold any value handed to an agent,
   * byte for byte as UTF-8. Exact bytes only: the same value encoded
   * another way (base64, UTF-16, split across lines) is not found. */
  holdsSecretBytes(input: Buffer): boolean {
    for (const secret of this.secrets) if (input.includes(Buffer.from(secret, "utf8"))) return true;
    return false;
  }
  text(input: string): string {
    let out = input;
    // Longest first, so a secret that contains another is masked whole.
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length))
      if (out.includes(secret)) out = out.split(secret).join(mask(secret));
    for (const pattern of PATTERNS) out = out.replace(pattern, (m) => mask(m));
    return out.replace(BEARER, (_m, prefix: string, value: string) =>
      value.startsWith("[redacted") ? `${prefix}${value}` : `${prefix}${mask(value)}`,
    );
  }
  /** Redacted text cut to `maxBytes`, with nothing of a credential left at
   * the cut: a trailing start of a handed-out value or of a key shape is
   * dropped. Read past the cut (by `reach`) before calling this, so a
   * credential across the cut is masked whole. */
  cut(input: string, maxBytes: number): { text: string; truncated: boolean } {
    const redacted = this.text(input);
    if (Buffer.byteLength(redacted, "utf8") <= maxBytes) return { text: redacted, truncated: false };
    let kept = cutBytes(redacted, maxBytes);
    for (const secret of this.secrets)
      for (let n = Math.min(secret.length - 1, kept.length); n >= 4; n--)
        if (kept.endsWith(secret.slice(0, n))) {
          kept = kept.slice(0, -n);
          break;
        }
    return { text: this.dropShapeStart(kept), truncated: true };
  }
  /** Redacted text shortened to `maxChars` characters (a summary line),
   * with the same care at the cut as `cut()`. */
  shorten(input: string, maxChars: number): string {
    const redacted = this.text(input);
    if (redacted.length <= maxChars) return redacted;
    let kept = redacted.slice(0, maxChars - 1);
    for (const secret of this.secrets)
      for (let n = Math.min(secret.length - 1, kept.length); n >= 4; n--)
        if (kept.endsWith(secret.slice(0, n))) {
          kept = kept.slice(0, -n);
          break;
        }
    return `${this.dropShapeStart(kept)}…`;
  }
  /** Text without a trailing start of a key shape. */
  private dropShapeStart(text: string): string {
    const at = endMatch(SHAPE_START, text, this.reach);
    return at < 0 ? text : text.slice(0, at);
  }
  /**
   * Where raw streamed text may be divided into a row written now and a
   * remainder kept for later, at or before `at`, so that nothing a later
   * redaction would recognize is split: a handed-out value across the
   * point moves it back to the value's start; a trailing start of one
   * (still arriving) is kept whole; a trailing run of key characters is
   * kept too, up to `reach` of them. The part before the point may then be
   * redacted and written on its own. Returns 0 when nothing can be written
   * yet.
   */
  splitPoint(text: string, at: number): number {
    let cut = Math.min(at, text.length);
    const start = endMatch(KEY_RUN, text, this.reach);
    const run = start < 0 ? 0 : text.length - start;
    if (run && text.length - run < cut) cut = Math.max(text.length - run, text.length - this.reach, 0);
    for (let changed = true; changed && cut > 0; ) {
      changed = false;
      for (const secret of this.secrets) {
        // A whole value across the point.
        const idx = text.lastIndexOf(secret, cut - 1);
        if (idx >= 0 && idx + secret.length > cut) {
          cut = idx;
          changed = true;
        }
        // The start of a value at the end, its rest still to come.
        for (let n = Math.min(secret.length - 1, text.length); n >= 1; n--)
          if (text.endsWith(secret.slice(0, n))) {
            if (text.length - n < cut) {
              cut = text.length - n;
              changed = true;
            }
            break;
          }
      }
    }
    return Math.max(cut, 0);
  }
  /** Every string inside a JSON-shaped value. */
  value<T>(input: T): T {
    if (typeof input === "string") return this.text(input) as T;
    if (Array.isArray(input)) return input.map((v) => this.value(v)) as T;
    if (input && typeof input === "object")
      return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, this.value(v)])) as T;
    return input;
  }
}

/** The first `maxBytes` of UTF-8, cut on a character boundary. */
export function cutBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/** Cut text to `maxBytes` of UTF-8, saying how much was left out. Only for
 * text that is already redacted (a cut can leave part of a credential). */
export function truncateBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false };
  const kept = cutBytes(text, maxBytes);
  return { text: `${kept}\n… truncated, ${bytes - Buffer.byteLength(kept, "utf8")} bytes omitted`, truncated: true };
}
