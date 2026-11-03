import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { enableWal, openStoreDatabase } from "../shared/sqlite.ts";
import { LIMITS, USAGE_PAUSE, type ConsoleTurn } from "./types.ts";
import { busy, type Row } from "./store/rows.ts";
import { projects } from "./store/projects.ts";
import { turns } from "./store/turns.ts";
import { lifecycle } from "./store/lifecycle.ts";
import { requests } from "./store/requests.ts";
import { git } from "./store/git.ts";
import { files } from "./store/files.ts";
import { team } from "./store/team.ts";
import { mailbox } from "./store/mailbox.ts";
import { pause } from "./store/pause.ts";
import { upkeep } from "./store/upkeep.ts";
import { images } from "./store/images.ts";

// The Console's own store: `~/.squadroom/console.sqlite`, its own lease
// row, append-only events. The web process writes only owner commands
// (create, send, stop, close); every turn transition is the worker's,
// fenced by its lease epoch. This file holds the schema, the transactions
// and the lease; each area's methods live in `./store/` and are mixed into
// the class below.

export const LEASE_TTL_MS = 60_000;
export const LEASE_LOST = "Console worker lease lost";
export { USAGE_PAUSE };
export { ASK_FIRST_CLAUDE_ONLY } from "./store/projects.ts";
export { SUMMARY_PROMPT } from "./store/turns.ts";
export type { EndedTurn, TabTurn } from "./store/turns.ts";
export { NEEDS_MAIL, PAUSE_ALL } from "./store/pause.ts";

export interface TurnRow extends ConsoleTurn {
  prompt: string;
  /** Send next's mark: null when not marked. */
  nextAt: number | null;
  /** When the owner last edited it while queued. */
  revisedAt: number | null;
  /** The turn that asks for a summary. */
  summary: boolean;
  epoch: number | null;
  bytes: number;
}

/** Raised whenever the schema below changes: a store stamped with an
 * earlier one is upgraded by MIGRATIONS where it can be, and otherwise
 * checked against it on open. */
const SCHEMA_VERSION = 3;

/** Columns a store stamped with an earlier version gains: each is added
 * only where it is missing, so a store an older build opened since (and
 * stamped back) is upgraded again safely. A store still missing a column
 * after them is refused (and the transaction leaves it as it was). */
const MIGRATIONS: { table: string; column: string; type: string }[] = [
  // Version 3: what a turn is priced as and the key that pays, and what its
  // client has reported while it runs.
  { table: "console_turns", column: "billing", type: "TEXT" },
  { table: "console_turns", column: "running", type: "TEXT" },
];

