import { DatabaseSync } from "node:sqlite";
import { openStoreDatabase, enableWal } from "../shared/sqlite.ts";
import type { SessionRow, SignInState, SignInStore } from "./signin.ts";

// The sign-in's own store, `signin.sqlite` in the data folder. Sessions are
// stored by the hash of their ID only. The code-failure counter, the lock
// and the current code's hash belong to your account (one row), so every
// partial session shares them and a restart does not reset them.

/** The file's name in the data folder. */
export const SIGN_IN_FILE = "signin.sqlite";

const TABLES = {
  sessions:
    "CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, device TEXT NOT NULL, code_at INTEGER)",
  sign_in:
    "CREATE TABLE IF NOT EXISTS sign_in (id INTEGER PRIMARY KEY CHECK (id = 1), failures INTEGER NOT NULL, locked_until INTEGER NOT NULL, code_sent_at INTEGER NOT NULL, code_hash TEXT NOT NULL, code_expires_at INTEGER NOT NULL)",
  emergency_links:
    "CREATE TABLE IF NOT EXISTS emergency_links (hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)",
  rate_limits:
    "CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)",
};

export class SignInDatabase implements SignInStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = openStoreDatabase(path);
    enableWal(this.db);
    this.db.exec(Object.values(TABLES).join("; "));
  }
  close() {
    this.db.close();
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createSession(row: SessionRow) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(row.createdAt);
      this.insertSession(row);
    });
  }
  private insertSession(row: SessionRow) {
    this.db
      .prepare(
        "INSERT INTO sessions (id_hash, kind, created_at, last_used_at, expires_at, device, code_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(row.idHash, row.kind, row.createdAt, row.lastUsedAt, row.expiresAt, row.device, row.codeAt);
  }
  session(idHash: string): SessionRow | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id_hash = ?").get(idHash) as
      | Record<string, number | string | null>
      | undefined;
    return row
      ? {
          idHash: String(row.id_hash),
          kind: row.kind as SessionRow["kind"],
          createdAt: Number(row.created_at),
          lastUsedAt: Number(row.last_used_at),
          expiresAt: Number(row.expires_at),
          device: String(row.device),
          codeAt: row.code_at === null ? null : Number(row.code_at),
        }
      : null;
  }
  /** Record use (at most once a minute) or a fresh code on one session. */
  touchSession(idHash: string, update: { lastUsedAt?: number; codeAt?: number }) {
    this.transaction(() => {
      if (update.lastUsedAt !== undefined)
        this.db.prepare("UPDATE sessions SET last_used_at = ? WHERE id_hash = ?").run(update.lastUsedAt, idHash);
      if (update.codeAt !== undefined)
        this.db.prepare("UPDATE sessions SET code_at = ? WHERE id_hash = ?").run(update.codeAt, idHash);
    });
  }
  /** Replace a session by a new one in one step, only while the old one
   * still exists. Returns false when it was already gone. */
  replaceSession(oldHash: string, row: SessionRow): boolean {
    return this.transaction(() => {
      if (Number(this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(oldHash).changes) !== 1)
        return false;
      this.insertSession(row);
      return true;
    });
  }
  deleteSession(idHash: string) {
    this.transaction(() => void this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash));
  }
  /** Every signed-in (full) session that has not expired, most recently
   * used first: the devices list on the Console's Keys page. */
  fullSessions(now: number): SessionRow[] {
    const rows = this.db
      .prepare("SELECT id_hash FROM sessions WHERE kind = 'full' AND expires_at > ? ORDER BY last_used_at DESC")
      .all(now) as { id_hash: string }[];
    return rows.map((r) => this.session(r.id_hash)).filter((r): r is SessionRow => r !== null);
  }
  /** Sign out everywhere: every full and partial session. */
  deleteAllSessions() {
    this.transaction(() => void this.db.prepare("DELETE FROM sessions").run());
  }
  /** Change the sign-in counters in one transaction. */
  updateSignIn<T>(mutate: (state: SignInState) => T): T {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM sign_in WHERE id = 1").get() as
        | { failures: number; locked_until: number; code_sent_at: number; code_hash: string; code_expires_at: number }
        | undefined;
      const state: SignInState = {
        failures: row?.failures ?? 0,
        lockedUntil: row?.locked_until ?? 0,
        codeSentAt: row?.code_sent_at ?? 0,
        codeHash: row?.code_hash ?? "",
        codeExpiresAt: row?.code_expires_at ?? 0,
      };
      const result = mutate(state);
      this.db
        .prepare(
          "INSERT INTO sign_in (id, failures, locked_until, code_sent_at, code_hash, code_expires_at) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until, code_sent_at = excluded.code_sent_at, code_hash = excluded.code_hash, code_expires_at = excluded.code_expires_at",
        )
        .run(state.failures, state.lockedUntil, state.codeSentAt, state.codeHash, state.codeExpiresAt);
      return result;
    });
  }
  createEmergencyLink(hash: string, createdAt: number, expiresAt: number) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM emergency_links WHERE expires_at <= ?").run(createdAt);
      this.db
        .prepare("INSERT INTO emergency_links (hash, created_at, expires_at) VALUES (?, ?, ?)")
        .run(hash, createdAt, expiresAt);
    });
  }
  /** Use a link once: true only for an unused, unexpired link. */
  useEmergencyLink(hash: string, now: number): boolean {
    return this.transaction(
      () =>
        Number(
          this.db
            .prepare("UPDATE emergency_links SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?")
            .run(now, hash, now).changes,
        ) === 1,
    );
  }
  /** One request against a fixed-window limit: false when over it. */
  rateHit(key: string, limit: number, windowMs: number, now: number): boolean {
    return this.transaction(() => {
      // Expired windows are forgotten, so rotating addresses cannot grow
      // the table.
      this.db.prepare("DELETE FROM rate_limits WHERE window_start <= ?").run(now - windowMs);
      const row = this.db.prepare("SELECT window_start, count FROM rate_limits WHERE key = ?").get(key) as
        | { window_start: number; count: number }
        | undefined;
      const fresh = !row || now - row.window_start >= windowMs;
      const count = fresh ? 1 : row.count + 1;
      this.db
        .prepare(
          "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count",
        )
        .run(key, fresh ? now : row.window_start, count);
      return count <= limit;
    });
  }
}
