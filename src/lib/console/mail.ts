import { escapeHtml, type QueuedMail, type RenderedEmail } from "../shared/mail.ts";
import type { NeedsLike } from "./notify.ts";

// The Console's e-mail to the owner: fixed templates, queued in
// `console_mail` (one row per incident key) and sent by the Console worker
// through the shared Resend code. No model-written text, no raw error.

export type ConsoleMail =
  /** Hosted sign-in paused after 5 wrong codes. */
  | { kind: "signin_locked"; minutes: number }
  /** The Console's nightly backup failed: at most one a UTC day. */
  | { kind: "backup_failed" }
  /** Needs you items waited 15 minutes: counts only. */
  | { kind: "needs_you"; counts: NeedsCounts };

/** Needs you by kind, as the e-mail counts them. */
export interface NeedsCounts {
  approvals: number;
  questions: number;
  interrupted: number;
  messages: number;
  paused: number;
  notes: number;
}

const NEEDS_WORDS: [keyof NeedsCounts, string, string][] = [
  ["approvals", "approval", "approvals"],
  ["questions", "question", "questions"],
  ["interrupted", "interrupted message", "interrupted messages"],
  ["messages", "unfinished team message", "unfinished team messages"],
  ["paused", "pause", "pauses"],
  ["notes", "note", "notes"],
];

/** Needs you counted by kind (pure). */
export const needsCounts = (needs: NeedsLike): NeedsCounts => ({
  approvals: needs.requests.filter((r) => r.kind === "permission").length,
  questions: needs.requests.filter((r) => r.kind === "question").length,
  interrupted: needs.interrupted.length,
  messages: needs.messages?.length ?? 0,
  paused: needs.paused?.length ?? 0,
  notes: needs.notices?.length ?? 0,
});

/** How long an item waits before it is e-mailed. */
export const NEEDS_MAIL_WAIT_MS = 15 * 60_000;

/** Which Needs you items to e-mail now. `firstSeen` is when the worker
 * first saw each item and `mailed` the items already in an e-mail; both
 * are updated in place: items that left are forgotten in both (a tab
 * paused again is a new incident, with the same key), new ones start now.
 * Due when an item not yet mailed has waited NEEDS_MAIL_WAIT_MS; then
 * every current item is in it. */
export function needsMailDue(keys: readonly string[], firstSeen: Map<string, number>, mailed: Set<string>, now: number): string[] | null {
  const current = new Set(keys);
  for (const key of [...firstSeen.keys()]) if (!current.has(key)) firstSeen.delete(key);
  for (const key of [...mailed]) if (!current.has(key)) mailed.delete(key);
  for (const key of keys) if (!firstSeen.has(key)) firstSeen.set(key, now);
  return keys.some((k) => !mailed.has(k) && now - firstSeen.get(k)! >= NEEDS_MAIL_WAIT_MS) ? [...keys] : null;
}

/** "2 approvals, 1 question" (pure). */
export const needsCountsText = (counts: NeedsCounts): string =>
  NEEDS_WORDS.filter(([k]) => counts[k] > 0)
    .map(([k, one, many]) => `${counts[k]} ${counts[k] === 1 ? one : many}`)
    .join(", ");

/** The incident key of a Needs you e-mail: at most one a UTC hour. */
export const needsYouKey = (now: number) => `needs_you:${new Date(now).toISOString().slice(0, 13)}`;

export interface ConsoleMailRow extends QueuedMail {
  mail: ConsoleMail;
  status: "pending" | "sent" | "failed";
  nextAttemptAt: number;
}

/** The incident key of a failed backup: one e-mail a UTC day. */
export const backupFailedKey = (now: number) => `console_backup_failed:${new Date(now).toISOString().slice(0, 10)}`;

/** Fixed wording and the link `<origin>/console` (or none without an origin). */
export function renderConsoleMail(mail: ConsoleMail, origin: string | null): RenderedEmail {
  const [subject, detail] =
    mail.kind === "signin_locked"
      ? [
          `Sign-in paused for ${mail.minutes} minutes after 5 wrong codes`,
          "Someone who passed the GitHub step entered 5 wrong codes. If it was not you, secure your GitHub account. The emergency sign-in on the server still works.",
        ]
      : mail.kind === "backup_failed"
        ? [
            "Console backup failed",
            "Tonight's copy of the Console's database did not reach the backup folder. Check the backup folder on the server; the Console worker tries again every hour.",
          ]
        : [
            `The Console needs you: ${needsCountsText(mail.counts)}`,
            "Agents have waited at least 15 minutes for you. At most one of these e-mails is sent an hour; switch them off in Settings › Notifications.",
          ];
  const link = origin ? `${origin}/console` : null;
  const action = link ? `Open the Console: ${link}` : "Open the Console to see what it needs.";
  const footer = "Sent by Squadroom. Its e-mails never contain model-written text; the details are in the Console.";
  return {
    subject,
    text: `${subject}\n\n${detail}\n\n${action}\n\n${footer}\n`,
    html: `<p>${escapeHtml(subject)}</p><p>${escapeHtml(detail)}</p><p>${
      link ? `<a href="${escapeHtml(link)}">Open the Console</a>` : escapeHtml(action)
    }</p><p style="color:#666;font-size:12px">${escapeHtml(footer)}</p>`,
  };
}
