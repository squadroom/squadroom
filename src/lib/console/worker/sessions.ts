import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mcpConfigPath } from "../claude-session.ts";
import { errorMessage as message, type AgentSession, type SessionContext, type SessionEvent } from "../session.ts";
import { mapTaskText, type TaskOp } from "../tasks.ts";
import type { ConsoleAgent, TurnStatus } from "../types.ts";
import type { ConsoleWorker } from "../worker.ts";
import { SYSTEM, type ActiveTurn, type Runtime } from "./shared.ts";
import { currentStepFiles } from "../templates.ts";

// Agents' folders and their client sessions: GitHub projects prepared,
// folders made where no sandbox would miss them, sessions opened, replaced
// and retired (closed agents, Start fresh, the ACP network switch), their
// MCP bearer tokens, and what their events mean to the turn.

export const sessions = {
  /** GitHub projects: checks and the mirror before any clone. */
  prepareProjects(this: ConsoleWorker): void {
    for (const project of this.store.projects()) {
      // An archived project is not prepared; Restore resumes it.
      if (project.source !== "github" || project.state !== "preparing" || project.archivedAt !== null || this.preparing.has(project.id)) continue;
      this.preparing.add(project.id);
      void this.repos
        .prepare(project)
        .then(() => this.safe(() => this.store.setProjectState(this.epoch!, project.id, "ready", null)))
        .catch((error: unknown) => this.safe(() => this.store.setProjectState(this.epoch!, project.id, "error", this.redactor.text(message(error)))))
        .finally(() => this.preparing.delete(project.id));
    }
  },

  /** A running turn whose sandbox lists the folders that existed when it
   * started, and that a new folder in this project would escape: Codex's
   * (every folder on the Mac) and ACP agents' (their project's). */
  holdsFolders(this: ConsoleWorker, projectId: string): boolean {
    // A new project's first folder is outside every running sandbox's list.
    const fresh = !this.projectDirExists(projectId);
    return [...this.runtimes.values()].some((rt) => {
      if (!rt.turn) return false;
      return this.drivers.get(rt.agent.kind)?.folderScope === "project" && (fresh || rt.agent.projectId === projectId);
    });
  },

  /** A sandboxed (ACP) program of any agent of the project, live or
   * exiting, still runs in one of its folders. */
  sandboxInProject(this: ConsoleWorker, projectId: string): boolean {
    const folders = this.store.agents(projectId).map((a) => a.folder).filter(Boolean);
    return folders.some((f) => [...this.drivers.values()].some((d) => d.sandboxed && d.usesFolder(f)));
  },

  /** The project's ACP sessions still running (idle ones are retired here,
   * and count until their programs have exited). */
  projectSessionsLive(this: ConsoleWorker, projectId: string): boolean {
    let live = false;
    for (const rt of this.runtimes.values()) {
      if (rt.agent.projectId !== projectId || !this.drivers.get(rt.agent.kind)?.sandboxed || !rt.session) continue;
      if (!rt.turn && !rt.busy) this.retire(rt);
      live = true;
    }
    return live || this.sandboxInProject(projectId);
  },

  /** New agents' folders. A folder is made only while no turn runs whose
   * sandbox would not know it; those sessions then take the new list before
   * their next turn. */
  createFolders(this: ConsoleWorker): void {
    for (const agent of this.store.agents()) {
      if (agent.state !== "creating" || this.creating.has(agent.id)) continue;
      const project = this.store.project(agent.projectId);
      if (!project) continue;
      if (this.holdsFolders(agent.projectId)) continue;
      // An idle ACP program of the project would not have the new clone
      // denied either: each is retired, and has exited, first.
      if (this.projectSessionsLive(agent.projectId)) continue;
      if (project.state === "preparing") continue;
      if (project.state === "error") {
        this.safe(() => this.store.setAgentError(this.epoch!, agent.id, `The project is not ready: ${project.error ?? "unknown error"}`));
        continue;
      }
      this.creating.add(agent.id);
      void this.repos
        .createFolder(agent, project)
        .then(({ folder, branch, base }) =>
          this.safe(() => {
            this.store.setAgentBase(this.epoch!, agent.id, branch, base);
            this.store.setAgentFolder(this.epoch!, agent.id, folder);
          }),
        )
        .catch((error: unknown) => this.safe(() => this.store.setAgentError(this.epoch!, agent.id, this.redactor.text(message(error)))))
        .finally(() => this.creating.delete(agent.id));
    }
  },

  /** A closed agent's process ends once it is idle; a running turn is
   * force-stopped first (Close requests that). */
  closeAgents(this: ConsoleWorker): void {
    for (const [id, rt] of this.runtimes) {
      if (rt.turn || rt.busy || this.store.agent(id)?.state !== "closed") continue;
      this.retire(rt);
      this.runtimes.delete(id);
      rmSync(mcpConfigPath(this.options.paths.shared, id), { force: true });
    }
  },

  /** Start fresh: an agent whose conversation the owner cleared drops its
   * idle process or thread, so its next turn starts a new one. Its folder,
   * branch and transcript stay. */
  freshStarts(this: ConsoleWorker): void {
    for (const rt of this.runtimes.values()) {
      if (!this.cleared(rt.agent.id) || rt.turn || rt.busy || !rt.session) continue;
      if (this.store.openTurns().some((t) => t.agentId === rt.agent.id && t.status !== "queued")) continue;
      this.sessionSaved.delete(rt.agent.id);
      this.retire(rt);
      this.safe(() =>
        this.store.addAgentEvent(this.epoch!, rt.agent.id, "note", { text: "Started fresh: the next message begins a new conversation. The folder and branch are unchanged." }),
      );
    }
  },

  /** The project's network switch for ACP agents: a change waits for (or,
   * with Stop now, stops) the project's running ACP turns, then every ACP
   * session there is retired, and once their processes have exited the
   * setting shows as changed; new sessions start under it. */
  networkChanges(this: ConsoleWorker): void {
    for (const project of this.store.projects()) {
      const change = this.store.acpNetworkChange(project.id);
      if (!change) continue;
      const acp = [...this.runtimes.values()].filter((rt) => rt.agent.projectId === project.id && this.drivers.get(rt.agent.kind)?.sandboxed);
      const running = acp.filter((rt) => rt.turn);
      if (running.length) {
        if (change.now) for (const rt of running) if (!rt.turn!.stopping) this.stopTurn(rt, "Stopped: the project's network setting is changing.", "stopped", false);
        continue;
      }
      for (const rt of acp) if (rt.session && !rt.busy) this.retire(rt);
      if (acp.some((rt) => rt.session || rt.busy)) continue;
      if (this.sandboxInProject(project.id)) continue;
      this.safe(() => this.store.applyAcpNetwork(this.epoch!, project.id, change.on));
      this.log(`project ${project.id}: network for ACP agents is now ${change.on ? "on" : "off"}`);
    }
  },

  /** A project's folder under the agent's work folder exists already. */
  projectDirExists(this: ConsoleWorker, projectId: string | undefined): boolean {
    return !!projectId && existsSync(join(this.options.paths.agentHome, "work", projectId));
  },
  /** What a Codex thread denies: every other project's folder that exists,
   * and its own project's other clones that still exist (a closed agent's
   * folder that Clean up removed drops out). */
  codexDenied(this: ConsoleWorker, agent: ConsoleAgent): string[] {
    const work = join(this.options.paths.agentHome, "work");
    const projects = this.store.projects().map((p) => join(work, p.id)).filter((dir) => dir !== join(work, agent.projectId) && existsSync(dir));
    const mates = this.store.agents(agent.projectId).map((a) => a.folder).filter((f) => f && f !== agent.folder && existsSync(f));
    return [...projects, ...mates];
  },
  /** Every agent folder on the Mac (closed agents' folders stay on disk). */
  allFolders(this: ConsoleWorker): string[] {
    return this.store.agents().map((a) => a.folder).filter(Boolean);
  },

  // ── Client sessions ───────────────────────────────────────────────────

  /** The runtime's client session, opened when there is none (or its
   * process ended), or replaced when the owner cleared the conversation
   * (Start fresh) or its fixed settings no longer match. */
  ensureSession(this: ConsoleWorker, rt: Runtime): AgentSession {
    const agent = rt.agent;
    if (rt.session && !rt.session.exited && this.cleared(agent.id)) {
      this.sessionSaved.delete(agent.id);
      this.retire(rt);
    }
    // A session started with another credential (the key or login token
    // changed, globally or for the project) is replaced: its process holds
    // the old one.
    const credential = rt.credential ?? this.credentialFor(agent, rt.model);
    if (rt.session && !rt.session.exited && (rt.session.stale(agent) || rt.sessionLogin !== rt.login || rt.sessionCredential !== credential.print)) this.retire(rt);
    if (rt.session && !rt.session.exited) return rt.session;
    if (rt.session) this.revoke(rt);
    let me: AgentSession | null = null;
    const ctx: SessionContext = {
      agent,
      model: rt.model,
      credentials: credential.credentials,
      emit: (event) => {
        // A replaced generation (evicted, closed) never touches the runtime.
        if (!me || rt.session !== me) return;
        try {
          this.sessionEvent(rt, event);
        } catch (error) {
          this.log(`event handling failed: ${message(error)}`);
        }
      },
      permit: (tool, input, policy) => (me && rt.session === me ? this.permit(rt, tool, input, policy) : Promise.resolve({ allow: false, always: false, answer: null, reason: "This agent session has ended." })),
      newToken: () => this.newToken(agent.id, rt),
      storedSession: () => this.store.session(agent.id),
      documentsOnly: !!this.store.tabSteps(agent.tabId),
      stepFiles: () => currentStepFiles(this.store.tabSteps(agent.tabId)),
      system: () => {
        // Where the agent's branch started, for its instructions.
        const project = this.store.project(agent.projectId);
        return SYSTEM(agent, { ...this.store.agentBase(agent.id), commits: !!project && project.source !== "none" });
      },
    };
    me = this.driver(agent.kind).open(ctx);
    rt.session = me;
    rt.sessionLogin = rt.login;
    rt.sessionCredential = credential.print;
    return me;
  },

  saveSession(this: ConsoleWorker, epoch: number, agentId: string, sessionId: string): void {
    this.store.setSession(epoch, agentId, sessionId);
    this.sessionSaved.add(agentId);
  },

  newToken(this: ConsoleWorker, agentId: string, rt: Runtime): string {
    this.revoke(rt);
    // One bearer token per process or thread, revoked when it ends.
    const token = randomBytes(32).toString("hex");
    this.redactor.add(token);
    this.tokens.set(token, agentId);
    rt.token = token;
    return token;
  },

  /** The owner cleared this agent's saved conversation (Start fresh) since
   * its process or thread last saved one. */
  cleared(this: ConsoleWorker, agentId: string): boolean {
    return this.sessionSaved.has(agentId) && this.store.session(agentId) === null;
  },

  /** Take a runtime's session out of service (closed agent, eviction, Start
   * fresh, settings changed): its token is revoked at once, and its driver
   * ends what it ran once idle (a process of its own stays tracked until it
   * has exited). */
  retire(this: ConsoleWorker, rt: Runtime): void {
    const session = rt.session;
    this.revoke(rt);
    rt.session = null;
    session?.close();
  },
  revoke(this: ConsoleWorker, rt: Runtime): void {
    if (rt.token) this.tokens.delete(rt.token);
    rt.token = null;
  },

  /** One event of a runtime's current session. */
  sessionEvent(this: ConsoleWorker, rt: Runtime, ev: SessionEvent): void {
    const epoch = this.epoch;
    if (epoch === null) return;
    if (ev.kind === "ended") {
      // Its process (or its thread's server) is gone: the token goes with it.
      this.revoke(rt);
      const t = rt.turn;
      if (!t || this.stopped) return;
      return this.finish(rt, t.stopping?.status ?? ev.status, t.stopping?.reason ?? ev.reason);
    }
    const t = rt.turn;
    if (!t) return;
    if (ev.kind === "refused") {
      // A late refusal: nothing was accepted, so not a paid request.
      t.prompted = false;
      this.safe(() => this.store.markPrompted(epoch, t.id, false));
      return this.finish(rt, "failed", ev.reason);
    }
    if (ev.kind === "completed") return this.completed(rt, t, ev);
    // A turn that broke a rule keeps nothing more.
    if (t.stopping?.status === "failed") return;
    t.lastActivity = this.now();
    switch (ev.kind) {
      case "validated":
        t.validated = true;
        if (ev.sessionId) this.safe(() => this.saveSession(epoch, rt.agent.id, ev.sessionId!));
        return;
      case "session":
        // Only a turn whose login and model were confirmed keeps its session.
        if (t.validated) this.safe(() => this.saveSession(epoch, rt.agent.id, ev.sessionId));
        return;
      case "violation":
        return this.failTurn(rt, ev.reason);
      case "rate_limit":
        // The login is out of usage: its queue pauses, with the reason on
        // the page, until the reported reset.
        this.safe(() => this.store.setPause(epoch, rt.login, ev.until));
        return t.events.emit("error", { text: ev.text });
      case "delta":
        if (ev.marks !== false) t.streamed = true;
        return t.events.stream(ev.stream, ev.text);
      case "message":
        if (ev.stream === "text" && ev.text.trim()) t.lastText = ev.text;
        if (!t.streamed) t.events.emit(ev.stream, { text: ev.text });
        return;
      case "tool":
        return t.events.emit("tool", { id: ev.id, name: ev.name, summary: ev.summary });
      case "tool_result":
        return t.events.toolResult(ev.id, ev.text, ev.error);
      case "usage": {
        const sum = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
        t.usage = {
          inputTokens: sum(t.usage?.inputTokens, ev.usage.inputTokens),
          cacheReadTokens: sum(t.usage?.cacheReadTokens, ev.usage.cacheReadTokens),
          cacheWriteTokens: sum(t.usage?.cacheWriteTokens, ev.usage.cacheWriteTokens),
          outputTokens: sum(t.usage?.outputTokens, ev.usage.outputTokens),
        };
        return;
      }
      case "request_start":
        t.gaugePending = true;
        return;
      case "gauge":
        if (ev.measuredOnly && !t.gaugeSeen) return;
        if (ev.update.tokens !== undefined) {
          t.gaugeSeen = true;
          t.gaugePending = false;
        }
        return void this.safe(() => this.store.setGauge(epoch, rt.agent.id, ev.update));
      case "task_call":
        return void this.safe(() => this.store.taskCall(epoch, rt.agent.id, ev.id, this.taskOp(ev.op)));
      case "task_result":
        // Redacted like the ids it is matched with (a created task's id).
        return void this.safe(() => this.store.taskResult(epoch, rt.agent.id, ev.id, ev.ok, this.redactor.text(ev.text)));
      case "task_list":
        return void this.safe(() => this.store.taskList(epoch, rt.agent.id, this.taskOp(ev.op)));
      case "task_unfollowed":
        return void this.safe(() => this.store.taskUnfollowed(epoch, rt.agent.id));
      case "helper_start": {
        // A helper (subagent) begins: its row, redacted and bounded.
        const clean = (text: string, fallback: string) => this.redactor.text(text).replace(/\s+/g, " ").trim() || fallback;
        return void this.safe(() =>
          this.store.startHelper(epoch, { agentId: rt.agent.id, turnId: t.id, toolUseId: ev.toolUseId, name: clean(ev.name, "Helper"), type: clean(ev.type, "helper") }),
        );
      }
      case "helper_tool":
        return void this.safe(() => this.store.helperTool(epoch, t.id, ev.parent, ev.summary));
      case "helper_end":
        return void this.safe(() => this.store.finishHelper(epoch, t.id, ev.toolUseId, ev.subagentId));
      case "error":
        return t.events.emit("error", { text: ev.text });
      case "permission":
        return t.events.emit("permission", { tool: ev.tool, decision: ev.decision, reason: ev.reason });
      case "oversize":
        return this.stopTurn(rt, "Output limit: one line of output was too long.", "stopped", false);
    }
  },
  /** The client ended the turn. A stop that was under way decides how it
   * ended, except that a start whose acceptance was unknown and that
   * completed before the stop reached it did run and finish: done. */
  completed(this: ConsoleWorker, rt: Runtime, t: ActiveTurn, ev: Extract<SessionEvent, { kind: "completed" }>): void {
    const label = this.driver(rt.agent.kind).label;
    // A client that ended the turn had it: never a free attempt.
    this.afterSending(t);
    if (ev.outcome === "done" && !t.lastText && ev.text?.trim()) t.lastText = ev.text;
    const ran = ev.outcome === "done" && !!t.stopping?.unknownStart;
    let status: TurnStatus;
    let reason: string | null;
    if (ran) [status, reason] = ["done", null];
    else if (t.stopping) [status, reason] = [t.stopping.status, t.stopping.reason];
    else if (!t.validated) [status, reason] = ["failed", `${label} ended the turn before confirming its login and model.`];
    else if (ev.outcome === "done") [status, reason] = ["done", null];
    else [status, reason] = [ev.outcome, this.redactor.text(ev.error ?? `${label} ended the turn.`).slice(0, 500)];
    return this.finish(rt, status, reason, { usage: ev.usage });
  },
  taskOp(this: ConsoleWorker, op: TaskOp): TaskOp {
    return mapTaskText(op, (text) => this.redactor.text(text));
  },
};
