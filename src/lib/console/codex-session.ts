import { join } from "node:path";
import { agentModel } from "./agents.ts";
import { fingerprint } from "./spend.ts";
import { CodexError, CodexServer, readCodexNotification, type CodexEvent, type LateReply } from "./codex.ts";
import { CLONE_TMP } from "./git.ts";
import { CODEX_PROFILE, codexThreadConfig, decideCodexCommand, decideCodexFiles } from "./permissions.ts";
import { CODEX_DISABLED, type ConsoleAgent } from "./types.ts";
import { Ending, endProcesses, errorMessage as message, type AgentDriver, type AgentSession, type DriverHost, type PromptResult, type SessionContext, type TurnRequest } from "./session.ts";

// The Codex driver behind the session seam: one App Server per login (the
// ChatGPT one, and one per OpenAI API key), a thread per window. That the server is shared is this driver's
// business: ending it for one window ends every Codex window's turn, which
// it names, and a turn/start whose answer timed out is reported `unknown`
// and settled from the thread's own notifications. A server is owned from
// its spawn.

class CodexSession implements AgentSession {
  readonly ctx: SessionContext;
  private driver: CodexLoginDriver;
  /** Its thread on the current server, the config it has, and its last
   * turn's id (a late event of that turn is not the next one's). */
  thread: { id: string; key: string; lastTurnId?: string | null } | null = null;
  exited = false;
  // This turn's state.
  turn: TurnRequest | null = null;
  private turnId: string | null = null;
  /** turn/start returned (in time, late, or by the thread's notification).
   * Until then its usage and end wait in `early`, since only the returned
   * id tells this turn's. */
  private started = false;
  private early: CodexEvent[] = [];
  /** The handler for a turn/start reply that comes after its timeout. */
  private late: LateReply | undefined;
  /** The id a turn/started notification gave before the reply did. */
  private seenTurnId: string | null = null;
  /** turn/start timed out: the outcome is unknown. */
  private unknown = false;
  private stopWanted = false;
  /** The owner's Force stop: no other Codex turn starts until the server
   * is ended or the interrupt lands. */
  forcing = false;
  /** Each item's file paths (the file-change approval checks them). */
  items = new Map<string, string[]>();

  constructor(driver: CodexLoginDriver, ctx: SessionContext) {
    this.driver = driver;
    this.ctx = ctx;
  }
  stale() {
    return false;
  }

