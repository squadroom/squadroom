import type { ConsoleAgent, ConsoleEvent } from "../types.ts";
import type { ConsoleStore, TurnRow } from "../store.ts";
import { event, OPEN, turn } from "./rows.ts";

/** Fresh session with summary: what the agent is asked, and the most of
 * its answer carried into the new session. */
export const SUMMARY_PROMPT =
  "The owner is starting you on a fresh session. Write a summary of this conversation for your next session, which will not see it: the task and its goal, what you have done and changed (files, commits), decisions and their reasons, what is unfinished, the next steps, and anything the owner asked you to remember. Write only the summary. Change no files.";
export const SUMMARY_MAX = 20_000;

type Queued = TurnRow & { refusedUploads: string[] };

/** The paying key a turn's stored billing names (lifecycle.ts). */
function paidBy(raw: unknown): EndedTurn["paidBy"] {
  if (typeof raw !== "string") return undefined;
  const b = JSON.parse(raw) as { model?: { paid?: { credential?: string } }; key?: { scope?: "project" | "global" | null; print?: string } };
  const name = b.model?.paid?.credential;
  return name && b.key?.print ? { name, scope: b.key.scope ?? null, print: b.key.print } : undefined;
}
export interface TabTurn {
  id: number;
  agentId: string;
  agentName: string;
  /** Who asked: the owner, a teammate's message, a route… */
  trigger: string;
  prompt: string;
  status: TurnRow["status"];
  reason: string | null;
  createdAt: number;
  endedAt: number | null;
  finalText: string | null;
  costUsd: number | null;
}
interface SearchHit {
  turnId: number;
  /** The agent's final reply; otherwise the turn's message. */
  reply: boolean;
  snippet: string;
  createdAt: number;
  agentId: string;
  agentName: string;
  projectId: string;
  tabId: string;
}
export interface EndedTurn {
  id: number;
  status: TurnRow["status"];
  reason: string | null;
  endedAt: number;
  costUsd: number | null;
  agentId: string;
  agentName: string;
  tabId: string;
  projectId: string;
  kind: ConsoleAgent["kind"];
  model: string;
  /** The key it was charged to, when not its model's (an image call). */
  credential?: string;
  /** When it started (a turn), which places it in a day and a month. */
  startedAt?: number | null;
  /** The key that paid, as the turn recorded it when it started. */
  paidBy?: { name: string; scope: "project" | "global" | null; print: string };
}
type Gauge = { tokens: number | null; contextWindow: number | null; measured: boolean; compactedFrom: number | null };

