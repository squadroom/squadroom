import type { ConsoleStore } from "../store.ts";
import { applyTaskOp, EMPTY_TASKS, taskCount, type TaskItem, type TaskListState, type TaskOp, type TaskStatus } from "../tasks.ts";
import { json } from "./rows.ts";

/** Helpers recorded per turn. */
export const HELPERS_PER_TURN = 50;
/** Task calls awaiting their result per agent; more are not followed and
 * the list shows as possibly out of date. */
export const TASK_CALLS_PENDING = 200;
/** How long a file attached in the composer stays held for its message
 * without the composer renewing it. */
export const UPLOAD_HOLD_MS = 60 * 60_000;
/** File reads (and their content) are kept this long. */
const READ_KEPT_MS = 15 * 60_000;

type Upload = { id: number; agentId: string; name: string; size: number; staged: string; replace: boolean; state: string; message: string | null };
type Helper = { id: number; name: string; type: string; state: "running" | "done" | "stopped"; tool: string | null; startedAt: number; endedAt: number | null; canOpen: boolean };

// The file panel and uploads, and what an agent's window shows of its
// helpers and task list.
export const files = {
  /** The page asks for a file; the worker reads it as the agent. Requests
   * older than 15 minutes are dropped. */
  queueRead(this: ConsoleStore, agentId: string, path: string, helperId: number | null = null): number {
    return this.transaction(() => {
      this.expireReads();
      return this.insert("INSERT INTO console_file_reads (agent_id, path, helper_id, state, created_at) VALUES (?, ?, ?, 'pending', ?)", agentId, path, helperId, this.now());
    });
  },
  fileRead(this: ConsoleStore, id: number): { id: number; agentId: string; path: string; state: string; result: unknown } | undefined {
    const r = this.get("SELECT * FROM console_file_reads WHERE id = ? AND created_at >= ?", id, this.now() - READ_KEPT_MS);
    return r && { id: r.id as number, agentId: r.agent_id as string, path: r.path as string, state: r.state as string, result: json(r.result) };
  },
  /** Reads older than 15 minutes (with their content) are deleted: by the
   * worker fenced by its lease epoch, or inside the page's own queueRead. */
  expireReads(this: ConsoleStore, epoch?: number) {
    const sql = "DELETE FROM console_file_reads WHERE created_at < ?";
    if (epoch === undefined) this.run(sql, this.now() - READ_KEPT_MS);
    else this.write(epoch, sql, this.now() - READ_KEPT_MS);
  },
  /** Claim at most `limit` pending reads (the worker's free capacity). */
  claimReads(this: ConsoleStore, epoch: number, limit = 8): { id: number; agentId: string; path: string; helperId: number | null }[] {
    return this.claimRows(epoch, "console_file_reads", "pending", limit).map((r) => ({
      id: r.id as number,
      agentId: r.agent_id as string,
      path: r.path as string,
      helperId: (r.helper_id as number | null) ?? null,
    }));
  },
  finishRead(this: ConsoleStore, epoch: number, id: number, result: Record<string, unknown>) {
    this.write(epoch, "UPDATE console_file_reads SET state = 'done', result = ? WHERE id = ?", JSON.stringify(result), id);
  },

  queueUpload(this: ConsoleStore, u: { agentId: string; name: string; size: number; staged: string; replace: boolean; hold?: boolean }): number {
    return this.insert(
      "INSERT INTO console_uploads (agent_id, name, size, staged, replace, state, hold_until, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)",
      u.agentId, u.name, u.size, u.staged, u.replace ? 1 : 0, u.hold ? this.now() + UPLOAD_HOLD_MS : null, this.now(),
    );
  },
  /** The open composer keeps its attached files held. */
  renewUploads(this: ConsoleStore, agentId: string, ids: number[]): number {
    let n = 0;
    for (const id of ids)
      n += this.run(
        // Only a hold still current: one that lapsed is released for good.
        "UPDATE console_uploads SET hold_until = ? WHERE id = ? AND agent_id = ? AND hold_until >= ? AND bound_turn IS NULL AND delivered_turn IS NULL",
        this.now() + UPLOAD_HOLD_MS, id, agentId, this.now(),
      );
    return n;
  },
  /** A file removed from the composer: announced with the next turn. */
  releaseUpload(this: ConsoleStore, agentId: string, id: number): boolean {
    return this.run("UPDATE console_uploads SET hold_until = NULL WHERE id = ? AND agent_id = ? AND hold_until IS NOT NULL AND bound_turn IS NULL", id, agentId) === 1;
  },
  upload(this: ConsoleStore, id: number): Upload | undefined {
    const r = this.get("SELECT * FROM console_uploads WHERE id = ?", id);
    return (
      r && {
        id: r.id as number,
        agentId: r.agent_id as string,
        name: r.name as string,
        size: r.size as number,
        staged: r.staged as string,
        replace: !!r.replace,
        state: r.state as string,
        message: (r.message as string | null) ?? null,
      }
    );
  },
  claimUploads(this: ConsoleStore, epoch: number, limit = 4): number[] {
    return this.claimRows(epoch, "console_uploads", "queued", limit).map((r) => r.id as number);
  },
  /** `exists`: a file of that name is there and the owner did not ask to
   * replace it. */
  finishUpload(this: ConsoleStore, epoch: number, id: number, state: "done" | "failed" | "exists", message: string) {
    this.write(epoch, "UPDATE console_uploads SET state = ?, message = ?, staged = '' WHERE id = ?", state, message, id);
  },
  /** Placed uploads not yet announced that a turn announces: those bound to
   * it, and those no message holds. */
  undelivered(this: ConsoleStore, agentId: string, turnId: number | null = null): { id: number; name: string; size: number }[] {
    return this.all(
      "SELECT id, name, size FROM console_uploads WHERE agent_id = ? AND state = 'done' AND delivered_turn IS NULL AND (bound_turn = ? OR (bound_turn IS NULL AND (hold_until IS NULL OR hold_until < ?))) ORDER BY id",
      agentId, turnId ?? -1, this.now(),
    ).map((r) => ({ id: r.id as number, name: r.name as string, size: r.size as number }));
  },
  markDelivered(this: ConsoleStore, epoch: number, ids: number[], turnId: number) {
    this.transaction(() => {
      for (const id of ids) this.run("UPDATE console_uploads SET delivered_turn = ? WHERE id = ?", turnId, id);
    }, epoch);
  },
  /** Staged files an upload still needs. */
  stagedInUse(this: ConsoleStore): string[] {
    return this.all("SELECT staged FROM console_uploads WHERE staged != ''").map((r) => r.staged as string);
  },
  /** Uploads an earlier worker left half done fail visibly, and its file
   * reads are read again; the staged copies no upload needs any more are
   * returned for removal. */
  failEarlierUploads(this: ConsoleStore, epoch: number): string[] {
    return this.transaction(() => {
      const staged = this.all("SELECT staged FROM console_uploads WHERE state IN ('running', 'queued') AND staged != ''").map((r) => r.staged as string);
      this.run("UPDATE console_uploads SET state = 'failed', message = 'The Console worker restarted during this upload. Upload it again.', staged = '' WHERE state = 'running'");
      this.run("UPDATE console_file_reads SET state = 'pending' WHERE state = 'running'");
      // Queued ones keep their staged copy (they are placed now).
      return staged.filter((path) => !this.get("SELECT 1 FROM console_uploads WHERE staged = ?", path));
    }, epoch);
  },

  // ── Helpers: a Claude agent's subagents ──────────────────
  /** A helper begins (its Agent or Task call); at most HELPERS_PER_TURN. */
  startHelper(this: ConsoleStore, epoch: number, h: { agentId: string; turnId: number; toolUseId: string; name: string; type: string }) {
    // The client's opaque id is checked before it is stored (it also names
    // the helper's transcript).
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(h.toolUseId)) return;
    this.transaction(() => {
      if (Number(this.get("SELECT COUNT(*) AS n FROM console_helpers WHERE turn_id = ?", h.turnId)!.n) >= HELPERS_PER_TURN) return;
      this.run(
        "INSERT OR IGNORE INTO console_helpers (agent_id, turn_id, session_id, tool_use_id, name, type, state, started_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)",
        h.agentId, h.turnId, this.session(h.agentId), h.toolUseId, h.name.slice(0, 80), h.type.slice(0, 80), this.now(),
      );
    }, epoch);
  },
  /** The tool a running helper is on. */
  helperTool(this: ConsoleStore, epoch: number, turnId: number, toolUseId: string, tool: string) {
    this.write(epoch, "UPDATE console_helpers SET tool = ? WHERE turn_id = ? AND tool_use_id = ? AND state = 'running'", tool.slice(0, 200), turnId, toolUseId);
  },
  /** A helper's own result arrived: done, with its subagent id if given. */
  finishHelper(this: ConsoleStore, epoch: number, turnId: number, toolUseId: string, subagentId: string | null) {
    this.write(
      epoch,
      "UPDATE console_helpers SET state = 'done', ended_at = ?, subagent_id = COALESCE(?, subagent_id) WHERE turn_id = ? AND tool_use_id = ? AND state = 'running'",
      this.now(), subagentId, turnId, toolUseId,
    );
  },
  /** A turn ended any way: its helpers still running are stopped. */
  settleHelpers(this: ConsoleStore, turnId: number, now: number) {
    this.run("UPDATE console_helpers SET state = 'stopped', ended_at = ? WHERE turn_id = ? AND state = 'running'", now, turnId);
  },
  /** The helpers row for an agent's current session: running ones, then
   * up to five finished (latest first), and how many more finished. */
  helpers(this: ConsoleStore, agentId: string): { shown: Helper[]; more: number } {
    // Running ones of the current session; finished ones whatever session
    // they ran in, so a helper from before Start fresh still opens.
    const rows: Helper[] = this.all(
      "SELECT * FROM console_helpers WHERE agent_id = ? AND (state <> 'running' OR session_id IS ?) ORDER BY (state = 'running') DESC, COALESCE(ended_at, started_at) DESC, id DESC",
      agentId, this.session(agentId),
    ).map((r) => ({
      id: r.id as number,
      name: r.name as string,
      type: r.type as string,
      state: r.state as Helper["state"],
      tool: (r.tool as string | null) ?? null,
      startedAt: r.started_at as number,
      endedAt: (r.ended_at as number | null) ?? null,
      // Its transcript is found by the helper's own call id.
      canOpen: !!r.session_id,
    }));
    const running = rows.filter((r) => r.state === "running");
    const finished = rows.filter((r) => r.state !== "running");
    return { shown: [...running, ...finished.slice(0, 5)], more: Math.max(0, finished.length - 5) };
  },
  /** What the worker needs to read a helper's transcript, if it is the
   * agent's own and was recorded with its session and subagent id. */
  helperTranscript(this: ConsoleStore, agentId: string, helperId: number): { sessionId: string; subagentId: string | null; toolUseId: string; name: string } | null {
    const r = this.get("SELECT * FROM console_helpers WHERE id = ? AND agent_id = ?", helperId, agentId);
    if (!r?.session_id) return null;
    return { sessionId: r.session_id as string, subagentId: (r.subagent_id as string | null) ?? null, toolUseId: r.tool_use_id as string, name: r.name as string };
  },

  // ── Task list ─────────────────────────────────────
  /** The agent's list and pending calls for its current session; another
   * session's (before Start fresh) is not carried over. */
  taskRow(this: ConsoleStore, agentId: string): { state: TaskListState; pending: Record<string, TaskOp> } {
    const r = this.get("SELECT * FROM console_tasks WHERE agent_id = ?", agentId);
    if (!r || r.session_id !== this.session(agentId)) return { state: EMPTY_TASKS, pending: {} };
    return {
      state: { items: JSON.parse(r.items as string) as TaskItem[], incomplete: r.incomplete === 1, stale: r.stale === 1 },
      pending: JSON.parse(r.pending as string) as Record<string, TaskOp>,
    };
  },
  putTasks(this: ConsoleStore, agentId: string, state: TaskListState, pending: Record<string, TaskOp>) {
    this.run(
      "INSERT INTO console_tasks (agent_id, session_id, items, incomplete, stale, pending, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET session_id = excluded.session_id, items = excluded.items, incomplete = excluded.incomplete, stale = excluded.stale, pending = excluded.pending, updated_at = excluded.updated_at",
      agentId, this.session(agentId), JSON.stringify(state.items), state.incomplete ? 1 : 0, state.stale ? 1 : 0, JSON.stringify(pending), this.now(),
    );
  },
  /** A task call was seen (already redacted and bounded): pending until its
   * result. */
  taskCall(this: ConsoleStore, epoch: number, agentId: string, callId: string, op: TaskOp) {
    this.transaction(() => {
      const { state, pending } = this.taskRow(agentId);
      if (Object.keys(pending).length >= TASK_CALLS_PENDING) return this.putTasks(agentId, { ...state, stale: true }, pending);
      this.putTasks(agentId, state, { ...pending, [callId]: op });
    }, epoch);
  },
  /** A tool result: settles the call if it was a pending task call, which
   * changes the list only if it succeeded. */
  taskResult(this: ConsoleStore, epoch: number, agentId: string, callId: string, ok: boolean, text: string) {
    this.transaction(() => {
      const { state, pending } = this.taskRow(agentId);
      const op = pending[callId];
      if (!op) return;
      const rest = { ...pending };
      delete rest[callId];
      this.putTasks(agentId, ok ? applyTaskOp(state, op, text) : state, rest);
    }, epoch);
  },
  /** A task call the Console cannot follow: the list may be out of date. */
  taskUnfollowed(this: ConsoleStore, epoch: number, agentId: string) {
    this.transaction(() => {
      const { state, pending } = this.taskRow(agentId);
      this.putTasks(agentId, { ...state, stale: true }, pending);
    }, epoch);
  },
  /** A whole list the client reports as already applied (Codex's plan). */
  taskList(this: ConsoleStore, epoch: number, agentId: string, op: TaskOp) {
    this.transaction(() => {
      const { state, pending } = this.taskRow(agentId);
      this.putTasks(agentId, applyTaskOp(state, op), pending);
    }, epoch);
  },
  /** A turn ended: a task call still without its result leaves the list
   * possibly out of date until the next whole list or Start fresh. */
  settleTasks(this: ConsoleStore, agentId: string) {
    const { state, pending } = this.taskRow(agentId);
    if (Object.keys(pending).length) this.putTasks(agentId, { ...state, stale: true }, {});
  },
  /** The task list for the agent's current session, or null. */
  tasks(this: ConsoleStore, agentId: string): { items: { text: string; status: TaskStatus }[]; count: { done: number; total: number } | null; incomplete: boolean; stale: boolean } | null {
    const r = this.get("SELECT session_id FROM console_tasks WHERE agent_id = ?", agentId);
    if (!r || r.session_id !== this.session(agentId)) return null;
    const { state } = this.taskRow(agentId);
    return { items: state.items.map((i) => ({ text: i.text, status: i.status })), count: taskCount(state), incomplete: state.incomplete, stale: state.stale };
  },
};