  async prompt(turn: TurnRequest): Promise<PromptResult> {
    this.turn = turn;
    this.turnId = null;
    this.started = false;
    this.early = [];
    this.late = undefined;
    this.seenTurnId = null;
    this.unknown = false;
    this.stopWanted = false;
    this.forcing = false;
    this.items = new Map();
    let server: CodexServer;
    let threadId: string;
    try {
      server = await this.driver.server();
      threadId = await this.ensureThread(server);
    } catch (error) {
      return { outcome: "refused", reason: message(error) };
    }
    // The thread confirmed the ChatGPT login (at the server's start), the
    // model and the permission profile.
    this.ctx.emit({ kind: "validated", sessionId: threadId });
    if (this.turn !== turn || !turn.wanted()) return { outcome: "refused", reason: "The turn ended before it started." };
    const turnIdOf = (result: Record<string, unknown>) => String((result.turn as { id?: unknown } | undefined)?.id ?? "") || null;
    // A reply after the timeout still settles this turn: a result names it;
    // a refusal means nothing was accepted, so it is failed without ending
    // the shared server (unless the thread already named a turn, which is
    // believed over the refusal).
    const late: LateReply = (reply) => {
      if (this.turn !== turn) return;
      if ("result" in reply) this.start(turnIdOf(reply.result));
      else if (!this.started) this.ctx.emit({ kind: "refused", reason: reply.refused });
    };
    this.late = late;
    const { agent, model } = this.ctx;
    let result: Record<string, unknown>;
    try {
      turn.sending();
      result = await server.call(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: turn.text, text_elements: [] }],
          model: model.model,
          ...(agent.effort && model.efforts.includes(agent.effort) ? { effort: agent.effort } : {}),
        },
        this.driver.callMs,
        late,
      );
    } catch (error) {
      // A refusal or the server's end: nothing started. A timeout is not
      // that: the server may have accepted the turn and be running it.
      if (!(error instanceof CodexError) || error.outcome !== "unknown") return { outcome: "refused", reason: message(error) };
      this.unknown = true;
      return { outcome: "unknown" };
    }
    this.start(turnIdOf(result));
    return { outcome: "started" };
  }

  /** turn/start answered (in time, late, or by the thread's first
   * notification about a new turn): events held back until the id was
   * known are replayed, and a stop that arrived meanwhile is sent. */
  private start(turnId: string | null) {
    if (this.started || !this.turn) return;
    this.turnId = turnId;
    this.started = true;
    this.turn.delivered();
    if (this.late) this.driver.current?.forget(this.late);
    this.late = undefined;
    for (const ev of this.early.splice(0)) this.onEvent(ev);
    if (this.stopWanted) this.sendInterrupt();
  }

  interrupt(options: { force?: boolean } = {}) {
    this.stopWanted = true;
    if (options.force) this.forcing = true;
    // An unacknowledged start adopts the id the server already gave
    // (turn/started before the reply), so the interrupt goes out at once.
    if (!this.started && this.unknown && this.seenTurnId) return this.start(this.seenTurnId);
    this.sendInterrupt();
  }
  private sendInterrupt() {
    const server = this.driver.current;
    if (!this.turnId || !this.thread || !server) return;
    void server.call("turn/interrupt", { threadId: this.thread.id, turnId: this.turnId }).catch(() => {});
  }
  terminate(reason: string) {
    return this.driver.end(this, reason);
  }
  endTurn() {
    // A start never acknowledged ends with whatever usage its thread
    // reported meanwhile counted as its own: not a free attempt.
    if (!this.started && this.unknown) {
      const first = this.early.find((ev): ev is Extract<CodexEvent, { type: "usage" }> => ev.type === "usage" && !!ev.turnId && ev.turnId !== this.thread?.lastTurnId);
      this.turnId = first?.turnId ?? null;
      this.started = true;
      for (const ev of this.early.splice(0)) if (ev.type === "usage") this.addUsage(ev);
    }
    if (this.late) this.driver.current?.forget(this.late);
    this.late = undefined;
    if (this.thread && this.turnId) this.thread.lastTurnId = this.turnId;
    this.turn = null;
    this.forcing = false;
  }
  close() {
    this.exited = true;
    if (this.thread) this.driver.threads.delete(this.thread.id);
    this.thread = null;
    this.driver.sessions.delete(this);
  }

  /** The agent's thread, started or resumed with the current config: the
   * profile lists every other folder, so a thread whose list is out of date
   * is resumed (which also re-sends the config) before its next turn. */
  private async ensureThread(server: CodexServer): Promise<string> {
    const host = this.driver.host;
    const { agent, model } = this.ctx;
    const tmp = join(agent.folder, CLONE_TMP);
    const others = host.codexDenied(agent);
    const key = JSON.stringify({ others, permission: agent.permission, server: server.pid });
    if (this.thread && this.thread.key === key) return this.thread.id;
    await host.launcher.mkdir(agent.folder, CLONE_TMP);
    const token = this.ctx.newToken();
    const config = codexThreadConfig(agent, others, host.paths, { url: host.mcpUrl(), token }, tmp, !!model.paid);
    const params = {
      model: model.model,
      modelProvider: "openai",
      cwd: agent.folder,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      config,
      developerInstructions: this.ctx.system(),
    };
    const session = this.ctx.storedSession();
    let result: Record<string, unknown> | null = null;
    if (session)
      result = await server.call("thread/resume", { threadId: session, ...params }).catch((error: unknown) => {
        host.log(`thread ${session} could not be resumed (${message(error)}); starting a new one`);
        return null;
      });
    result ??= await server.call("thread/start", { ...params, ephemeral: false });
    const id = String((result.thread as { id?: unknown } | undefined)?.id ?? "");
    // The profile and its parent: Look only must resolve to `:read-only`.
    const active = result.activePermissionProfile as { id?: unknown; extends?: unknown } | undefined;
    const parent = agent.permission === "look" ? ":read-only" : ":workspace";
    if (active?.id !== CODEX_PROFILE || active.extends !== parent) {
      // Codex is off entirely when its permission profile does not take
      // effect: Look only relies on the profile as well.
      const reason = "Codex did not apply the Console's permission profile, so Codex windows are off until it does.";
      host.log(`Codex is off: ${reason}`);
      host.setFlag(CODEX_DISABLED, reason);
      throw new Error("Codex did not apply the Console's permission profile. Codex windows are off.");
    }
    if (!id || result.model !== model.model) throw new Error(`Codex did not confirm ${model.model} for this thread. No turn was started.`);
    if (this.thread) this.driver.threads.delete(this.thread.id);
    this.thread = { id, key };
    this.driver.threads.set(id, this);
    return id;
  }

  onNotification(method: string, params: Record<string, unknown>) {
    if (!this.turn) return;
    const turnId = typeof params.turnId === "string" ? params.turnId : String((params.turn as { id?: unknown } | undefined)?.id ?? "");
    // Another turn's late notification is not this one's.
    if (turnId && this.turnId && turnId !== this.turnId) return;
    // Before the reply, a turn/started about a turn other than the thread's
    // previous one names this turn (the server runs one turn per thread at
    // a time): kept, so a start whose reply never comes needs no guessing.
    if (!this.started && method === "turn/started" && turnId && turnId !== this.thread?.lastTurnId) this.seenTurnId ??= turnId;
    // An unacknowledged start learns its turn's id from the thread's
    // first notification about a turn other than its previous one.
    if (!this.started && this.unknown && turnId && turnId !== this.thread?.lastTurnId) this.start(turnId);
    try {
      for (const ev of readCodexNotification(method, params, this.driver.host.redactor)) this.onEvent(ev);
    } catch (error) {
      this.driver.host.log(`event handling failed: ${message(error)}`);
    }
  }

  private onEvent(ev: CodexEvent) {
    const emit = this.ctx.emit;
    // Until turn/start returns this turn's id, a late event of the last
    // turn cannot be told apart: kept and checked once it is known.
    if (!this.started && (ev.type === "usage" || ev.type === "completed" || ev.type === "plan")) {
      this.early.push(ev);
      return;
    }
    switch (ev.type) {
      case "started":
        return;
      case "completed": {
        if (this.turnId && ev.turnId && ev.turnId !== this.turnId) return;
        const outcome = ev.status === "completed" ? "done" : ev.status === "interrupted" ? "stopped" : "failed";
        return emit({ kind: "completed", outcome, error: outcome === "done" ? null : this.driver.host.redactor.text(ev.error ?? `Codex ended the turn (${ev.status}).`) });
      }
      case "rerouted":
        return emit({ kind: "violation", reason: `Codex moved the turn to another model (${String(ev.model).slice(0, 80)}). The turn was stopped.` });
      case "delta":
        return emit({ kind: "delta", stream: ev.kind, text: ev.text, marks: ev.kind === "text" });
      case "message":
        return emit({ kind: "message", stream: "text", text: ev.text });
      case "tool":
        this.items.set(ev.itemId, ev.paths);
        return emit({ kind: "tool", id: ev.itemId, name: ev.name, summary: ev.summary });
      case "tool_result":
        return emit({ kind: "tool_result", id: ev.itemId, text: ev.text, error: ev.error });
      case "usage":
        return this.addUsage(ev);
      case "plan":
        // Codex's whole plan (task list), already applied; only this turn's.
        if (ev.turnId && ev.turnId !== this.turnId) return;
        return emit({ kind: "task_list", op: ev.op });
      case "error":
        return emit({ kind: "error", text: ev.text });
    }
  }

  /** Count one request's usage once: only this turn's, and only when the
   * thread's cumulative total moved past the highest seen on it (a repeat
   * after a rate-limit update, or a replay on resume, does not). The
   * highest total is kept per thread while this worker runs. */
  private addUsage(ev: Extract<CodexEvent, { type: "usage" }>) {
    const thread = this.thread?.id;
    const totals = this.driver.totals;
    const highest = thread ? totals.get(thread) : undefined;
    const moved = ev.total === undefined || highest === undefined || ev.total > highest;
    if (thread && ev.total !== undefined && moved) totals.set(thread, ev.total);
    if ((ev.turnId && ev.turnId !== this.turnId) || !moved) return;
    // The context gauge, taken only as billing takes it.
    if (ev.inputTokens !== undefined) this.ctx.emit({ kind: "gauge", update: { tokens: ev.inputTokens, contextWindow: ev.contextWindow ?? null } });
    this.ctx.emit({
      kind: "usage",
      usage: { inputTokens: ev.inputTokens, cacheReadTokens: ev.cacheReadTokens, cacheWriteTokens: ev.cacheWriteTokens, outputTokens: ev.outputTokens },
    });
  }

  async onRequest(server: CodexServer, id: number | string, method: string, params: Record<string, unknown>) {
    const ctx = this.ctx;
    switch (method) {
      case "mcpServer/elicitation/request":
        // Codex asks before every MCP tool call: accepted for the Console's
        // own tools during a turn, declined otherwise.
        return server.respond(id, params.serverName === "console" && this.turn ? { action: "accept", content: {} } : { action: "decline" });
      case "item/commandExecution/requestApproval": {
        const answer = await ctx.permit("Shell", params, decideCodexCommand(params));
        // Allowed once: the Console's own rules answer later asks, so Codex
        // holds no session grant the Console cannot see or revoke.
        return server.respond(id, { decision: answer.allow ? "accept" : "decline" });
      }
      case "item/fileChange/requestApproval": {
        if (!this.turn) return server.respond(id, { decision: "decline" });
        const paths = this.items.get(String(params.itemId ?? "")) ?? [];
        const answer = await ctx.permit("Edit", { paths }, decideCodexFiles(paths, { ...ctx.agent, stepFiles: ctx.stepFiles?.() }, this.driver.host.realInside));
        return server.respond(id, { decision: answer.allow ? "accept" : "decline" });
      }
      case "item/tool/requestUserInput": {
        // Each question is its own request in Needs you, with its own answer.
        const questions = (Array.isArray(params.questions) ? params.questions : []) as {
          id?: unknown;
          header?: unknown;
          question?: unknown;
          options?: { label?: unknown }[] | null;
        }[];
        const answers = await Promise.all(
          questions.map((q) => {
            const options = Array.isArray(q.options) ? q.options.map((o) => String(o?.label ?? "")).filter(Boolean) : [];
            const summary = `${String(q.question ?? q.header ?? "A question")}${options.length ? ` (${options.join(" / ")})` : ""}`;
            return ctx.permit("Question", q, { behavior: "ask", question: true, reason: "A question for the owner.", summary });
          }),
        );
        return server.respond(id, {
          answers: Object.fromEntries(questions.map((q, i) => [String(q.id ?? ""), { answers: answers[i].answer ? [answers[i].answer!] : [] }])),
        });
      }
      case "item/permissions/requestApproval":
        // Wider permissions for a thread are never granted here.
        if (this.turn) ctx.emit({ kind: "permission", tool: "Permissions", decision: "deny", reason: "Wider permissions are not granted in Console windows." });
        return server.respond(id, { permissions: {} });
      default:
        return server.refuse(id, `${method} is not handled by the Console.`);
    }
  }
}

