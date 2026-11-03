import type { ConsoleRequest } from "../types.ts";
import type { ConsoleStore } from "../store.ts";
import { projectRule, request } from "./rows.ts";

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
  /** Open requests in every project, oldest first, each with its whole
   * stored input (redacted, bounded): what "Allow once" approves. */
  openRequests(this: ConsoleStore): (ConsoleRequest & { agentName: string; projectId: string; input: string })[] {
    return this.all(
      "SELECT r.*, a.name AS agent_name, a.project_id FROM console_requests r JOIN console_agents a ON a.id = r.agent_id JOIN console_tabs tb ON tb.id = a.tab_id JOIN console_projects p ON p.id = a.project_id WHERE r.state = 'open' AND tb.archived_at IS NULL AND p.archived_at IS NULL ORDER BY r.id",
    ).map((r) => ({ ...request(r), agentName: r.agent_name as string, projectId: r.project_id as string, input: String(r.input ?? "") }));
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
