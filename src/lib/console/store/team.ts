import { isOpen, type ConsoleAgent, type ConsoleTab } from "../types.ts";
import type { ConsoleStore } from "../store.ts";
import { claimsOverlap, holdCycle } from "../claims.ts";
import { HoldCycleError, REPORT_MAX, REPORTS_PER_TURN, SHARE_MAX, TeamError, type ToolCall } from "../team.ts";
import type { Proposal } from "../team-setup.ts";
import { safeCut, tab } from "./rows.ts";

/** A Needs you item an agent or the Console made: a note, a team_report,
 * or a proposed tab with its team. */
export interface Notice {
  id: number;
  agentId: string;
  agentName: string;
  projectId: string;
  kind: "note" | "report" | "proposal";
  text: string;
  proposal: Proposal | null;
  createdAt: number;
}

type Call = { turnId: number; agentId: string; key: string; tool: string; summary: string };

/** A turn's durable team payload (messages, replies, reports, tool-call
 * records) counts against the same bound as its events. */
function room(store: ConsoleStore, turnId: number, bytes: number, refused: string) {
  if (store.turnBytes(turnId) + bytes > store.turnBytesLimit)
    throw new TeamError(`This turn has stored as much as one turn may (${Math.round(store.turnBytesLimit / (1024 * 1024))} MB); ${refused}. End your turn.`);
}