/** One App Server's driver: the ChatGPT login's, or one API key's. */
class CodexLoginDriver implements AgentDriver {
  readonly label = "Codex";
  readonly ownProcess = false;
  readonly permissionTool = false;
  /** Each thread's profile names every other project's folder and its own
   * project's other clones. */
  readonly folderScope = "project";

  readonly host: DriverHost;
  /** How long turn/start may take to answer (default 60 s). */
  readonly callMs: number;
  private stopGraceMs: number;
  /** The App Server (one per login), owned from its spawn: one still
   * initializing is `spawning`; one whose start failed is in `retired` until
   * it has exited, and no other starts meanwhile. */
  current: CodexServer | null = null;
  private starting: Promise<CodexServer> | null = null;
  private spawning: CodexServer | null = null;
  private retired = new Set<Ending>();
  /** The current server being ended to stop one window's turn: the other
   * windows' turns are told which window's stop did it. */
  private ending: { by: CodexSession; reason: string; end: Ending } | null = null;
  readonly threads = new Map<string, CodexSession>();
  readonly sessions = new Set<CodexSession>();
  /** Each thread's highest cumulative token total seen. */
  readonly totals = new Map<string, number>();

  /** The API key this server signs in with; null for the ChatGPT login. */
  private apiKey: string | null;

