import type { ConsoleStore } from "../store.ts";
import { json, type Row } from "./rows.ts";
import type { ConsoleMail, ConsoleMailRow } from "../mail.ts";
import type { DeliveryOutcome } from "../../shared/mail.ts";

const DAY_MS = 24 * 60 * 60_000;
type Outcome = { id: number; kind: string; state: string; result: unknown };
const outcome = (r: Row): Outcome => ({ id: r.id as number, kind: r.kind as string, state: r.state as string, result: json(r.result) });

// Work the owner asks the worker for outside any turn: folder cleanup and
// connection checks; the store's backups; and the owner's e-mail queue.
export const upkeep = {
  /** A scan, or a delete of chosen keys; the worker runs it. */
  queueCleanup(this: ConsoleStore, kind: "scan" | "delete", keys: string[] = []): number {
    return this.insert("INSERT INTO console_cleanups (kind, keys, state, created_at) VALUES (?, ?, 'pending', ?)", kind, JSON.stringify(keys), this.now());
  },
  cleanup(this: ConsoleStore, id: number): Outcome | undefined {
    const r = this.get("SELECT * FROM console_cleanups WHERE id = ?", id);
    return r && outcome(r);
  },
  claimCleanup(this: ConsoleStore, epoch: number): { id: number; kind: "scan" | "delete"; keys: string[] } | undefined {
    const [r] = this.claimRows(epoch, "console_cleanups", "pending", 1);
    return r && { id: r.id as number, kind: r.kind as "scan" | "delete", keys: JSON.parse(r.keys as string) as string[] };
  },
  finishCleanup(this: ConsoleStore, epoch: number, id: number, state: "done" | "failed", result: unknown) {
    this.transaction(() => {
      this.run("UPDATE console_cleanups SET state = ?, result = ? WHERE id = ?", state, JSON.stringify(result), id);
      // Old scans and their results are not kept.
      this.run("DELETE FROM console_cleanups WHERE created_at < ?", this.now() - DAY_MS);
    }, epoch);
  },
  /** A cleanup an earlier worker was running fails visibly. */
  failEarlierCleanups(this: ConsoleStore, epoch: number) {
    this.write(epoch, "UPDATE console_cleanups SET state = 'failed', result = ? WHERE state = 'running'", JSON.stringify({ message: "The Console worker restarted during this cleanup. Run it again." }));
  },

  /** Check connection for an agent kind; the worker runs its probes. One
   * waiting check per kind: asking again returns it. */
  queueCheck(this: ConsoleStore, kind: string): number {
    return this.transaction(() => {
      this.run("DELETE FROM console_checks WHERE created_at < ? AND state != 'pending' AND state != 'running'", this.now() - DAY_MS);
      const open = this.get("SELECT id FROM console_checks WHERE kind = ? AND state IN ('pending', 'running') ORDER BY id LIMIT 1", kind);
      return open ? (open.id as number) : this.insert("INSERT INTO console_checks (kind, state, created_at) VALUES (?, 'pending', ?)", kind, this.now());
    });
  },
  /** The newest check of each kind, with its result. */
  latestChecks(this: ConsoleStore): Outcome[] {
    return this.all("SELECT * FROM console_checks WHERE id IN (SELECT MAX(id) FROM console_checks GROUP BY kind)").map(outcome);
  },
  claimCheck(this: ConsoleStore, epoch: number): { id: number; kind: string } | undefined {
    const [r] = this.claimRows(epoch, "console_checks", "pending", 1);
    return r && { id: r.id as number, kind: r.kind as string };
  },
  finishCheck(this: ConsoleStore, epoch: number, id: number, state: "done" | "failed", result: unknown) {
    this.write(epoch, "UPDATE console_checks SET state = ?, result = ? WHERE id = ?", state, JSON.stringify(result), id);
  },
  /** A check an earlier worker was running fails visibly. */
  failEarlierChecks(this: ConsoleStore, epoch: number) {
    this.write(
      epoch,
      "UPDATE console_checks SET state = 'failed', result = ? WHERE state = 'running'",
      JSON.stringify({ note: "The Console worker restarted during this check. Check again.", checkedAt: this.now() }),
    );
  },

  backupState(this: ConsoleStore): { succeededAt: number; failedAt: number } {
    const r = this.get("SELECT succeeded_at, failed_at FROM console_backup WHERE id = 1");
    return { succeededAt: (r?.succeeded_at as number) ?? 0, failedAt: (r?.failed_at as number) ?? 0 };
  },
  recordBackup(this: ConsoleStore, outcome: "succeeded" | "failed", at: number) {
    const state = { ...this.backupState(), [outcome === "succeeded" ? "succeededAt" : "failedAt"]: at };
    this.run(
      "INSERT INTO console_backup (id, succeeded_at, failed_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET succeeded_at = excluded.succeeded_at, failed_at = excluded.failed_at",
      state.succeededAt, state.failedAt,
    );
  },

  /** One row per incident key: a repeat of the incident adds nothing. The
   * web process queues unfenced (the lockout); the worker passes its epoch.
   * False when the incident's key was queued already. */
  enqueueMail(this: ConsoleStore, key: string, mail: ConsoleMail, now: number, epoch?: number): boolean {
    return this.transaction(() => {
      const { kind, ...data } = mail;
      return 1 === this.run(
        "INSERT OR IGNORE INTO console_mail (key, kind, data, status, attempts, created_at, next_attempt_at) VALUES (?, ?, ?, 'pending', 0, ?, ?)",
        key, kind, JSON.stringify(data), now, now,
      );
    }, epoch);
  },
  mailRows(this: ConsoleStore, status?: ConsoleMailRow["status"]): ConsoleMailRow[] {
    return this.all(`SELECT * FROM console_mail${status ? " WHERE status = ?" : ""} ORDER BY created_at, key`, ...(status ? [status] : [])).map((r) => ({
      key: r.key as string,
      mail: { ...(json(r.data) as object), kind: r.kind } as ConsoleMail,
      status: r.status as ConsoleMailRow["status"],
      attempts: r.attempts as number,
      createdAt: r.created_at as number,
      nextAttemptAt: r.next_attempt_at as number,
      lastStatus: (r.last_status as number | null) ?? null,
    }));
  },
  dueMail(this: ConsoleStore, now: number, limit = 10): ConsoleMailRow[] {
    return this.mailRows("pending").filter((r) => r.nextAttemptAt <= now).slice(0, limit);
  },
  /** E-mails given up on (the Overview shows them). */
  failedMailCount(this: ConsoleStore): number {
    return Number(this.get("SELECT COUNT(*) AS n FROM console_mail WHERE status = 'failed'")?.n ?? 0);
  },
  /** One attempt's outcome, a fenced worker write. */
  recordMailDelivery(this: ConsoleStore, epoch: number, key: string, outcome: DeliveryOutcome) {
    if (outcome.sent)
      this.write(epoch, "UPDATE console_mail SET status = 'sent', attempts = attempts + 1, finished_at = ? WHERE key = ? AND status = 'pending'", outcome.at, key);
    else
      this.write(
        epoch,
        "UPDATE console_mail SET status = ?, attempts = attempts + 1, last_status = ?, next_attempt_at = COALESCE(?, next_attempt_at), finished_at = ? WHERE key = ? AND status = 'pending'",
        outcome.nextAttemptAt === null ? "failed" : "pending",
        outcome.status,
        outcome.nextAttemptAt,
        outcome.nextAttemptAt === null ? outcome.at : null,
        key,
      );
  },
};