// The team tools' records (each call once per turn), and the claims, holds
// and notices they make.
export const team = {
  /** A team-tool call already made in this turn: its recorded result. */
  toolCall(this: ConsoleStore, turnId: number, key: string): string | null {
    return (this.get("SELECT result FROM console_tool_calls WHERE turn_id = ? AND call_key = ?", turnId, key)?.result as string | undefined) ?? null;
  },
  toolCalls(this: ConsoleStore, turnId: number): ToolCall[] {
    return this.all("SELECT * FROM console_tool_calls WHERE turn_id = ? ORDER BY id", turnId).map((r) => ({
      turnId: r.turn_id as number,
      tool: r.tool as string,
      summary: r.summary as string,
      result: r.result as string,
    }));
  },
  insertToolCall(this: ConsoleStore, c: Call & { result: string }) {
    this.chargePayload(c.turnId, Buffer.byteLength(c.summary, "utf8") + Buffer.byteLength(c.result, "utf8"));
    this.run(
      "INSERT INTO console_tool_calls (turn_id, agent_id, call_key, tool, summary, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      c.turnId, c.agentId, c.key, c.tool, c.summary, c.result, this.now(),
    );
  },
  /** A team tool whose effect happens outside the store checks first that
   * its record will fit, so an effect is never made and then refused its
   * record. */
  ensurePayloadRoom(this: ConsoleStore, turnId: number, bytes: number) {
    room(this, turnId, bytes, "nothing was done");
  },
  /** Inside a transaction: the payload is refused at the effect, never
   * stored past the bound. */
  chargePayload(this: ConsoleStore, turnId: number, bytes: number) {
    room(this, turnId, bytes, "nothing more was sent");
    this.addBytes(turnId, bytes);
  },
  /** A team-tool effect and its record in one transaction: the same call
   * again in this turn returns the first result. */
  callOnce(this: ConsoleStore, epoch: number, c: Call, work: () => string): string {
    return this.transaction(() => {
      const done = this.toolCall(c.turnId, c.key);
      if (done !== null) return done;
      const result = work();
      this.insertToolCall({ ...c, result });
      return result;
    }, epoch);
  },
  /** Journal an external effect before it happens: the row says the effect
   * may have happened, so a crash between the effect and its result leaves
   * the Re-send note saying so. `settleToolCall` then replaces it with the
   * result. */
  journalToolCall(this: ConsoleStore, epoch: number, c: Call & { result: string }) {
    this.recordToolCall(epoch, c);
  },
  settleToolCall(this: ConsoleStore, epoch: number, turnId: number, key: string, result: string) {
    this.transaction(() => {
      // The result's growth counts too; past the bound the effect has
      // happened already, so it is recorded and the turn simply full.
      const grow = Buffer.byteLength(result, "utf8") - Buffer.byteLength(this.toolCall(turnId, key) ?? "", "utf8");
      this.run("UPDATE console_tool_calls SET result = ? WHERE turn_id = ? AND call_key = ?", result, turnId, key);
      if (grow > 0) this.addBytes(turnId, grow);
    }, epoch);
  },
  /** Record a call whose effect happened outside the store (team_pull,
   * team_push and the like). */
  recordToolCall(this: ConsoleStore, epoch: number, c: Call & { result: string }) {
    this.transaction(() => {
      if (this.toolCall(c.turnId, c.key) === null) this.insertToolCall(c);
    }, epoch);
  },

  // ── Claims, holds and notices ─────────────────────────────
  /** Active claims in a tab (not released, not expired, agent open). */
  claims(this: ConsoleStore, tabId: string): { id: number; agentId: string; agentName: string; pattern: string; note: string; expiresAt: number }[] {
    return this.all(
      "SELECT c.*, a.name AS agent_name FROM console_claims c JOIN console_agents a ON a.id = c.agent_id WHERE c.tab_id = ? AND c.released_at IS NULL AND c.expires_at > ? AND a.state != 'closed' ORDER BY c.id",
      tabId, this.now(),
    ).map((r) => ({
      id: r.id as number,
      agentId: r.agent_id as string,
      agentName: r.agent_name as string,
      pattern: r.pattern as string,
      note: r.note as string,
      expiresAt: r.expires_at as number,
    }));
  },
  /** team_claim: refused when another agent's claim may overlap; recorded
   * with the call (repeating it returns the first result). */
  addClaims(this: ConsoleStore, epoch: number, c: { turnId: number; agent: ConsoleAgent; patterns: string[]; note: string; ttlMs: number; key: string; summary: string }): string {
    return this.callOnce(epoch, { turnId: c.turnId, agentId: c.agent.id, key: c.key, tool: "team_claim", summary: c.summary }, () => {
      const others = this.claims(c.agent.tabId).filter((x) => x.agentId !== c.agent.id);
      const clash = others.filter((x) => c.patterns.some((p) => claimsOverlap(p, x.pattern)));
      if (clash.length)
        throw new TeamError(
          `Already claimed: ${clash.map((x) => `${x.agentName} is editing ${x.pattern}${x.note ? ` (${x.note})` : ""}`).join("; ")}. Ask them, or wait for team_release.`,
        );
      const now = this.now();
      for (const p of c.patterns) {
        // A claim made again is renewed, not doubled.
        this.run("UPDATE console_claims SET released_at = ? WHERE agent_id = ? AND pattern = ? AND released_at IS NULL", now, c.agent.id, p);
        this.run(
          "INSERT INTO console_claims (tab_id, agent_id, pattern, note, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
          c.agent.tabId, c.agent.id, p, c.note, now, now + c.ttlMs,
        );
      }
      return `Claimed ${c.patterns.join(", ")} until ${new Date(now + c.ttlMs).toISOString().slice(11, 16)} UTC. Release them with team_release when you are done.`;
    });
  },
  /** team_release (all of the agent's claims when none are named). */
  releaseClaims(this: ConsoleStore, epoch: number, agentId: string, patterns: string[]): number {
    return this.transaction(() => {
      const now = this.now();
      if (!patterns.length) return this.run("UPDATE console_claims SET released_at = ? WHERE agent_id = ? AND released_at IS NULL", now, agentId);
      let n = 0;
      for (const p of patterns) n += this.run("UPDATE console_claims SET released_at = ? WHERE agent_id = ? AND pattern = ? AND released_at IS NULL", now, agentId, p);
      return n;
    }, epoch);
  },
  /** The owner releases any claim. */
  releaseClaim(this: ConsoleStore, id: number): boolean {
    return this.run("UPDATE console_claims SET released_at = ? WHERE id = ? AND released_at IS NULL", this.now(), id) === 1;
  },
  /** Active holds in a tab. */
  holds(this: ConsoleStore, tabId: string): { id: number; holder: string; holderName: string; held: string; heldName: string; reason: string; expiresAt: number }[] {
    return this.all(
      "SELECT h.*, a.name AS holder_name, b.name AS held_name FROM console_holds h JOIN console_agents a ON a.id = h.holder JOIN console_agents b ON b.id = h.held WHERE h.tab_id = ? AND h.released_at IS NULL AND h.expires_at > ? AND a.state NOT IN ('closed', 'error') AND b.state NOT IN ('closed', 'error') ORDER BY h.id",
      tabId, this.now(),
    ).map((r) => ({
      id: r.id as number,
      holder: r.holder as string,
      holderName: r.holder_name as string,
      held: r.held as string,
      heldName: r.held_name as string,
      reason: r.reason as string,
      expiresAt: r.expires_at as number,
    }));
  },
  /** Who holds this agent now (the oldest active hold), or null. */
  heldBy(this: ConsoleStore, agent: Pick<ConsoleAgent, "id" | "tabId">): { id: number; holderName: string; reason: string } | null {
    return this.holds(agent.tabId).find((h) => h.held === agent.id) ?? null;
  },
  addHold(
    this: ConsoleStore,
    epoch: number,
    h: { turnId: number; tabId: string; holder: string; held: string; reason: string; ttlMs: number; key: string; summary: string; result: string },
  ): string {
    return this.callOnce(epoch, { turnId: h.turnId, agentId: h.holder, key: h.key, tool: "team_hold", summary: h.summary }, () => {
      // Read again here: either may have closed meanwhile.
      for (const id of [h.holder, h.held]) {
        const a = this.agent(id);
        if (!isOpen(a)) throw new TeamError(`${a?.name ?? "That agent"} can no longer take part in a hold.`);
      }
      // And the cycle check against the holds as they are now.
      const cycle = holdCycle(
        this.holds(h.tabId).map((x) => ({ holder: x.holder, held: x.held })),
        h.holder,
        h.held,
      );
      if (cycle) throw new HoldCycleError(cycle);
      const now = this.now();
      this.releaseHold(h.holder, h.held);
      this.run("INSERT INTO console_holds (tab_id, holder, held, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", h.tabId, h.holder, h.held, h.reason, now, now + h.ttlMs);
      return h.result;
    });
  },
  /** Lift the holder's hold on one agent (inside callOnce's transaction). */
  releaseHold(this: ConsoleStore, holder: string, held: string): number {
    return this.run("UPDATE console_holds SET released_at = ? WHERE holder = ? AND held = ? AND released_at IS NULL", this.now(), holder, held);
  },
  /** The owner lifts a hold. */
  releaseHoldById(this: ConsoleStore, id: number): boolean {
    return this.run("UPDATE console_holds SET released_at = ? WHERE id = ? AND released_at IS NULL", this.now(), id) === 1;
  },
  /** Something the owner should know (Needs you), for example an edit in
   * another agent's claim. */
  addNotice(this: ConsoleStore, epoch: number, agentId: string, text: string) {
    this.write(epoch, "INSERT INTO console_notices (agent_id, text, created_at) VALUES (?, ?, ?)", agentId, text, this.now());
  },
  /** team_report: the call's record and its Needs you item in one
   * transaction; the same call again in this turn adds nothing. */
  reportToOwner(this: ConsoleStore, epoch: number, r: { turnId: number; agentId: string; key: string; summary: string; text: string }): string {
    return this.callOnce(epoch, { turnId: r.turnId, agentId: r.agentId, key: r.key, tool: "team_report", summary: r.summary }, () => {
      const filed = Number(this.get("SELECT COUNT(*) AS n FROM console_tool_calls WHERE turn_id = ? AND tool = 'team_report'", r.turnId)!.n);
      if (filed >= REPORTS_PER_TURN)
        throw new TeamError(`You have already filed ${filed} reports in this turn; put everything else the owner needs in one of them, or in your final message.`);
      this.run("INSERT INTO console_notices (agent_id, text, kind, created_at) VALUES (?, ?, 'report', ?)", r.agentId, r.text, this.now());
      this.chargePayload(r.turnId, Buffer.byteLength(r.text, "utf8"));
      return "Put in the owner's Needs you. This does not wait for an answer: the owner answers, if at all, with a message in your window. Carry on, or end your turn if you cannot go on without the answer.";
    });
  },
  // ── Proposed tabs ──────────────────────────────────────────
  /** team_propose_tab: the call's record and its Needs you item, with the
   * team as the setup screen takes it, in one transaction. */
  proposeTab(this: ConsoleStore, epoch: number, r: { turnId: number; agentId: string; key: string; summary: string; text: string; proposal: Proposal }): string {
    return this.callOnce(epoch, { turnId: r.turnId, agentId: r.agentId, key: r.key, tool: "team_propose_tab", summary: r.summary }, () => {
      const data = JSON.stringify(r.proposal);
      this.run("INSERT INTO console_notices (agent_id, text, kind, data, created_at) VALUES (?, ?, 'proposal', ?, ?)", r.agentId, r.text, data, this.now());
      this.chargePayload(r.turnId, Buffer.byteLength(data, "utf8"));
      return `Proposed the tab "${r.proposal.name}" to the owner (their Needs you). This does not wait: you are told when they create or decline it. Carry on with what does not depend on it, or end your turn.`;
    });
  },
  /** The owner's answer to a proposal, once: its Needs you item goes, a
   * tab made from it is linked to the proposing agent, and that agent is
   * told (a message of the owner's, in its window) unless it is closed.
   * `owed`: the tab has a goal, whose result goes back (`sendResult`). */
  settleProposal(this: ConsoleStore, noticeId: number, made: { tabId: string; leadId: string; owed: boolean } | null, note: string) {
    this.transaction(() => {
      const n = this.get("SELECT agent_id FROM console_notices WHERE id = ? AND kind = 'proposal' AND dismissed = 0", noticeId);
      if (!n) throw new Error("That proposal has already been answered.");
      this.run("UPDATE console_notices SET dismissed = 1 WHERE id = ?", noticeId);
      const agentId = n.agent_id as string;
      if (made) this.run("UPDATE console_tabs SET parent_agent = ?, lead_agent = ?, result_sent = ? WHERE id = ?", agentId, made.leadId, made.owed ? 0 : 1, made.tabId);
      if (isOpen(this.agent(agentId))) this.queueTurn(agentId, note);
    });
  },
  /** The agents of other tabs an agent is linked to: the lead
   * of each tab it proposed, and the agent that proposed its own tab when it
   * is that tab's lead. Open agents of open tabs only, at both ends: none
   * for an agent that is closed or failed itself, or whose tab is closed
   * (read afresh, so every caller gets the same answer). */
  linkedAgents(this: ConsoleStore, agent: ConsoleAgent): ConsoleAgent[] {
    if (!isOpen(this.agent(agent.id)) || this.tab(agent.tabId)?.archivedAt !== null) return [];
    const ids = this.all(
      "SELECT lead_agent AS id FROM console_tabs WHERE parent_agent = ? AND archived_at IS NULL UNION SELECT parent_agent FROM console_tabs WHERE lead_agent = ? AND archived_at IS NULL",
      agent.id, agent.id,
    ).map((r) => r.id as string | null);
    return ids
      .map((id) => (id ? this.agent(id) : undefined))
      .filter((a): a is ConsoleAgent => !!a && a.id !== agent.id && a.tabId !== agent.tabId && a.state !== "closed" && this.tab(a.tabId)?.archivedAt === null);
  },
  /** Proposed tabs whose result has not gone back to the proposing agent. */
  resultsOwed(this: ConsoleStore): ConsoleTab[] {
    return this.all("SELECT * FROM console_tabs WHERE parent_agent IS NOT NULL AND lead_agent IS NOT NULL AND result_sent = 0 AND archived_at IS NULL").map(tab);
  },
  /** A proposed tab has come to rest: its lead's final message goes to the
   * agent that proposed it, once, as a route's would (shortened past
   * SHARE_MAX, the rest by team_read). Nothing is sent while the lead's
   * latest turn did not finish (the owner settles that first), or wrote to
   * that agent itself. With the
   * proposing agent closed, it goes to Needs you instead. */
  sendResult(this: ConsoleStore, epoch: number, tabId: string) {
    this.transaction(() => {
      const t = this.get("SELECT * FROM console_tabs WHERE id = ? AND result_sent = 0", tabId);
      if (!t?.parent_agent || !t.lead_agent) return;
      // A lead the owner closed has no result to send: the link is gone.
      const leadState = this.agent(t.lead_agent as string)?.state;
      if (leadState === "closed" || leadState === "error") {
        this.run("UPDATE console_tabs SET result_sent = 1 WHERE id = ?", tabId);
        return;
      }
      // Never a summary turn: that is the agent's own handoff.
      const last = this.get(
        "SELECT id, status, final_text, instruction_id FROM console_turns WHERE agent_id = ? AND status NOT IN ('withdrawn', 'steered') AND summary = 0 ORDER BY id DESC LIMIT 1",
        t.lead_agent as string,
      );
      const text = ((last?.final_text as string | null) ?? "").trim();
      if (!last || last.status !== "done" || !text) return;
      // That turn wrote to the proposing agent itself (a message, an ask, an
      // answer, its final message as one): it has what the turn had to say,
      // and the result is still to come.
      if (this.get("SELECT 1 AS x FROM console_messages WHERE to_agent = ? AND from_turn = ? LIMIT 1", t.parent_agent as string, last.id as number)) return;
      this.run("UPDATE console_tabs SET result_sent = 1 WHERE id = ?", tabId);
      const parent = this.agent(t.parent_agent as string);
      const now = this.now();
      if (!parent || !isOpen(parent) || this.tab(parent.tabId)?.archivedAt !== null) {
        this.run(
          "INSERT INTO console_notices (agent_id, text, created_at) VALUES (?, ?, ?)",
          t.lead_agent as string, `The result of the tab "${t.name as string}", whose proposing agent is closed:\n\n${text.slice(0, safeCut(text, REPORT_MAX))}`, now,
        );
        return;
      }
      const id = this.insert(
        "INSERT INTO console_messages (tab_id, from_agent, to_agent, kind, correlation_id, body, state, from_turn, instruction_id, created_at) VALUES (?, ?, ?, 'route', NULL, ?, 'queued', ?, ?, ?)",
        tabId, t.lead_agent as string, parent.id, text.slice(0, safeCut(text, SHARE_MAX)), last.id as number, (last.instruction_id as number | null) ?? null, now,
      );
      this.passOn(last.id as number, id, text);
    }, epoch);
  },
  notices(this: ConsoleStore): Notice[] {
    return this.all(
      "SELECT n.*, a.name AS agent_name, a.project_id FROM console_notices n JOIN console_agents a ON a.id = n.agent_id JOIN console_tabs tb ON tb.id = a.tab_id JOIN console_projects p ON p.id = a.project_id WHERE n.dismissed = 0 AND tb.archived_at IS NULL AND p.archived_at IS NULL ORDER BY n.id",
    ).map((r) => ({
      id: r.id as number,
      agentId: r.agent_id as string,
      agentName: r.agent_name as string,
      projectId: r.project_id as string,
      kind: r.kind === "report" || r.kind === "proposal" ? r.kind : "note",
      text: r.text as string,
      proposal: r.kind === "proposal" ? (JSON.parse(r.data as string) as Proposal) : null,
      createdAt: r.created_at as number,
    }));
  },
  dismissNotice(this: ConsoleStore, id: number): boolean {
    // A proposal is answered (Create or Decline), so its agent is told.
    return this.run("UPDATE console_notices SET dismissed = 1 WHERE id = ? AND dismissed = 0 AND kind <> 'proposal'", id) === 1;
  },
};