  constructor(host: DriverHost, options: { stopGraceMs: number; callMs?: number }, apiKey: string | null = null) {
    this.host = host;
    this.stopGraceMs = options.stopGraceMs;
    this.callMs = options.callMs ?? 60_000;
    this.apiKey = apiKey;
  }
  /** An interrupt gets longer here before the shared server is ended, since
   * that stops every Codex window; a Force stop ends it 2 s later. */
  get stopMs() {
    return { grace: this.stopGraceMs, force: 2_000, violation: this.stopGraceMs };
  }
  open(ctx: SessionContext): AgentSession {
    const session = new CodexSession(this, ctx);
    this.sessions.add(session);
    return session;
  }
  refusal() {
    return this.host.flag(CODEX_DISABLED);
  }
  /** A folder being made is not in a thread's profile yet; a retired server
   * must have exited before another starts, and so must one that was
   * signalled to end: no turn starts on a dying server. */
  waiting(agent: ConsoleAgent) {
    return this.host.creatingFolders(agent.projectId) || this.serverRetiring() || !!this.ending || [...this.sessions].some((s) => s.forcing && s.turn);
  }
  retiring() {
    return 0;
  }
  private serverRetiring() {
    return [...this.retired].some((e) => !e.proc.exited);
  }
  usesFolder() {
    return false;
  }