// Turns from the owner's side: the queue and its controls, Start fresh and
// the summary, the reads of turns and events, and the context gauge.
export const turns = {
  /** Queue an owner message as a turn, with its transcript row. */
  queueTurn(this: ConsoleStore, agentId: string, prompt: string, resendOf: number | null = null, options: { pushApproved?: boolean; uploadIds?: number[] } = {}): Queued {
    return this.transaction(() => {
      const a = this.agent(agentId);
      if (!a || a.state === "closed") throw new Error("That agent is closed.");
      if (a.state === "error") throw new Error("That agent could not be set up.");
      const resendSummary = resendOf !== null && !!this.turn(resendOf)?.summary;
      if (resendSummary) this.summaryAllowed(a);
      const now = this.now();
      const id = this.insert(
        "INSERT INTO console_turns (agent_id, trigger, prompt, status, resend_of, created_at, push_approved) VALUES (?, 'owner', ?, 'queued', ?, ?, ?)",
        // A Send again of an "Open pull request" turn keeps its approval.
        agentId, prompt, resendOf, now, (options.pushApproved ?? (resendOf !== null && this.pushApproved(resendOf))) ? 1 : 0,
      );
      // An owner message starts an instruction.
      this.run("UPDATE console_turns SET instruction_id = id WHERE id = ?", id);
      // A Re-send of a summary request is still one, with the same checks
      // and first in the queue.
      if (resendSummary) this.markSummary(id);
      this.insertEvent(id, a, "owner", { text: prompt }, now);
      // A Re-send carries the files its interrupted turn never announced.
      if (resendOf !== null) this.run("UPDATE console_uploads SET bound_turn = ? WHERE bound_turn = ? AND delivered_turn IS NULL", id, resendOf);
      const refusedUploads = this.bindUploads(agentId, id, options.uploadIds ?? []);
      return { ...this.turn(id)!, refusedUploads };
    });
  },
  /** The files sent with a message: bound to it, unless one was released
   * (its hold lapsed or was let go), since another turn may have announced
   * it. Returns the refused names. In a transaction. */
  bindUploads(this: ConsoleStore, agentId: string, turnId: number, uploadIds: number[]): string[] {
    const refused: string[] = [];
    const now = this.now();
    for (const uploadId of uploadIds) {
      const u = this.get("SELECT * FROM console_uploads WHERE id = ? AND agent_id = ?", uploadId, agentId);
      if (!u) continue;
      if (u.state !== "done") throw new Error(`${u.name as string} is still uploading. Send it when it is done.`);
      if (u.delivered_turn !== null || u.bound_turn !== null || u.hold_until === null || (u.hold_until as number) < now) {
        refused.push(u.name as string);
        continue;
      }
      this.run("UPDATE console_uploads SET bound_turn = ?, hold_until = NULL WHERE id = ?", turnId, uploadId);
    }
    return refused;
  },
  /** An agent's queued turns, first to run first: a Send next mark first
   * (the latest mark wins), then in order. */
  queuedTurns(this: ConsoleStore, agentId: string): TurnRow[] {
    return this.all("SELECT * FROM console_turns WHERE agent_id = ? AND status = 'queued' ORDER BY (next_at IS NULL), next_at DESC, id", agentId).map(turn);
  },
  /** A queued owner message, if it still is one (the compare-and-set of the
   * queue controls: whatever the worker claimed first wins). */
  queuedOwner(this: ConsoleStore, turnId: number): TurnRow {
    const t = this.turn(turnId);
    if (!t || t.trigger !== "owner") throw new Error("That message does not exist.");
    if (t.status !== "queued") throw new Error("That message has already gone to the agent.");
    return t;
  },
  /** Edit: the new text in place, recorded as a revision. An edit carries
   * no approval (Open pull request) and no Re-send note, and counts as the
   * owner's input for the circle detector. */
  editQueued(this: ConsoleStore, turnId: number, text: string, uploadIds: number[] = []): Queued {
    return this.transaction(() => {
      const t = this.queuedOwner(turnId);
      if (t.summary) throw new Error("The summary request's text is fixed. Delete it instead.");
      const a = this.agent(t.agentId)!;
      const now = this.now();
      this.run("UPDATE console_turns SET prompt = ?, revised_at = ?, push_approved = 0, resend_of = NULL WHERE id = ? AND status = 'queued'", text, now, turnId);
      this.insertEvent(turnId, a, "revised", { text }, now);
      this.run("UPDATE console_tabs SET circle_from = MAX(circle_from, ?) WHERE id = ?", this.lastTurnId(), a.tabId);
      // Files attached while editing go with the edited message.
      const refusedUploads = this.bindUploads(t.agentId, turnId, uploadIds);
      return { ...this.turn(turnId)!, refusedUploads };
    });
  },
  /** Delete: never delivered. Its files stay placed but are never
   * announced. */
  withdrawQueued(this: ConsoleStore, turnId: number): { files: string[] } {
    return this.transaction(() => {
      const t = this.queuedOwner(turnId);
      const now = this.now();
      this.run("UPDATE console_turns SET status = 'withdrawn', ended_at = ? WHERE id = ? AND status = 'queued'", now, turnId);
      this.insertEvent(turnId, this.agent(t.agentId)!, "withdrawn", { status: "withdrawn" }, now);
      const files = this.all("SELECT name FROM console_uploads WHERE bound_turn = ? AND delivered_turn IS NULL", turnId).map((r) => r.name as string);
      this.run("UPDATE console_uploads SET delivered_turn = ? WHERE bound_turn = ? AND delivered_turn IS NULL", turnId, turnId);
      return { files };
    });
  },
  /** The files sent with a queued message. */
  boundUploads(this: ConsoleStore, turnId: number): string[] {
    return this.all("SELECT name FROM console_uploads WHERE bound_turn = ? ORDER BY id", turnId).map((r) => r.name as string);
  },
  /** Send next: to the front of the agent's queue. */
  sendNext(this: ConsoleStore, turnId: number): TurnRow {
    return this.transaction(() => {
      this.queuedOwner(turnId);
      this.run("UPDATE console_turns SET next_at = ? WHERE id = ? AND status = 'queued'", this.frontMark(), turnId);
      return this.turn(turnId)!;
    });
  },
  /** A Send next mark strictly later than any earlier one, so the latest
   * mark wins. */
  frontMark(this: ConsoleStore): number {
    return Math.max(this.now(), Number(this.get("SELECT COALESCE(MAX(next_at), 0) AS n FROM console_turns")!.n) + 1);
  },
  /** The newest turn's id (0 when there is none). */
  lastTurnId(this: ConsoleStore): number {
    return Number(this.get("SELECT COALESCE(MAX(id), 0) AS id FROM console_turns")!.id);
  },
  /** Stop: a queued turn ends at once; a running one is stopped by the
   * worker (Force stop kills its process group). */
  requestStop(this: ConsoleStore, agentId: string, force: boolean): number {
    return this.transaction(() => {
      const now = this.now();
      let changed = 0;
      for (const t of this.openTurns().filter((t) => t.agentId === agentId)) {
        if (t.status === "queued") {
          this.run("UPDATE console_turns SET status = 'stopped', reason = 'Stopped before it started.', ended_at = ? WHERE id = ?", now, t.id);
          this.insertEvent(t.id, this.agent(agentId)!, "status", { status: "stopped", reason: "Stopped before it started." }, now);
          this.settle(t.id, "stopped", null, now);
        } else
          this.run("UPDATE console_turns SET stop_requested = ? WHERE id = ? AND (stop_requested IS NULL OR stop_requested = 'stop')", force ? "force" : "stop", t.id);
        changed++;
      }
      return changed;
    });
  },

  turn(this: ConsoleStore, id: number): TurnRow | undefined {
    const r = this.get("SELECT * FROM console_turns WHERE id = ?", id);
    return r && turn(r);
  },
  /** Every queued or running turn, oldest first. */
  openTurns(this: ConsoleStore): TurnRow[] {
    return this.all(`SELECT * FROM console_turns WHERE status IN (${OPEN}) ORDER BY id`).map(turn);
  },
  /** Each agent's latest turn in a project (its window's status). */
  latestTurns(this: ConsoleStore, projectId: string): TurnRow[] {
    return this.all(
      "SELECT t.* FROM console_turns t JOIN console_agents a ON a.id = t.agent_id WHERE a.project_id = ? AND t.id = (SELECT MAX(id) FROM console_turns WHERE agent_id = t.agent_id AND status <> 'withdrawn')",
      projectId,
    ).map(turn);
  },
  /** Events after an id, oldest first. */
  events(this: ConsoleStore, projectId: string, after: number, limit = 500): ConsoleEvent[] {
    return this.all("SELECT * FROM console_events WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?", projectId, after, limit).map(event);
  },
  /** The newest event id in a project (0 when it has none). */
  lastEventId(this: ConsoleStore, projectId: string): number {
    return (this.get("SELECT MAX(id) AS id FROM console_events WHERE project_id = ?", projectId)?.id as number | null) ?? 0;
  },
  /** A fresh view's history: each agent's latest `perAgent` events up to
   * `upTo`, oldest first, so one busy window never pushes a quiet one's
   * transcript out. */
  agentTails(this: ConsoleStore, projectId: string, perAgent: number, upTo: number, perAgentBytes = Number.MAX_SAFE_INTEGER): ConsoleEvent[] {
    // Newest first per open agent, by rows and by the bytes of their
    // bodies, each read through the (agent_id, id) index and stopped at its
    // bound, so a long history is never scanned whole. The newest event is
    // always kept.
    const rows: Record<string, unknown>[] = [];
    const tail = this.db.prepare("SELECT *, length(CAST(body AS BLOB)) AS size FROM console_events WHERE agent_id = ? AND id <= ? ORDER BY id DESC LIMIT ?");
    for (const a of this.all("SELECT id FROM console_agents WHERE project_id = ? AND state <> 'closed'", projectId)) {
      let bytes = 0;
      let kept = 0;
      for (const r of tail.all(a.id as string, upTo, perAgent)) {
        bytes += r.size as number;
        if (kept > 0 && bytes > perAgentBytes) break;
        rows.push(r);
        kept++;
      }
    }
    return rows.sort((x, y) => (x.id as number) - (y.id as number)).map(event);
  },
  /** One of the agent's turns is running or waiting for the owner. */
  working(this: ConsoleStore, agentId: string): boolean {
    return !!this.get("SELECT 1 FROM console_turns WHERE agent_id = ? AND status IN ('running', 'waiting_for_owner')", agentId);
  },
  /** A summary request waits in the agent's queue. */
  summaryQueued(this: ConsoleStore, agentId: string): boolean {
    return !!this.get("SELECT 1 FROM console_turns WHERE agent_id = ? AND summary = 1 AND status = 'queued'", agentId);
  },
  /** Start fresh: the agent's next turn begins a new conversation. Refused
   * while one of its turns is running. */
  clearSession(this: ConsoleStore, agentId: string) {
    this.transaction(() => {
      const agent = this.agent(agentId);
      if (!agent || agent.state === "closed") throw new Error("That agent does not exist.");
      if (this.working(agentId)) throw new Error(`${agent.name} is working on a turn. Wait until it ends (or stop it), then start fresh.`);
      // A queued summary request needs the conversation it would summarize.
      if (this.summaryQueued(agentId)) throw new Error(`${agent.name} has a summary request queued. Delete it first, or let it run.`);
      this.run("DELETE FROM console_sessions WHERE agent_id = ?", agentId);
      // A plain Start fresh carries no summary.
      this.run("UPDATE console_agents SET carry_summary = NULL WHERE id = ?", agentId);
    });
  },
  /** Fresh session with summary: one turn in which the agent writes a
   * summary of its work, first in its queue. When it ends done, the session
   * is cleared and the summary opens the new session's first prompt.
   * Refused while a turn runs, while one is already asked for, or while a
   * summary waits for its new session. */
  queueSummary(this: ConsoleStore, agentId: string): TurnRow {
    return this.transaction(() => {
      const agent = this.agent(agentId);
      if (!agent || agent.state === "closed") throw new Error("That agent does not exist.");
      this.summaryAllowed(agent);
      const t = this.queueTurn(agentId, SUMMARY_PROMPT);
      this.markSummary(t.id);
      return this.turn(t.id)!;
    });
  },
  /** What a summary request needs, new or a Re-send. */
  summaryAllowed(this: ConsoleStore, agent: ConsoleAgent) {
    if (this.working(agent.id)) throw new Error(`${agent.name} is working on a turn. Wait until it ends (or stop it), then ask for a summary.`);
    if (this.summaryQueued(agent.id)) throw new Error(`${agent.name} already has a summary request queued.`);
    if (this.carriedSummary(agent.id) !== null) throw new Error(`${agent.name}'s summary is waiting for its next message, which starts the new session.`);
    if (this.session(agent.id) === null) throw new Error(`${agent.name} has no conversation to summarize yet.`);
  },
  /** A summary request, first in its agent's queue (like Send next). */
  markSummary(this: ConsoleStore, turnId: number) {
    this.run("UPDATE console_turns SET summary = 1, next_at = ? WHERE id = ?", this.frontMark(), turnId);
  },
  /** The summary waiting for the new session's first prompt, if any. */
  carriedSummary(this: ConsoleStore, agentId: string): string | null {
    return (this.get("SELECT carry_summary FROM console_agents WHERE id = ?", agentId)?.carry_summary as string | null) ?? null;
  },
  /** The new session's first prompt reached the agent: the summary is
   * spent (only if it is still the same one). */
  spendSummary(this: ConsoleStore, epoch: number, agentId: string, summary: string) {
    this.write(epoch, "UPDATE console_agents SET carry_summary = NULL WHERE id = ? AND carry_summary = ?", agentId, summary);
  },
  /** The context gauge: one measurement per agent, kept with the session
   * it was measured in. A new session starts it again. */
  setGauge(
    this: ConsoleStore,
    epoch: number,
    agentId: string,
    patch: { tokens?: number; contextWindow?: number | null; model?: string | null; measured?: boolean; compactedFrom?: number | null },
  ) {
    this.transaction(() => {
      const session = this.session(agentId);
      const r = this.get("SELECT * FROM console_gauges WHERE agent_id = ?", agentId);
      const same = !!r && r.session_id === session;
      const next = {
        tokens: patch.tokens ?? (same ? ((r!.tokens as number | null) ?? null) : null),
        // An explicit null (a report without a window) clears an older one,
        // and so does a request on another model than the window's.
        window:
          patch.contextWindow !== undefined
            ? patch.contextWindow
            : same && (patch.model === undefined || patch.model === r!.model)
              ? ((r!.context_window as number | null) ?? null)
              : null,
        model: patch.model !== undefined ? patch.model : same ? ((r!.model as string | null) ?? null) : null,
        measured: patch.measured ?? (patch.tokens !== undefined ? true : same ? r!.measured === 1 : true),
        compacted: patch.compactedFrom !== undefined ? patch.compactedFrom : same ? ((r!.compacted_from as number | null) ?? null) : null,
      };
      this.run(
        "INSERT INTO console_gauges (agent_id, session_id, tokens, context_window, model, measured, compacted_from, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET session_id = excluded.session_id, tokens = excluded.tokens, context_window = excluded.context_window, model = excluded.model, measured = excluded.measured, compacted_from = excluded.compacted_from, updated_at = excluded.updated_at",
        agentId, session, next.tokens, next.window, next.model, next.measured ? 1 : 0, next.compacted, this.now(),
      );
    }, epoch);
  },
  /** The gauge for the agent's current session, or null. */
  gauge(this: ConsoleStore, agentId: string): Gauge | null {
    const r = this.get("SELECT * FROM console_gauges WHERE agent_id = ?", agentId);
    if (!r || r.session_id !== this.session(agentId)) return null;
    return {
      tokens: (r.tokens as number | null) ?? null,
      contextWindow: (r.context_window as number | null) ?? null,
      measured: r.measured === 1,
      compactedFrom: (r.compacted_from as number | null) ?? null,
    };
  },

  /** Turns that ended since `since` and cost something or failed or were
   * interrupted, newest first, with their agent: the Overview's spend and
   * problems. */
  endedSince(this: ConsoleStore, since: number): EndedTurn[] {
    return this.all(
      "SELECT t.id, t.status, t.reason, t.started_at, t.ended_at, t.cost_usd, t.billing, a.id AS agent_id, a.name, a.tab_id, a.project_id, a.kind, a.model FROM console_turns t JOIN console_agents a ON a.id = t.agent_id WHERE t.ended_at >= ? AND (t.cost_usd IS NOT NULL OR t.status IN ('failed', 'interrupted')) ORDER BY t.ended_at DESC, t.id DESC",
      since,
    ).map((r) => ({
      id: r.id as number,
      status: r.status as TurnRow["status"],
      reason: (r.reason as string | null) ?? null,
      endedAt: r.ended_at as number,
      costUsd: (r.cost_usd as number | null) ?? null,
      agentId: r.agent_id as string,
      agentName: r.name as string,
      tabId: r.tab_id as string,
      projectId: r.project_id as string,
      kind: r.kind as ConsoleAgent["kind"],
      model: r.model as string,
      startedAt: (r.started_at as number | null) ?? null,
      paidBy: paidBy(r.billing),
    }));
  },

  /** Full-text search over the stored conversations: best matches first,
   * each with a snippet whose matches sit between \u0002 and \u0003.
   * `match` is FTS5 syntax (`ftsQuery` builds it). */
  search(this: ConsoleStore, match: string, limit: number): SearchHit[] {
    return this.all(
      "SELECT s.rowid AS row, snippet(console_search, 0, char(2), char(3), '…', 16) AS snippet, t.id, t.created_at, a.id AS agent_id, a.name, a.project_id, a.tab_id FROM console_search s JOIN console_turns t ON t.id = s.rowid / 2 JOIN console_agents a ON a.id = t.agent_id WHERE console_search MATCH ? ORDER BY s.rank LIMIT ?",
      match, limit,
    ).map((r) => ({
      turnId: r.id as number,
      reply: (r.row as number) % 2 === 1,
      snippet: r.snippet as string,
      createdAt: r.created_at as number,
      agentId: r.agent_id as string,
      agentName: r.name as string,
      projectId: r.project_id as string,
      tabId: r.tab_id as string,
    }));
  },

  /** A tab's turns, oldest first (the newest `limit`), with their agent:
   * the run report. Withdrawn messages are left out. */
  tabTurns(this: ConsoleStore, tabId: string, limit = 2000): TabTurn[] {
    return this.all(
      "SELECT * FROM (SELECT t.id, t.agent_id, a.name, t.trigger, t.prompt, t.status, t.reason, t.created_at, t.ended_at, t.final_text, t.cost_usd FROM console_turns t JOIN console_agents a ON a.id = t.agent_id WHERE a.tab_id = ? AND t.status <> 'withdrawn' ORDER BY t.id DESC LIMIT ?) ORDER BY id",
      tabId, limit,
    ).map((r) => ({
      id: r.id as number,
      agentId: r.agent_id as string,
      agentName: r.name as string,
      trigger: r.trigger as string,
      prompt: r.prompt as string,
      status: r.status as TurnRow["status"],
      reason: (r.reason as string | null) ?? null,
      createdAt: r.created_at as number,
      endedAt: (r.ended_at as number | null) ?? null,
      finalText: (r.final_text as string | null) ?? null,
      costUsd: (r.cost_usd as number | null) ?? null,
    }));
  },

  // ── Interrupted turns (Needs you) ───────────────────────────────────────
  interruptedTurns(this: ConsoleStore): (TurnRow & { agentName: string; projectId: string })[] {
    return this.all(
      "SELECT t.*, a.name AS agent_name, a.project_id FROM console_turns t JOIN console_agents a ON a.id = t.agent_id WHERE t.status = 'interrupted' AND t.trigger = 'owner' AND t.acknowledged = 0 AND a.state != 'closed' ORDER BY t.id",
    ).map((r) => ({ ...turn(r), agentName: r.agent_name as string, projectId: r.project_id as string }));
  },
  /** Send again (a new turn with the same message) or dismiss. Never
   * automatic. */
  acknowledgeTurn(this: ConsoleStore, turnId: number, resend: boolean): TurnRow | null {
    // One transaction: a refused Re-send (a summary request's checks)
    // leaves the turn waiting in Needs you.
    return this.transaction(() => {
      const t = this.turn(turnId);
      if (!t || t.status !== "interrupted" || t.acknowledged) throw new Error("That turn is no longer waiting.");
      this.run("UPDATE console_turns SET acknowledged = 1 WHERE id = ?", turnId);
      return resend ? this.queueTurn(t.agentId, t.prompt, turnId) : null;
    });
  },
};
