import { networkRequest } from "../permissions.ts";
import type { ConsoleRequest } from "../types.ts";
import type { ConsoleStore } from "../store.ts";
import { projectRule, request, type Row } from "./rows.ts";

/** What the agent is sent when the owner allows, for next time, a request
 * that closed unanswered. The same words each time, so several
 * such answers in a row queue one message. */
export const ALLOWED_SINCE =
  "[Console] The owner was away when you asked for a permission, and has now allowed it for next time. If something you needed was refused or got no answer, try it again.";
/** The same for "Ask again": nothing was allowed, but the owner is there. */
export const askAgainNote = (summary: string) =>
  `[Console] A request of yours got no answer because the owner was away: ${summary.slice(0, 300)}. The owner is here now. Ask again if you still need it.`;

/** What makes two requests of one agent the same request: the rule an
 * "Always" would remember or, where there is none, the tool and its line. */
const sameRequest = (r: Row) => (r.rule_key === null ? "rule_key IS NULL AND tool = ? AND summary = ?" : "rule_key = ?");
const sameArgs = (r: Row) => (r.rule_key === null ? [r.tool as string, r.summary as string] : [r.rule_key as string]);

// Permission requests and questions for the owner (Needs you), and the
// owner's "Always" rules.
export const requests = {
  /** A permission decision or an open request for the owner (Needs you).
   * Its stored input counts toward the turn's output bound. */
  recordRequest(
    this: ConsoleStore,
    epoch: number,
    r: {
      turnId: number;
      agentId: string;
      kind?: "permission" | "question";
      tool: string;
      summary?: string;
      input: string;
      ruleKey?: string | null;
      state: "open" | "allowed" | "denied";
      reason: string;
    },
  ): number {
    return this.transaction(() => {
      const now = this.now();
      this.addBytes(r.turnId, Buffer.byteLength(r.input, "utf8"));
      const decided = r.state !== "open";
      return this.insert(
        "INSERT INTO console_requests (turn_id, agent_id, kind, tool, summary, input, rule_key, state, decided_by, reason, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        r.turnId, r.agentId, r.kind ?? "permission", r.tool, r.summary ?? r.tool, r.input, r.ruleKey ?? null, r.state, decided ? "console" : null, r.reason, now, decided ? now : null,
      );
    }, epoch);
  },
  request(this: ConsoleStore, id: number): ConsoleRequest | undefined {
    const r = this.get("SELECT * FROM console_requests WHERE id = ?", id);
    return r && request(r);
  },
  /** The open requests (all projects, or one), oldest first. */
  openRequests(this: ConsoleStore): (ConsoleRequest & { agentName: string; agentKind: string; projectId: string; input: string })[] {
    return this.all(
      "SELECT r.*, a.name AS agent_name, a.kind AS agent_kind, a.project_id FROM console_requests r JOIN console_agents a ON a.id = r.agent_id JOIN console_tabs tb ON tb.id = a.tab_id JOIN console_projects p ON p.id = a.project_id WHERE r.state = 'open' AND tb.archived_at IS NULL AND p.archived_at IS NULL ORDER BY r.id",
    ).map((r) => ({ ...request(r), agentName: r.agent_name as string, agentKind: r.agent_kind as string, projectId: r.project_id as string, input: String(r.input ?? "") }));
  },
  /** Permission requests that closed unanswered and that the owner has not
   * dealt with since, oldest first: one row for each agent and
   * request (its latest), with how often it was asked. One is left out once
   * the same agent's later request for the same thing was answered or is
   * open now, or an "Always" rule covers it. */
  expiredRequests(this: ConsoleStore): (ConsoleRequest & { agentName: string; agentKind: string; projectId: string; input: string; count: number; expiredAt: number })[] {
    const rows = this.all(
      "SELECT r.*, a.name AS agent_name, a.kind AS agent_kind, a.project_id FROM console_requests r JOIN console_agents a ON a.id = r.agent_id JOIN console_tabs tb ON tb.id = a.tab_id JOIN console_projects p ON p.id = a.project_id WHERE r.state = 'expired' AND r.kind = 'permission' AND r.decided_by IS NULL AND a.state <> 'closed' AND tb.archived_at IS NULL AND p.archived_at IS NULL ORDER BY r.id",
    );
    const latest = new Map<string, { row: Row; count: number }>();
    for (const row of rows) {
      const key = JSON.stringify([row.agent_id, row.rule_key, row.rule_key === null ? [row.tool, row.summary] : null]);
      latest.set(key, { row, count: (latest.get(key)?.count ?? 0) + 1 });
    }
    return [...latest.values()]
      .filter(({ row }) => {
        if (row.rule_key !== null && this.hasRule(row.agent_id as string, row.rule_key as string)) return false;
        return !this.get(
          `SELECT 1 AS x FROM console_requests WHERE agent_id = ? AND id > ? AND kind = 'permission' AND state <> 'expired' AND ${sameRequest(row)} LIMIT 1`,
          row.agent_id as string, row.id as number, ...sameArgs(row),
        );
      })
      .map(({ row, count }) => ({
        ...request(row),
        agentName: row.agent_name as string,
        agentKind: row.agent_kind as string,
        projectId: row.project_id as string,
        input: String(row.input ?? ""),
        count,
        expiredAt: (row.decided_at as number | null) ?? (row.created_at as number),
      }));
  },
  /** The owner deals with a request that closed unanswered:
   * it and its repeats leave Needs you. "always" and "project" remember its
   * rule as they do for an open request, and "auto" switches the agent's
   * Network to Auto, so its next try passes; those three and "again" also
   * tell the agent, with a message of the owner's in its window. "dismiss"
   * does nothing else. False when it was no longer waiting there. */
  settleExpired(this: ConsoleStore, id: number, decision: "always" | "project" | "auto" | "again" | "dismiss"): boolean {
    return this.transaction(() => {
      const r = this.get("SELECT * FROM console_requests WHERE id = ? AND state = 'expired' AND kind = 'permission' AND decided_by IS NULL", id);
      if (!r) return false;
      const agentId = r.agent_id as string;
      const rule = r.rule_key as string | null;
      const network = networkRequest(r.tool as string, rule);
      if (decision === "always" && !rule) throw new Error("This one can only be allowed once.");
      if (decision === "project" && !rule?.startsWith("network:")) throw new Error("Only network access can be allowed for a whole project.");
      if (decision === "auto" && !network) throw new Error("Only network access is covered by the Network setting.");
      const settle = (where: string, ...args: string[]) =>
        this.run(`UPDATE console_requests SET decided_by = 'owner' WHERE state = 'expired' AND kind = 'permission' AND decided_by IS NULL AND ${where}`, ...args);
      settle(`agent_id = ? AND ${sameRequest(r)}`, agentId, ...sameArgs(r));
      const remember = (holder: string) => this.run("INSERT OR IGNORE INTO console_rules (agent_id, rule_key, created_at) VALUES (?, ?, ?)", holder, rule, this.now());
      // The same thing asked again and still waiting is allowed by the same
      // decision, as an open request's own decision does.
      const release = (where: string, ...args: string[]) =>
        this.run(`UPDATE console_requests SET state = 'allowed', decided_by = 'owner', decided_at = ? WHERE state = 'open' AND rule_key = ? AND ${where}`, this.now(), rule!, ...args);
      if (decision === "always") {
        remember(agentId);
        release("agent_id = ?", agentId);
      }
      if (decision === "project") {
        const projectId = this.agent(agentId)!.projectId;
        remember(projectRule(projectId));
        // The same host, unanswered for other agents of the project.
        settle("rule_key = ? AND agent_id IN (SELECT id FROM console_agents WHERE project_id = ?)", rule!, projectId);
        release("agent_id IN (SELECT id FROM console_agents WHERE project_id = ?)", projectId);
      }
      // Switching to Auto settles the agent's other network requests too.
      if (decision === "auto") this.networkAuto(agentId, true);
      if (decision === "dismiss") return true;
      const note = decision === "again" ? askAgainNote(r.summary as string) : ALLOWED_SINCE;
      const state = this.agent(agentId)?.state;
      const queued = this.get("SELECT 1 AS x FROM console_turns WHERE agent_id = ? AND status = 'queued' AND trigger = 'owner' AND prompt = ? LIMIT 1", agentId, note);
      if (state !== "closed" && state !== "error" && !queued) this.queueTurn(agentId, note);
      return true;
    });
  },
  /** The owner's answer to an open request. "always" also remembers the
   * request's rule for this agent; "project" remembers a network rule for
   * every agent of the agent's project. False when it was no longer
   * open. */
  decideRequest(this: ConsoleStore, id: number, decision: "allow" | "always" | "project" | "deny" | "answer", answer: string | null = null): boolean {
    return this.transaction(() => {
      const r = this.get("SELECT * FROM console_requests WHERE id = ? AND state = 'open'", id);
      if (!r) return false;
      if (decision === "project" && !String(r.rule_key ?? "").startsWith("network:")) throw new Error("Only network access can be allowed for a whole project.");
      const state = decision === "deny" ? "denied" : decision === "answer" ? "answered" : "allowed";
      this.run("UPDATE console_requests SET state = ?, decided_by = 'owner', answer = ?, decided_at = ? WHERE id = ?", state, answer, this.now(), id);
      const remember = (agentId: string) =>
        this.run("INSERT OR IGNORE INTO console_rules (agent_id, rule_key, created_at) VALUES (?, ?, ?)", agentId, r.rule_key as string, this.now());
      if (decision === "always" && r.rule_key) remember(r.agent_id as string);
      if (decision === "project") {
        const agent = this.get("SELECT project_id FROM console_agents WHERE id = ?", r.agent_id as string);
        if (agent) {
          remember(projectRule(agent.project_id as string));
          // The same host asked for by other agents of the project, still
          // open: allowed too, by the same decision.
          this.run(
            "UPDATE console_requests SET state = 'allowed', decided_by = 'owner', decided_at = ? WHERE state = 'open' AND rule_key = ? AND agent_id IN (SELECT id FROM console_agents WHERE project_id = ?)",
            this.now(), r.rule_key as string, agent.project_id as string,
          );
        }
      }
      return true;
    });
  },
  /** A new worker holds none of the earlier worker's waits: every open
   * request closes unanswered (its turn is interrupted). */
  expireOpenRequests(this: ConsoleStore, epoch: number): number {
    return this.transaction(() => this.run("UPDATE console_requests SET state = 'expired', decided_at = ? WHERE state = 'open'", this.now()), epoch);
  },
  /** Requests still open when their turn ends are closed unanswered. */
  expireRequests(this: ConsoleStore, epoch: number, turnId: number) {
    this.write(epoch, "UPDATE console_requests SET state = 'expired', decided_at = ? WHERE turn_id = ? AND state = 'open'", this.now(), turnId);
  },
  /** Forget the owner's "Always" rules: an agent's own, or a project's
   * project-wide ones. Returns how many were removed. */
  forgetRules(this: ConsoleStore, target: { agentId: string } | { projectId: string }): number {
    const key = "agentId" in target ? target.agentId : projectRule(target.projectId);
    return this.transaction(() => this.run("DELETE FROM console_rules WHERE agent_id = ?", key));
  },
  /** The owner allowed this always: for this agent, or (network) for its
   * whole project. */
  hasRule(this: ConsoleStore, agentId: string, key: string): boolean {
    return !!this.get(
      "SELECT 1 FROM console_rules WHERE rule_key = ? AND (agent_id = ? OR agent_id = 'project:' || (SELECT project_id FROM console_agents WHERE id = ?))",
      key, agentId, agentId,
    );
  },
};
