import { readRunning, type BilledModel, type RunningUsage } from "../spend.ts";
import type { ConsoleAgent, EventBody, EventKind, TurnStatus, TurnUsage } from "../types.ts";
import type { SessionTotals } from "../session.ts";
import type { ConsoleStore } from "../store.ts";
import { OPEN } from "./rows.ts";
import { SUMMARY_MAX } from "./turns.ts";

type Charge = { usd: number; basis: "reported" | "allowance"; hold?: string };
/** What a turn is priced as and the key that pays for it, kept with it when
 * it starts. `print`: the key's fingerprint ("" for none). */
interface TurnBilling {
  model: BilledModel;
  key: { scope: "project" | "global" | null; print: string };
}
const RESTARTED = "The Console worker restarted during this turn.";

// Turns from the worker's side (fenced by the lease epoch): claiming and
// ending them, charging them, their events and their retention.
export const lifecycle = {
  /** Claim a queued turn; false when it was stopped meanwhile. `billing`
   * is kept with it. */
  startTurn(this: ConsoleStore, epoch: number, turnId: number, billing: TurnBilling | null = null): boolean {
    return this.transaction(() => {
      const agent = this.agentOf(turnId);
      // Pause is checked in the same transaction, so a Pause cannot be
      // crossed by a turn being claimed at that moment; so is a usage hold,
      // which pauses its tab again only on the worker's next pass (a Resume
      // of its project or of everything lifts the pause, not the hold).
      if (this.pausedFor(agent)) return false;
      if (this.get("SELECT usage_hold FROM console_tabs WHERE id = ?", agent.tabId)?.usage_hold != null) return false;
      // Only the head of the agent's queue, read now: a Send next or Edit
      // that committed first is what runs. A team turn held by a teammate
      // waits without blocking the owner's own messages, as the schedule
      // does.
      const held = !!this.heldBy(agent);
      if (this.queuedTurns(agent.id).find((q) => !(held && q.trigger === "team"))?.id !== turnId) return false;
      const now = this.now();
      const changed = this.run(
        "UPDATE console_turns SET status = 'running', epoch = ?, started_at = ?, billing = ? WHERE id = ? AND status = 'queued'",
        epoch, now, billing ? JSON.stringify(billing) : null, turnId,
      );
      if (changed) this.run("UPDATE console_turns SET started_seq = ? WHERE id = ?", this.insertEvent(turnId, agent, "status", { status: "running" }, now), turnId);
      return changed === 1;
    }, epoch);
  },
  /** End a turn. Its delivered messages settle with it: done, with each
   * unanswered ask answered by `finalText`; otherwise interrupted.
   * `totals`, its client's running usage totals, are kept only with its
   * charge, in this transaction: totals saved without the charge would let
   * the next turn be charged less than it used. */
  finishTurn(
    this: ConsoleStore,
    epoch: number,
    turnId: number,
    status: TurnStatus,
    reason: string | null,
    usage?: TurnUsage | null,
    finalText: string | null = null,
    charge: Charge | null = null,
    totals: SessionTotals | null = null,
  ): boolean {
    return this.transaction(() => {
      const now = this.now();
      const changed = this.run(
        `UPDATE console_turns SET status = ?, reason = ?, usage = COALESCE(?, usage), ended_at = ?, cost_usd = COALESCE(?, cost_usd), cost_basis = COALESCE(?, cost_basis) WHERE id = ? AND status IN (${OPEN})`,
        status, reason, usage ? JSON.stringify(usage) : null, now, charge?.usd ?? null, charge?.basis ?? null, turnId,
      );
      if (changed) {
        const agent = this.agentOf(turnId);
        const seq = this.insertEvent(turnId, agent, "status", { status, reason }, now);
        // Kept as routes and answers carry it (trimmed), so team_read's
        // offsets match what was delivered.
        this.run("UPDATE console_turns SET ended_seq = ?, final_text = ? WHERE id = ?", seq, finalText?.trim() || null, turnId);
        if (charge?.hold) this.holdForUsage(agent.tabId, charge.hold);
        if (charge && totals)
          this.run(
            "INSERT INTO console_session_totals (agent_id, session_id, totals) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET session_id = excluded.session_id, totals = excluded.totals",
            agent.id, totals.sessionId, JSON.stringify(totals.value),
          );
        this.settle(turnId, status, finalText, now);
        const summary = !!this.turn(turnId)?.summary;
        // A summary is the agent's own handoff, never routed.
        if (status === "done" && finalText?.trim() && !summary) this.route(turnId, finalText.trim(), now);
        if (summary) this.endSummary(turnId, status, finalText, now);
        this.settleHelpers(turnId, now);
        this.settleTasks(agent.id);
      }
      return changed === 1;
    }, epoch);
  },
  /** A summary turn ended: done with text clears the session and holds the
   * summary; anything else leaves the session as it was. */
  endSummary(this: ConsoleStore, turnId: number, status: TurnStatus, finalText: string | null, now: number) {
    const agent = this.agentOf(turnId);
    const text = finalText?.trim();
    if (status === "done" && text) {
      this.run("DELETE FROM console_sessions WHERE agent_id = ?", agent.id);
      this.run("UPDATE console_agents SET carry_summary = ? WHERE id = ?", text.slice(0, SUMMARY_MAX), agent.id);
      this.insertEvent(turnId, agent, "note", { text: "Fresh session: the next message begins a new conversation, opened with this summary." }, now);
    } else this.insertEvent(turnId, agent, "note", { text: "No summary was written, so the session was kept. Ask again, or use Start fresh." }, now);
  },
  /** The prompt reached the client: kept, so a worker that dies before the
   * turn ends still charges it at the next start. */
  markPrompted(this: ConsoleStore, epoch: number, turnId: number, on = true) {
    this.write(epoch, "UPDATE console_turns SET prompted = ? WHERE id = ?", on ? 1 : 0, turnId);
  },
  /** What a running turn's client has reported so far. */
  setRunning(this: ConsoleStore, epoch: number, turnId: number, running: RunningUsage) {
    this.write(epoch, `UPDATE console_turns SET running = ? WHERE id = ? AND status IN (${OPEN})`, JSON.stringify(running), turnId);
  },
  /** Inside a transaction: an uncharged turn's cost, and its tab's usage
   * hold when it is charged its full allowance. */
  recordCharge(this: ConsoleStore, turnId: number, charge: Charge) {
    const changed = this.run("UPDATE console_turns SET cost_usd = ?, cost_basis = ? WHERE id = ? AND cost_usd IS NULL", charge.usd, charge.basis, turnId);
    if (changed && charge.hold) this.holdForUsage(this.agentOf(turnId).tabId, charge.hold);
  },
  /** After a restart, running turns of an earlier worker become
   * interrupted: they wait for the owner and are never replayed. A paid
   * turn whose prompt had reached the client is charged in the same
   * transaction (`charge`, from the agent, what the turn was priced as when
   * it started (null when none was kept) and what its client had reported:
   * the allowance for what it did not, and its tab's usage hold), so no
   * crash between the two leaves it uncharged. */
  interruptEarlier(
    this: ConsoleStore,
    epoch: number,
    charge: (turn: { id: number; agent: ConsoleAgent; billing: TurnBilling | null; running: RunningUsage }) => Charge | null = () => null,
  ): number {
    return this.transaction(() => {
      const stale = this.openTurns().filter((t) => t.status !== "queued" && t.epoch !== epoch);
      for (const t of stale) {
        const row = this.get("SELECT prompted, cost_usd, billing, running FROM console_turns WHERE id = ?", t.id) ?? {};
        const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : null);
        const owed =
          row.prompted === 1 && row.cost_usd === null
            ? charge({ id: t.id, agent: this.agentOf(t.id), billing: parse(row.billing) as TurnBilling | null, running: readRunning(parse(row.running)) })
            : null;
        if (owed) this.recordCharge(t.id, owed);
        this.run("UPDATE console_turns SET status = 'interrupted', reason = ?, ended_at = ? WHERE id = ?", RESTARTED, this.now(), t.id);
        const seq = this.insertEvent(t.id, this.agentOf(t.id), "status", { status: "interrupted", reason: RESTARTED }, this.now());
        this.run("UPDATE console_turns SET ended_seq = ? WHERE id = ?", seq, t.id);
        this.settle(t.id, "interrupted", null, this.now());
        this.settleHelpers(t.id, this.now());
      }
      // A restart finds task calls whose results it never saw.
      this.run("UPDATE console_tasks SET stale = 1, pending = '{}' WHERE pending <> '{}'");
      return stale.length;
    }, epoch);
  },
  /** A running turn waits for the owner (or stops waiting); the time spent
   * waiting is excluded from its limits. */
  setWaiting(this: ConsoleStore, epoch: number, turnId: number, waiting: boolean, waitedMs = 0) {
    this.write(
      epoch,
      "UPDATE console_turns SET status = ?, waited_ms = waited_ms + ? WHERE id = ? AND status = ?",
      waiting ? "waiting_for_owner" : "running", waitedMs, turnId, waiting ? "running" : "waiting_for_owner",
    );
  },
  /** One event row, already redacted and bounded by the caller; the turn's
   * stored size grows with it. Returns the new row's id. */
  addEvent(this: ConsoleStore, epoch: number, turnId: number, kind: EventKind, body: EventBody): number {
    return this.transaction(() => this.insertEvent(turnId, this.agentOf(turnId), kind, body, this.now()), epoch);
  },
  /** A transcript row that belongs to no turn (an upload). */
  addAgentEvent(this: ConsoleStore, epoch: number, agentId: string, kind: EventKind, body: EventBody): number {
    return this.transaction(() => {
      const a = this.agent(agentId);
      if (!a) throw new Error("That agent does not exist.");
      return this.insertEvent(0, a, kind, body, this.now());
    }, epoch);
  },
  insertEvent(this: ConsoleStore, turnId: number, a: ConsoleAgent, kind: EventKind, body: EventBody, now: number): number {
    const text = JSON.stringify(body);
    this.addBytes(turnId, Buffer.byteLength(text, "utf8"));
    return this.insert("INSERT INTO console_events (turn_id, agent_id, project_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)", turnId, a.id, a.projectId, kind, text, now);
  },
  /** What a turn has stored (events and its durable team payload). */
  turnBytes(this: ConsoleStore, turnId: number): number {
    return Number(this.get("SELECT bytes FROM console_turns WHERE id = ?", turnId)?.bytes ?? 0);
  },
  addBytes(this: ConsoleStore, turnId: number, bytes: number) {
    this.run("UPDATE console_turns SET bytes = bytes + ? WHERE id = ?", bytes, turnId);
  },
  /**
   * Retention: turns that ended before `before` keep their transcript's
   * outline only: the owner's message, the tool rows (their summaries),
   * permissions, notes, errors and statuses, and the last text the agent
   * wrote; streamed thinking, tool output and earlier text go. At most
   * `limit` turns per call, so one call stays short. Returns how many
   * turns were compacted.
   */
  compactEvents(this: ConsoleStore, epoch: number, before: number, limit = 50): number {
    return this.transaction(() => {
      const turns = this.all("SELECT id FROM console_turns WHERE compacted = 0 AND ended_at IS NOT NULL AND ended_at < ? ORDER BY id LIMIT ?", before, limit);
      for (const { id } of turns) {
        // The last text is the run of text rows after the last tool or
        // permission that comes before the turn's last text row (streamed
        // text is stored in pieces; a tool, note or error after the text,
        // such as a final team tool or a summary's note, does not end it):
        // so it reads whole. Events are append-only, so nothing is joined.
        const after = Number(
          this.get(
            "SELECT COALESCE(MAX(id), 0) AS id FROM console_events WHERE turn_id = ? AND kind IN ('tool', 'permission') AND id < (SELECT COALESCE(MAX(id), 0) FROM console_events WHERE turn_id = ? AND kind = 'text')",
            id as number, id as number,
          )!.id,
        );
        this.run("DELETE FROM console_events WHERE turn_id = ? AND (kind IN ('thinking', 'tool_result') OR (kind = 'text' AND id <= ?))", id as number, after);
        this.run("UPDATE console_turns SET compacted = 1 WHERE id = ?", id as number);
      }
      return turns.length;
    }, epoch);
  },
};