function migrate(db: DatabaseSync) {
  for (const m of MIGRATIONS) {
    const have = (db.prepare(`PRAGMA table_info(${m.table})`).all() as Row[]).map((c) => c.name as string);
    if (have.length && !have.includes(m.column)) db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.type}`);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS console_lease (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL, holder TEXT NOT NULL, renewed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS console_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, base_branch TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, repo TEXT, state TEXT NOT NULL DEFAULT 'ready', error TEXT, pause_reason TEXT, archived_at INTEGER, acp_network INTEGER NOT NULL DEFAULT 0, acp_network_wanted INTEGER, acp_network_now INTEGER NOT NULL DEFAULT 0, image_tools INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS console_tabs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, pause_reason TEXT, count_from INTEGER NOT NULL DEFAULT 0, resumed_at INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, circle_from INTEGER NOT NULL DEFAULT 0, usage_hold TEXT, spend_limit_usd REAL, spend_reset_seq INTEGER NOT NULL DEFAULT 0, steps TEXT, step INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS console_tabs_project ON console_tabs (project_id);
CREATE TABLE IF NOT EXISTS console_agents (id TEXT PRIMARY KEY, tab_id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, permission TEXT NOT NULL, folder TEXT NOT NULL DEFAULT '', branch TEXT, state TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, base_commit TEXT, merging TEXT, start_after TEXT, ask_first INTEGER NOT NULL DEFAULT 0, carry_summary TEXT, settling INTEGER);
CREATE INDEX IF NOT EXISTS console_agents_project ON console_agents (project_id);
CREATE TABLE IF NOT EXISTS console_sessions (agent_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, epoch INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS console_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, trigger TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, stop_requested TEXT, epoch INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, usage TEXT, bytes INTEGER NOT NULL DEFAULT 0, commit_before TEXT, commit_after TEXT, waited_ms INTEGER NOT NULL DEFAULT 0, acknowledged INTEGER NOT NULL DEFAULT 0, instruction_id INTEGER, resend_of INTEGER, push_approved INTEGER NOT NULL DEFAULT 0, progressed INTEGER NOT NULL DEFAULT 0, progress_mark INTEGER, next_at INTEGER, revised_at INTEGER, summary INTEGER NOT NULL DEFAULT 0, ended_seq INTEGER, prompted INTEGER NOT NULL DEFAULT 0, final_text TEXT, compacted INTEGER NOT NULL DEFAULT 0, cost_usd REAL, cost_basis TEXT, started_seq INTEGER, billing TEXT, running TEXT);
CREATE INDEX IF NOT EXISTS console_turns_agent ON console_turns (agent_id, id);
CREATE INDEX IF NOT EXISTS console_turns_status ON console_turns (status);
CREATE TABLE IF NOT EXISTS console_events (id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id INTEGER NOT NULL, agent_id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS console_events_project ON console_events (project_id, id);
CREATE TRIGGER IF NOT EXISTS console_events_append_only BEFORE UPDATE ON console_events BEGIN SELECT RAISE(ABORT, 'Console events are append-only.'); END;
CREATE TABLE IF NOT EXISTS console_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, tab_id TEXT NOT NULL, from_agent TEXT, to_agent TEXT NOT NULL, kind TEXT NOT NULL, correlation_id TEXT, body TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, from_turn INTEGER, turn_id INTEGER, instruction_id INTEGER, resend_after INTEGER, ended_at INTEGER, shared INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS console_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id INTEGER NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL, decided_by TEXT, reason TEXT, created_at INTEGER NOT NULL, decided_at INTEGER, summary TEXT NOT NULL DEFAULT '', rule_key TEXT, answer TEXT);
CREATE INDEX IF NOT EXISTS console_requests_agent ON console_requests (agent_id, id);
CREATE TABLE IF NOT EXISTS console_pauses (login TEXT PRIMARY KEY, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS console_rules (agent_id TEXT NOT NULL, rule_key TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (agent_id, rule_key));
CREATE TABLE IF NOT EXISTS console_commits (id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id INTEGER NOT NULL, agent_id TEXT NOT NULL, sha TEXT NOT NULL, stat TEXT NOT NULL, patch TEXT NOT NULL, created_at INTEGER NOT NULL, files TEXT NOT NULL DEFAULT '[]', progress_mark INTEGER);
CREATE INDEX IF NOT EXISTS console_commits_agent ON console_commits (agent_id, id);
CREATE TABLE IF NOT EXISTS console_diffs (agent_id TEXT PRIMARY KEY, base TEXT NOT NULL, head TEXT NOT NULL, stat TEXT NOT NULL, patch TEXT NOT NULL, updated_at INTEGER NOT NULL, files TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS console_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, message TEXT, url TEXT, created_at INTEGER NOT NULL, ended_at INTEGER, request TEXT, head TEXT);
CREATE TABLE IF NOT EXISTS console_file_reads (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, path TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, helper_id INTEGER);
CREATE TABLE IF NOT EXISTS console_uploads (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, staged TEXT NOT NULL, replace INTEGER NOT NULL, state TEXT NOT NULL, message TEXT, delivered_turn INTEGER, created_at INTEGER NOT NULL, hold_until INTEGER, bound_turn INTEGER);
CREATE INDEX IF NOT EXISTS console_uploads_agent ON console_uploads (agent_id, id);
CREATE TABLE IF NOT EXISTS console_tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id INTEGER NOT NULL, agent_id TEXT NOT NULL, call_key TEXT NOT NULL, tool TEXT NOT NULL, summary TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (turn_id, call_key));
CREATE TABLE IF NOT EXISTS console_cleanups (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, keys TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS console_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS console_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, tab_id TEXT NOT NULL, agent_id TEXT NOT NULL, pattern TEXT NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, released_at INTEGER);
CREATE TABLE IF NOT EXISTS console_holds (id INTEGER PRIMARY KEY AUTOINCREMENT, tab_id TEXT NOT NULL, holder TEXT NOT NULL, held TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, released_at INTEGER);
CREATE TABLE IF NOT EXISTS console_notices (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'note');
CREATE TABLE IF NOT EXISTS console_shown (agent_id TEXT NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL, sha TEXT NOT NULL, current INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (agent_id, author_id));
CREATE TABLE IF NOT EXISTS console_refreshes (id INTEGER PRIMARY KEY AUTOINCREMENT, reviewer_id TEXT NOT NULL, author_id TEXT NOT NULL, sha TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, applied_at INTEGER, applied_seq INTEGER, UNIQUE (reviewer_id, author_id));
CREATE TABLE IF NOT EXISTS console_roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, access TEXT NOT NULL, ai TEXT NOT NULL, prompt TEXT NOT NULL, built_in INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS console_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, body TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS console_approvals (agent_id TEXT PRIMARY KEY, sha TEXT NOT NULL, reviewer_id TEXT, reviewed_at INTEGER, approved_at INTEGER NOT NULL, cancelled_by TEXT);
CREATE TABLE IF NOT EXISTS console_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS console_gauges (agent_id TEXT PRIMARY KEY, session_id TEXT, tokens INTEGER, context_window INTEGER, measured INTEGER NOT NULL DEFAULT 1, compacted_from INTEGER, updated_at INTEGER NOT NULL, model TEXT);
CREATE TABLE IF NOT EXISTS console_helpers (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, turn_id INTEGER NOT NULL, session_id TEXT, tool_use_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, state TEXT NOT NULL, tool TEXT, subagent_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, UNIQUE (turn_id, tool_use_id));
CREATE TABLE IF NOT EXISTS console_tasks (agent_id TEXT PRIMARY KEY, session_id TEXT, items TEXT NOT NULL, incomplete INTEGER NOT NULL DEFAULT 0, stale INTEGER NOT NULL DEFAULT 0, pending TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS console_routes (id INTEGER PRIMARY KEY AUTOINCREMENT, tab_id TEXT NOT NULL, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, phrase TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, removed_at INTEGER);
CREATE TABLE IF NOT EXISTS console_image_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id INTEGER NOT NULL, agent_id TEXT NOT NULL, tab_id TEXT NOT NULL, tool TEXT NOT NULL, model TEXT NOT NULL, price_usd REAL NOT NULL, cost_usd REAL NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL, job_id TEXT, path TEXT NOT NULL, message TEXT, epoch INTEGER NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER);
CREATE INDEX IF NOT EXISTS console_image_calls_tab ON console_image_calls (tab_id, seq);
CREATE TABLE IF NOT EXISTS console_backup (id INTEGER PRIMARY KEY CHECK (id = 1), succeeded_at INTEGER NOT NULL, failed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS console_mail (key TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, created_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL, last_status INTEGER, finished_at INTEGER);
CREATE INDEX IF NOT EXISTS console_events_turn ON console_events (turn_id, id);
CREATE INDEX IF NOT EXISTS console_events_agent ON console_events (agent_id, id);
CREATE INDEX IF NOT EXISTS console_turns_retention ON console_turns (id) WHERE compacted = 0 AND ended_at IS NOT NULL;
-- The spend checks on every tick: the month's API-key spend (by when a turn
-- ended) and a tab's since its reset (by each agent's ended_seq), read from
-- the index alone.
CREATE INDEX IF NOT EXISTS console_turns_ended ON console_turns (ended_at, cost_usd);
CREATE INDEX IF NOT EXISTS console_turns_spend ON console_turns (agent_id, ended_seq, cost_usd);
CREATE INDEX IF NOT EXISTS console_messages_to ON console_messages (to_agent, state);
CREATE INDEX IF NOT EXISTS console_messages_tab ON console_messages (tab_id, id);
CREATE INDEX IF NOT EXISTS console_messages_turn ON console_messages (turn_id);
-- Search over the conversations, as stored (redacted): each turn's
-- message (row 2 × turn) and final reply (2 × turn + 1), kept in step by
-- triggers; a withdrawn message leaves it.
CREATE VIRTUAL TABLE IF NOT EXISTS console_search USING fts5(body);
CREATE TRIGGER IF NOT EXISTS console_search_prompt AFTER INSERT ON console_turns BEGIN INSERT INTO console_search (rowid, body) VALUES (new.id * 2, new.prompt); END;
CREATE TRIGGER IF NOT EXISTS console_search_edit AFTER UPDATE OF prompt ON console_turns BEGIN DELETE FROM console_search WHERE rowid = new.id * 2; INSERT INTO console_search (rowid, body) VALUES (new.id * 2, new.prompt); END;
CREATE TRIGGER IF NOT EXISTS console_search_reply AFTER UPDATE OF final_text ON console_turns WHEN new.final_text IS NOT NULL BEGIN DELETE FROM console_search WHERE rowid = new.id * 2 + 1; INSERT INTO console_search (rowid, body) VALUES (new.id * 2 + 1, new.final_text); END;
CREATE TRIGGER IF NOT EXISTS console_search_withdrawn AFTER UPDATE OF status ON console_turns WHEN new.status = 'withdrawn' BEGIN DELETE FROM console_search WHERE rowid IN (new.id * 2, new.id * 2 + 1); END;
`;

/** A store from before `SCHEMA_VERSION` (or a backup of one) is refused if
 * any of its tables lacks a column the schema has: it is never upgraded in
 * place. Tables it lacks entirely are created. */
function refuseOlder(db: DatabaseSync) {
  const current = new DatabaseSync(":memory:");
  try {
    current.exec(SCHEMA);
    const columns = (d: DatabaseSync, table: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => c.name as string);
    for (const { name } of current.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Row[]) {
      const have = columns(db, name as string);
      const missing = have.length ? columns(current, name as string).find((c) => !have.includes(c)) : undefined;
      if (missing)
        throw new Error(
          `The Console store has no ${name}.${missing}: it predates this version. Open it once with an earlier build, or restore it from a newer backup.`,
        );
    }
  } finally {
    current.close();
  }
}

/** How long a busy transaction waits before its one retry. */
const BUSY_RETRY_MS = 500;
/** Prepared statements kept per connection, so a hot query is not
 * prepared again on every call: emptied when full, since a few queries are
 * built with a varying list of `?`s. */
const STATEMENT_CACHE_MAX = 500;

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- area methods are mixed in below
export class ConsoleStore {
  db: DatabaseSync;
  now: () => number;
  /** One turn's stored bytes, events and its durable team payload
   * together; the worker sets its own limit. */
  turnBytesLimit = LIMITS.turnBytes;
  /** `get`, `all`, `run` and `insert` prepare each query once. */
  private statements = new Map<string, StatementSync>();
  constructor(path: string, now: () => number = Date.now) {
    this.now = now;
    this.db = openStoreDatabase(path);
    enableWal(this.db);
    // The schema in one write transaction, so a refused store is left as it
    // was and the web process and the worker opening at once never race.
    try {
      this.transaction(() => {
        if (Number(this.get("PRAGMA user_version")?.user_version) < SCHEMA_VERSION) {
          migrate(this.db);
          refuseOlder(this.db);
        }
        this.db.exec(SCHEMA);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close() {
    // A closed connection's statements are finalized.
    this.statements.clear();
    this.db.close();
  }
  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      if (this.statements.size >= STATEMENT_CACHE_MAX) this.statements.clear();
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  transaction<T>(work: () => T, epoch?: number): T {
    // A database held by another connection past the busy timeout is tried
    // once more after a pause: the whole transaction, so nothing is applied
    // twice. A lost lease or any other error is not.
    for (let attempt = 0; ; attempt++) {
      try {
        return this.attempt(work, epoch);
      } catch (error) {
        if (attempt > 0 || !busy(error)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BUSY_RETRY_MS);
      }
    }
  }
  private attempt<T>(work: () => T, epoch?: number): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (epoch !== undefined && this.lease()?.epoch !== epoch) throw new Error(LEASE_LOST);
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** One row, or every row, of a query. */
  get(sql: string, ...args: SQLInputValue[]): Row | undefined {
    return this.prepare(sql).get(...args) as Row | undefined;
  }
  all(sql: string, ...args: SQLInputValue[]): Row[] {
    return this.prepare(sql).all(...args) as Row[];
  }
  /** A write; returns how many rows it changed. */
  run(sql: string, ...args: SQLInputValue[]): number {
    return Number(this.prepare(sql).run(...args).changes);
  }
  /** An insert; returns the new row's id. */
  insert(sql: string, ...args: SQLInputValue[]): number {
    return Number(this.prepare(sql).run(...args).lastInsertRowid);
  }
  /** One write of the worker's, fenced by its lease epoch. */
  write(epoch: number, sql: string, ...args: SQLInputValue[]): void {
    this.transaction(() => this.run(sql, ...args), epoch);
  }
  /** The worker claims up to `limit` rows of a work queue, oldest first:
   * marked running, and returned as running. */
  claimRows(epoch: number, table: string, from: "queued" | "pending", limit: number, where = "", ...args: SQLInputValue[]): Row[] {
    if (limit <= 0) return [];
    return this.transaction(
      () =>
        this.all(`SELECT * FROM ${table} WHERE state = '${from}'${where} ORDER BY id LIMIT ?`, ...args, limit).map((r) => {
          this.run(`UPDATE ${table} SET state = 'running' WHERE id = ?`, r.id as number);
          return { ...r, state: "running" };
        }),
      epoch,
    );
  }

  // ── Lease: one row, `console_lease` ─────────────────────────
  lease(): { epoch: number; holder: string; renewedAt: number } | null {
    const row = this.get("SELECT epoch, holder, renewed_at FROM console_lease WHERE id = 1");
    return row ? { epoch: row.epoch as number, holder: row.holder as string, renewedAt: row.renewed_at as number } : null;
  }
  takeLease(holder: string, now: number): number | null {
    return this.transaction(() => {
      const current = this.lease();
      if (current && now - current.renewedAt < LEASE_TTL_MS) return null;
      const epoch = (current?.epoch ?? 0) + 1;
      this.run(
        "INSERT INTO console_lease (id, epoch, holder, renewed_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, holder = excluded.holder, renewed_at = excluded.renewed_at",
        epoch,
        holder,
        now,
      );
      return epoch;
    });
  }
  /** Renews only while the lease still has this epoch, through the
   * transaction's busy retry, like every write. */
  renewLease(epoch: number, now: number): boolean {
    return this.transaction(() => this.run("UPDATE console_lease SET renewed_at = ? WHERE id = 1 AND epoch = ?", now, epoch) === 1);
  }
  /** On a graceful exit: mark the lease stale so the next worker need not
   * wait for the TTL. The epoch stays, so late writes remain fenced. */
  releaseLease(epoch: number) {
    this.run("UPDATE console_lease SET renewed_at = 0 WHERE id = 1 AND epoch = ?", epoch);
  }
}

type Projects = typeof projects;
type Turns = typeof turns;
type Lifecycle = typeof lifecycle;
type Requests = typeof requests;
type Git = typeof git;
type Files = typeof files;
type Team = typeof team;
type Mailbox = typeof mailbox;
type Pause = typeof pause;
type Upkeep = typeof upkeep;
type Images = typeof images;
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ConsoleStore extends Projects, Turns, Lifecycle, Requests, Git, Files, Team, Mailbox, Pause, Upkeep, Images {}
Object.assign(ConsoleStore.prototype, projects, turns, lifecycle, requests, git, files, team, mailbox, pause, upkeep, images);
