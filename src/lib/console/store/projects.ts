import type { AgentKind, ConsoleEffort } from "../agents.ts";
import type { ConsoleAgent, ConsoleProject, ConsoleTab, Permission, ProjectSource, ProjectState } from "../types.ts";
import type { ConsoleStore } from "../store.ts";
import type { TabTemplate, TemplateStep } from "../templates.ts";
import { agent, json, newId, project, tab } from "./rows.ts";

/** Ask me first is offered on Claude Code windows only. */
export const ASK_FIRST_CLAUDE_ONLY =
  "Ask me first is offered for Claude Code windows only: Codex's own check can let some commands run without asking, so it cannot hold every command for you yet.";

type Merging = { from: string; fromName: string; files: string[] };
type RoleRow = { id: string; name: string; description: string; access: string; ai: string; prompt: string; builtIn: boolean };

// Projects, tabs, agents and roles: the owner's commands, the worker's
// setup writes and the reads.
export const projects = {
  createProject(this: ConsoleStore, name: string, source: ProjectSource, repo: string | null = null, baseBranch = "main"): ConsoleProject {
    const id = newId("p");
    this.transaction(() => {
      this.run(
        "INSERT INTO console_projects (id, name, source, repo, base_branch, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id, name, source, repo, baseBranch, source === "github" ? "preparing" : "ready", this.now(),
      );
      this.run("INSERT INTO console_tabs (id, project_id, name, created_at) VALUES (?, ?, 'Main', ?)", newId("t"), id, this.now());
    });
    return this.project(id)!;
  },
  /** Names are for display only: paths and branches use ids. */
  rename(this: ConsoleStore, target: "project" | "tab" | "agent", id: string, name: string): boolean {
    const table = { project: "console_projects", tab: "console_tabs", agent: "console_agents" }[target];
    return this.run(`UPDATE ${table} SET name = ? WHERE id = ?`, name, id) === 1;
  },
  /** Every tab of every project, in creation order. */
  allTabs(this: ConsoleStore): ConsoleTab[] {
    return this.all("SELECT * FROM console_tabs ORDER BY created_at, rowid").map(tab);
  },
  createTab(this: ConsoleStore, projectId: string, name: string): ConsoleTab {
    const p = this.project(projectId);
    if (!p) throw new Error("That project does not exist.");
    if (p.archivedAt !== null) throw new Error("That project is archived. Restore it first.");
    const id = newId("t");
    this.run("INSERT INTO console_tabs (id, project_id, name, created_at) VALUES (?, ?, ?, ?)", id, projectId, name, this.now());
    return this.tab(id)!;
  },
  createAgent(
    this: ConsoleStore,
    input: { tabId: string; name: string; role: string; kind: AgentKind; model: string; effort: ConsoleEffort | null; permission: Permission; askFirst?: boolean },
  ): ConsoleAgent {
    const parent = this.tab(input.tabId);
    if (!parent) throw new Error("That tab does not exist.");
    if (parent.archivedAt !== null || this.project(parent.projectId)?.archivedAt != null) throw new Error("That tab is closed. Restore it first.");
    const id = newId("a");
    this.run(
      "INSERT INTO console_agents (id, tab_id, project_id, name, role, kind, model, effort, permission, ask_first, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?)",
      id, parent.id, parent.projectId, input.name, input.role, input.kind, input.model, input.effort, input.permission, input.askFirst ? 1 : 0, this.now(),
    );
    return this.agent(id)!;
  },
  /** Ask me first on or off: from the window's next turn. */
  setAskFirst(this: ConsoleStore, agentId: string, on: boolean): ConsoleAgent {
    const a = this.agent(agentId);
    if (!a || a.state === "closed") throw new Error("That agent is closed.");
    if (on && a.kind !== "claude-code") throw new Error(ASK_FIRST_CLAUDE_ONLY);
    this.run("UPDATE console_agents SET ask_first = ? WHERE id = ?", on ? 1 : 0, agentId);
    return this.agent(agentId)!;
  },
  closeAgent(this: ConsoleStore, agentId: string) {
    this.transaction(() => {
      if (!this.agent(agentId)) throw new Error("That agent does not exist.");
      this.closeRows([agentId], "interrupted");
    });
    this.requestStop(agentId, true);
  },
  /** Close agents (in a transaction). Mail they will never take waits in
   * Needs you ("interrupted": Re-send elsewhere is refused; Discard clears
   * it), or is discarded when their whole tab closes. */
  closeRows(this: ConsoleStore, agentIds: string[], mail: "interrupted" | "discarded") {
    const now = this.now();
    for (const agentId of agentIds) {
      this.run("UPDATE console_agents SET state = 'closed' WHERE id = ?", agentId);
      this.run("UPDATE console_messages SET state = ?, ended_at = ? WHERE to_agent = ? AND state = 'queued'", mail, now, agentId);
      // Its claims and holds end with it.
      this.run("UPDATE console_claims SET released_at = ? WHERE agent_id = ? AND released_at IS NULL", now, agentId);
      this.run("UPDATE console_holds SET released_at = ? WHERE (holder = ? OR held = ?) AND released_at IS NULL", now, agentId, agentId);
    }
  },
  /** Archive a project or close a tab: every agent in it closes as Close
   * does (a running turn is force stopped), and it is hidden. The store
   * keeps everything; folders wait for Clean up. A project keeps at least
   * one open tab. Returns the agents closed. */
  archive(this: ConsoleStore, scope: "project" | "tab", id: string): string[] {
    const closed = this.transaction(() => {
      const now = this.now();
      let inScope: string[];
      if (scope === "project") {
        const p = this.project(id);
        if (!p) throw new Error("That project does not exist.");
        if (p.archivedAt !== null) throw new Error("That project is already archived.");
        inScope = this.agents(id).map((a) => a.id);
        this.run("UPDATE console_projects SET archived_at = ? WHERE id = ?", now, id);
      } else {
        const t = this.tab(id);
        if (!t) throw new Error("That tab does not exist.");
        if (t.archivedAt !== null) throw new Error("That tab is already closed.");
        if (this.project(t.projectId)?.archivedAt != null) throw new Error("That project is archived.");
        if (!this.tabs(t.projectId).some((o) => o.id !== id && o.archivedAt === null))
          throw new Error("A project keeps at least one open tab. Archive the project instead.");
        inScope = this.agents(t.projectId).filter((a) => a.tabId === id).map((a) => a.id);
        this.run("UPDATE console_tabs SET archived_at = ? WHERE id = ?", now, id);
      }
      const open = inScope.filter((a) => this.agent(a)!.state !== "closed");
      this.closeRows(open, "discarded");
      // The whole team's mail is discarded: waiting, in a running turn (its
      // stop would otherwise mark it interrupted) or already interrupted,
      // for agents closed now or earlier.
      for (const agentId of inScope)
        this.run("UPDATE console_messages SET state = 'discarded', ended_at = ? WHERE to_agent = ? AND state IN ('queued', 'in_turn', 'interrupted')", now, agentId);
      return open;
    });
    for (const agentId of closed) this.requestStop(agentId, true);
    return closed;
  },
  /** Restore an archived project or a closed tab. Its agents stay closed:
   * nothing starts. */
  restore(this: ConsoleStore, scope: "project" | "tab", id: string) {
    this.transaction(() => {
      if (scope === "project") {
        const p = this.project(id);
        if (!p) throw new Error("That project does not exist.");
        if (p.archivedAt === null) throw new Error("That project is not archived.");
        this.run("UPDATE console_projects SET archived_at = NULL WHERE id = ?", id);
        return;
      }
      const t = this.tab(id);
      if (!t) throw new Error("That tab does not exist.");
      if (t.archivedAt === null) throw new Error("That tab is not closed.");
      if (this.project(t.projectId)?.archivedAt != null) throw new Error("Restore its project first.");
      this.run("UPDATE console_tabs SET archived_at = NULL WHERE id = ?", id);
    });
  },

  projects(this: ConsoleStore): ConsoleProject[] {
    return this.all("SELECT * FROM console_projects ORDER BY created_at, rowid").map(project);
  },
  project(this: ConsoleStore, id: string): ConsoleProject | undefined {
    const r = this.get("SELECT * FROM console_projects WHERE id = ?", id);
    return r && project(r);
  },
  tabs(this: ConsoleStore, projectId: string): ConsoleTab[] {
    return this.all("SELECT * FROM console_tabs WHERE project_id = ? ORDER BY created_at, rowid", projectId).map(tab);
  },
  tab(this: ConsoleStore, id: string): ConsoleTab | undefined {
    const r = this.get("SELECT * FROM console_tabs WHERE id = ?", id);
    return r && tab(r);
  },
  agents(this: ConsoleStore, projectId?: string): ConsoleAgent[] {
    const rows = projectId
      ? this.all("SELECT * FROM console_agents WHERE project_id = ? ORDER BY created_at, rowid", projectId)
      : this.all("SELECT * FROM console_agents ORDER BY created_at, rowid");
    return rows.map(agent);
  },
  agent(this: ConsoleStore, id: string): ConsoleAgent | undefined {
    const r = this.get("SELECT * FROM console_agents WHERE id = ?", id);
    return r && agent(r);
  },
  agentOf(this: ConsoleStore, turnId: number): ConsoleAgent {
    const r = this.get("SELECT a.* FROM console_agents a JOIN console_turns t ON t.agent_id = a.id WHERE t.id = ?", turnId);
    if (!r) throw new Error(`Turn ${turnId} has no agent.`);
    return agent(r);
  },
  session(this: ConsoleStore, agentId: string): string | null {
    return (this.get("SELECT session_id FROM console_sessions WHERE agent_id = ?", agentId)?.session_id as string | undefined) ?? null;
  },

  // ── Worker writes (fenced by the lease epoch) ──────────────────────────
  setAgentFolder(this: ConsoleStore, epoch: number, agentId: string, folder: string) {
    this.write(epoch, "UPDATE console_agents SET folder = ?, state = 'ready', error = NULL WHERE id = ? AND state = 'creating'", folder, agentId);
  },
  setAgentError(this: ConsoleStore, epoch: number, agentId: string, error: string) {
    this.transaction(() => {
      this.run("UPDATE console_agents SET state = 'error', error = ? WHERE id = ? AND state = 'creating'", error, agentId);
      // Messages queued while it was being set up wait in Needs you.
      this.run("UPDATE console_messages SET state = 'interrupted', ended_at = ? WHERE to_agent = ? AND state = 'queued'", this.now(), agentId);
    }, epoch);
  },
  setSession(this: ConsoleStore, epoch: number, agentId: string, sessionId: string) {
    this.write(
      epoch,
      "INSERT INTO console_sessions (agent_id, session_id, epoch, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET session_id = excluded.session_id, epoch = excluded.epoch, updated_at = excluded.updated_at",
      agentId, sessionId, epoch, this.now(),
    );
  },
  setProjectState(this: ConsoleStore, epoch: number, projectId: string, state: ProjectState, error: string | null) {
    this.write(epoch, "UPDATE console_projects SET state = ?, error = ? WHERE id = ?", state, error, projectId);
  },
  /** The agent's branch and the commit its changes are compared with. */
  setAgentBase(this: ConsoleStore, epoch: number, agentId: string, branch: string | null, baseCommit: string) {
    this.write(epoch, "UPDATE console_agents SET branch = ?, base_commit = ? WHERE id = ?", branch, baseCommit, agentId);
  },
  agentBase(this: ConsoleStore, agentId: string): { branch: string | null; baseCommit: string | null } {
    const r = this.get("SELECT branch, base_commit FROM console_agents WHERE id = ?", agentId);
    return { branch: (r?.branch as string | null) ?? null, baseCommit: (r?.base_commit as string | null) ?? null };
  },
  /** A team's Orchestrator waits for its members: none of its turns starts
   * while one of them is still being set up, so the goal, queued first, is
   * the first thing it does. */
  setWaitFor(this: ConsoleStore, agentId: string, members: string[]) {
    this.run("UPDATE console_agents SET start_after = ? WHERE id = ?", JSON.stringify(members), agentId);
  },
  waitFor(this: ConsoleStore, agentId: string): string[] {
    return (json(this.get("SELECT start_after FROM console_agents WHERE id = ?", agentId)?.start_after) as string[] | null) ?? [];
  },
  clearWaitFor(this: ConsoleStore, agentId: string) {
    this.run("UPDATE console_agents SET start_after = NULL WHERE id = ?", agentId);
  },
  /** A merge from team_pull waiting for its conflicts: from whom, which files. */
  setMerging(this: ConsoleStore, epoch: number, agentId: string, merging: Merging | null) {
    this.write(epoch, "UPDATE console_agents SET merging = ? WHERE id = ?", merging ? JSON.stringify(merging) : null, agentId);
  },
  merging(this: ConsoleStore, agentId: string): Merging | null {
    return json(this.get("SELECT merging FROM console_agents WHERE id = ?", agentId)?.merging) as Merging | null;
  },

  // ── Roles ────────────────────────────────────────────
  /** The owner's rows: rewritten built-in prompts and their own roles. */
  roleRows(this: ConsoleStore): RoleRow[] {
    return this.all("SELECT * FROM console_roles ORDER BY built_in DESC, updated_at, id").map((r) => ({
      id: r.id as string,
      name: r.name as string,
      description: r.description as string,
      access: r.access as string,
      ai: r.ai as string,
      prompt: r.prompt as string,
      builtIn: !!r.built_in,
    }));
  },
  saveRole(this: ConsoleStore, r: RoleRow) {
    this.run(
      "INSERT INTO console_roles (id, name, description, access, ai, prompt, built_in, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, access = excluded.access, ai = excluded.ai, prompt = excluded.prompt, updated_at = excluded.updated_at",
      r.id, r.name, r.description, r.access, r.ai, r.prompt, r.builtIn ? 1 : 0, this.now(),
    );
  },
  /** Delete the owner's role, or a built-in's rewritten prompt (reset). */
  deleteRole(this: ConsoleStore, id: string): boolean {
    return this.run("DELETE FROM console_roles WHERE id = ?", id) === 1;
  },

  // ── Templates ───────────────────────────────────────
  /** Save a template under its name: a template of that name is replaced. */
  saveTemplate(this: ConsoleStore, name: string, body: TabTemplate): string {
    const id = (this.get("SELECT id FROM console_templates WHERE name = ?", name)?.id as string | undefined) ?? newId("m");
    this.run(
      "INSERT INTO console_templates (id, name, body, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
      id, name, JSON.stringify(body), this.now(),
    );
    return id;
  },
  templates(this: ConsoleStore): { id: string; name: string; body: TabTemplate }[] {
    return this.all("SELECT * FROM console_templates ORDER BY name").map((r) => ({ id: r.id as string, name: r.name as string, body: json(r.body) as TabTemplate }));
  },
  deleteTemplate(this: ConsoleStore, id: string): boolean {
    return this.run("DELETE FROM console_templates WHERE id = ?", id) === 1;
  },
  /** A tab's steps, set once when it is made from a template, and the
   * current one; null for a tab without steps. */
  tabSteps(this: ConsoleStore, tabId: string): { steps: TemplateStep[]; index: number } | null {
    const r = this.get("SELECT steps, step FROM console_tabs WHERE id = ?", tabId);
    const steps = r?.steps ? (json(r.steps) as TemplateStep[]) : null;
    return steps?.length ? { steps, index: r!.step as number } : null;
  },
  setTabSteps(this: ConsoleStore, tabId: string, steps: TemplateStep[]) {
    this.run("UPDATE console_tabs SET steps = ?, step = 0 WHERE id = ?", JSON.stringify(steps), tabId);
  },
  setStep(this: ConsoleStore, tabId: string, index: number) {
    this.run("UPDATE console_tabs SET step = ? WHERE id = ?", index, tabId);
  },
};
