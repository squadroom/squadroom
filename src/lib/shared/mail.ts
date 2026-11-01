import { createHash } from "node:crypto";
import { setting } from "../../config/server-env.ts";

// Owner e-mail through Resend, for the Console: one idempotency key per
// incident, every attempt with the same key, backoff up to an hour for 24
// hours. Callers render fixed wording; an e-mail never carries
// model-written text.

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface MailSettings {
  apiKey: string;
  from: string;
  to: string;
  /** Public origin for links, or null (links omitted). */
  origin: string | null;
}

/** Email is on only when the provider key, sender and owner address are all
 * set (server-only configuration; never from the page). */
export function mailSettings(env: Record<string, string | undefined>): MailSettings | null {
  const apiKey = setting(env, "CONSOLE_RESEND_API_KEY")?.trim();
  const from = setting(env, "CONSOLE_MAIL_FROM")?.trim();
  const to = setting(env, "CONSOLE_NOTIFY_EMAIL")?.trim();
  if (!apiKey || !from || !to) return null;
  const rawOrigin = setting(env, "SERVER_PUBLIC_ORIGIN")?.trim();
  let origin: string | null = null;
  if (rawOrigin) {
    const url = new URL(rawOrigin);
    if (!/^https?:$/.test(url.protocol) || url.origin !== rawOrigin.replace(/\/$/, ""))
      throw new Error("SERVER_PUBLIC_ORIGIN must be an origin such as https://squadroom.example.");
    origin = url.origin;
  }
  return { apiKey, from, to, origin };
}

export type SendResult =
  | { ok: true }
  | { ok: false; retryable: boolean; status: number | null };

/** The same key for every attempt of one incident, so the provider sends it
 * once (Resend keeps idempotency keys for 24 hours, the retry window). */
export function idempotencyKey(key: string): string {
  return `squadroom-${createHash("sha256").update(key).digest("hex").slice(0, 48)}`;
}

/** Resend's HTTPS API with fetch, no SDK. Only the status code is kept from a
 * failure; the provider's error text is never stored or shown. */
export async function sendWithResend(
  settings: MailSettings,
  key: string,
  email: RenderedEmail,
  fetcher: typeof fetch = fetch,
): Promise<SendResult> {
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey(key),
      },
      body: JSON.stringify({
        from: settings.from,
        to: [settings.to],
        subject: email.subject,
        text: email.text,
        html: email.html,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    // Only the status is used; dispose of the body so the connection is
    // released (and the provider's text is never read).
    await response.body?.cancel().catch(() => {});
    if (response.ok) return { ok: true };
    // 409 (a concurrent request with the same key), 429 and 5xx are
    // transient; anything else needs the owner's configuration. Every
    // failure is retried within the window anyway, in case it is fixed.
    return {
      ok: false,
      retryable: response.status === 409 || response.status === 429 || response.status >= 500,
      status: response.status,
    };
  } catch {
    return { ok: false, retryable: true, status: null };
  }
}

/** Retry window and backoff: 1, 2, 4 … minutes, at most an hour apart,
 * for 24 hours; then the row is marked failed and the page shows it. */
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
export function nextAttemptDelay(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 60 * 60 * 1000);
}

/** A queued e-mail's delivery state, as the Console's mail queue keeps it. */
export interface QueuedMail {
  key: string;
  createdAt: number;
  attempts: number;
  lastStatus: number | null;
}
export type DeliveryOutcome =
  | { sent: true; at: number }
  | { sent: false; at: number; status: number | null; nextAttemptAt: number | null };

/** Send due rows one at a time: the same idempotency key on every
 * attempt, backoff up to an hour, failed after 24 hours. `leading` is
 * checked before each row; `record` is the caller's fenced write. */
export async function deliverDue<R extends QueuedMail>(
  rows: R[],
  o: {
    settings: MailSettings;
    now: () => number;
    render: (row: R) => RenderedEmail;
    record: (key: string, outcome: DeliveryOutcome) => void;
    leading: () => boolean;
    send?: typeof sendWithResend;
    fetcher?: typeof fetch;
    warn?: (info: { status: number | null; attempts: number; final: boolean }) => void;
  },
): Promise<void> {
  const send = o.send ?? sendWithResend;
  for (const row of rows) {
    if (!o.leading()) return;
    // Past the window, Resend may have forgotten the idempotency key: a
    // new request could send a duplicate. Mark it failed without sending.
    if (o.now() - row.createdAt >= RETRY_WINDOW_MS) {
      o.record(row.key, { sent: false, at: o.now(), status: row.lastStatus, nextAttemptAt: null });
      continue;
    }
    const result = await send(o.settings, row.key, o.render(row), o.fetcher);
    const at = o.now();
    if (result.ok) {
      o.record(row.key, { sent: true, at });
      continue;
    }
    const deadline = row.createdAt + RETRY_WINDOW_MS;
    const expired = at >= deadline;
    o.record(row.key, {
      sent: false,
      at,
      status: result.status,
      // Never beyond the window: at the deadline the row is marked failed
      // (without another send) on its next pass.
      nextAttemptAt: expired ? null : Math.min(at + nextAttemptDelay(row.attempts + 1), deadline),
    });
    o.warn?.({ status: result.status, attempts: row.attempts + 1, final: expired });
  }
}