  /** The App Server, started on first use (one per login). */
  async server(): Promise<CodexServer> {
    if (this.current && !this.current.exited) {
      if (this.ending) throw new CodexError("The Codex server is being ended.");
      return this.current;
    }
    if (this.serverRetiring()) throw new CodexError("The previous Codex server has not exited yet.");
    this.starting ??= (async () => {
      const server = new CodexServer(this.host.launcher, this.host.paths.agentHome, this.host.binary("codex"), this.host.redactor, this.apiKey);
      this.spawning = server;
      server.onNotification = (method, params) => this.threads.get(String(params.threadId ?? ""))?.onNotification(method, params);
      server.onRequest = (id, method, params) => void this.request(server, id, method, params);
      server.onExit = (code) => this.onExit(server, code);
      try {
        await server.initialize();
        if (this.host.stopped()) throw new Error("The Console worker stopped.");
      } catch (error) {
        if (!server.exited) this.retired.add(new Ending(this.host, server));
        throw error;
      } finally {
        this.spawning = null;
      }
      this.current = server;
      return server;
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async request(server: CodexServer, id: number | string, method: string, params: Record<string, unknown>) {
    try {
      const session = this.threads.get(String(params.threadId ?? ""));
      if (session) return await session.onRequest(server, id, method, params);
      // No window owns it.
      if (method === "mcpServer/elicitation/request") return server.respond(id, { action: "decline" });
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") return server.respond(id, { decision: "decline" });
      if (method === "item/tool/requestUserInput") {
        const questions = (Array.isArray(params.questions) ? params.questions : []) as { id?: unknown }[];
        return server.respond(id, { answers: Object.fromEntries(questions.map((q) => [String(q.id ?? ""), { answers: [] }])) });
      }
      if (method === "item/permissions/requestApproval") return server.respond(id, { permissions: {} });
      return server.refuse(id, `${method} is not handled by the Console.`);
    } catch (error) {
      this.host.log(`Codex request ${method} failed: ${message(error)}`);
      server.refuse(id, "The Console could not answer.");
    }
  }

  /** End the shared server to stop one window's turn: every Codex window's
   * turn ends with it, the others told why. */
  end(by: CodexSession, reason: string): Promise<{ contained: boolean; collateral: string[] }> {
    const server = this.current;
    if (!server || server.exited) return Promise.resolve({ contained: true, collateral: [] });
    this.ending ??= { by, reason, end: new Ending(this.host, server) };
    const collateral = [...this.sessions].filter((s) => s !== this.ending!.by && s.turn).map((s) => s.ctx.agent.id);
    return this.ending.end.done.then(() => ({ contained: true, collateral }));
  }

  private onExit(server: CodexServer, code: number | null) {
    for (const e of this.retired) if (e.proc === server) e.step();
    if (this.current !== server) return;
    this.current = null;
    const ending = this.ending;
    this.ending = null;
    ending?.end.step();
    const sessions = [...this.sessions];
    for (const s of sessions) s.close();
    if (this.host.stopped()) return;
    for (const s of sessions) {
      if (!s.turn) continue;
      // The other windows' turns were ended by that one window's stop:
      // interrupted, so their messages reach Needs you for a Re-send.
      if (ending && ending.by !== s)
        s.ctx.emit({
          kind: "ended",
          status: "interrupted",
          reason: `Interrupted: the Codex server, which every Codex window shares, was ended to stop ${ending.by.ctx.agent.name}'s turn (${ending.reason}).`,
        });
      else s.ctx.emit({ kind: "ended", status: "failed", reason: `The Codex server ended (exit ${code}).` });
    }
  }

  tick() {
    for (const e of this.retired) if (e.step()) this.retired.delete(e);
    this.ending?.end.step();
  }
  async shutdown() {
    const procs = [this.current, this.spawning, ...[...this.retired].map((e) => e.proc)].filter((p): p is NonNullable<typeof p> => !!p);
    await endProcesses(this.host.launcher, procs, this.host.graceMs, this.host.log);
  }
}

/**
 * The Codex kind's driver: the ChatGPT login's App Server for subscription
 * models, and one App Server per OpenAI API key (by fingerprint) for the
 * API-key models, so a key never reaches the ChatGPT
 * server and the ChatGPT login never serves an API-key window. Ending one
 * server ends only the windows on it.
 */
export class CodexDriver implements AgentDriver {
  readonly label = "Codex";
  readonly ownProcess = false;
  readonly permissionTool = false;
  readonly folderScope = "project";
  private host: DriverHost;
  private options: { stopGraceMs: number; callMs?: number };
  private chatgpt: CodexLoginDriver;
  private keyed = new Map<string, CodexLoginDriver>();

  constructor(host: DriverHost, options: { stopGraceMs: number; callMs?: number }) {
    this.host = host;
    this.options = options;
    this.chatgpt = new CodexLoginDriver(host, options);
  }
  private get all() {
    return [this.chatgpt, ...this.keyed.values()];
  }
  get stopMs() {
    return this.chatgpt.stopMs;
  }
  open(ctx: SessionContext): AgentSession {
    const paid = ctx.model.paid;
    if (!paid) return this.chatgpt.open(ctx);
    const key = ctx.credentials[paid.credential];
    if (!key) throw new CodexError(`${ctx.model.label} needs ${paid.credential}.`);
    const print = fingerprint(key);
    let driver = this.keyed.get(print);
    if (!driver) this.keyed.set(print, (driver = new CodexLoginDriver(this.host, this.options, key)));
    return driver.open(ctx);
  }
  refusal() {
    return this.chatgpt.refusal();
  }
  /** Turns wait while their own login's server is in the way: the ChatGPT
   * one for a subscription model, any API-key one for an API-key model. */
  waiting(agent: ConsoleAgent) {
    const paid = !!agentModel(agent.kind, agent.model)?.paid;
    return (paid ? [...this.keyed.values()] : [this.chatgpt]).some((d) => d.waiting(agent)) || this.host.creatingFolders(agent.projectId);
  }
  retiring() {
    return 0;
  }
  usesFolder() {
    return false;
  }
  tick() {
    for (const d of this.all) d.tick();
  }
  async shutdown() {
    await Promise.all(this.all.map((d) => d.shutdown()));
  }
}
