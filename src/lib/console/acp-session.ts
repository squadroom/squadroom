import { join } from "node:path";
import { agentKind } from "./agents.ts";
import { ACP_PROTOCOL, AcpError, AcpProcess, AUTH_REQUIRED, readAcpUpdate, readAcpUsage, readSessionModel, readXaiUsage } from "./acp.ts";
import type { SandboxSpec } from "./launcher.ts";
import { inside, realInside, type Decision } from "./permissions.ts";
import { TEAM_TOOL_NAMES } from "./team.ts";
import { acpToolLabel } from "./transcript.ts";
import { errorMessage as message, oneLine, OwnProcessDriver, type AgentDriver, type AgentSession, type DriverHost, type PromptResult, type SessionContext, type TurnRequest } from "./session.ts";
import type { ConsoleAgent, ConsoleProject } from "./types.ts";

// ACP agents behind the session seam: one agent program per window, in the
// launcher's sandbox profile (reads allowed except the listed folders,
// writes only in its clone and temporary folder, network off unless the
// project's switch is on). The
// first kind is OpenCode (`opencode acp`); every ACP kind goes through the
// same conformance matrix (tests/console-acp.test.ts).
//
// The Console checks what it can before any paid request: protocol v1, team
// tools over HTTP, no interactive login (an agent that asks to authenticate
// is refused, never logged in: only the selected key crosses), and the
// model, which the session must report as current. The turn's usage comes
// from session/prompt's answer only, once per turn; a turn without it is
// charged its full allowance.

/** What a session's sandbox is made of, so a change is noticed (teammates'
 * clones added, the network switch, the access level). */
function profileKey(spec: SandboxSpec) {
  return JSON.stringify({ level: spec.level, network: spec.network, deny: [...spec.deny].sort(), login: spec.login ?? null });
}

/**
 * How an ACP agent's permission request is decided: reads and thinking are
 * allowed; edits only in its own folder, and never at Look only; commands
 * run in the sandbox (Look only: the owner decides); network fetches, and
 * anything else, go to the owner. Ask me first sends every one that is not
 * refused to the owner.
 */
export function decideAcp(toolCall: Record<string, unknown>, agent: Pick<ConsoleAgent, "folder" | "permission" | "askFirst">, check = realInside): Decision {
  const kind = typeof toolCall.kind === "string" ? toolCall.kind : "other";
  const title = typeof toolCall.title === "string" ? toolCall.title : kind;
  const summary = `${title}${toolCall.rawInput === undefined ? "" : `: ${JSON.stringify(toolCall.rawInput)}`}`;
  // No "Always" rule: an ACP request names only its kind (execute, fetch…),
  // so a rule would approve every later command or fetch, not the one the
  // owner saw. Each is decided on its own.
  const ask = (reason: string): Decision => ({ behavior: "ask", reason, summary });
  const paths = (Array.isArray(toolCall.locations) ? toolCall.locations : [])
    .map((l) => (l && typeof l === "object" ? (l as { path?: unknown }).path : undefined))
    .filter((p): p is string => typeof p === "string");
  // The Console's own team tools (its `console` MCP server), which some
  // clients ask about like any tool (Grok Build does): allowed as Claude
  // Code's and Codex's calls to them are; the worker checks and limits each
  // call itself. Only a known team tool name.
  const raw = toolCall.rawInput && typeof toolCall.rawInput === "object" ? (toolCall.rawInput as Record<string, unknown>) : {};
  for (const name of [title, raw.tool_name]) {
    const own = typeof name === "string" ? /^(?:mcp__)?console__(team_[a-z_]+)$/.exec(name) : null;
    if (own && TEAM_TOOL_NAMES.has(own[1])) return { behavior: "allow", reason: "The Console's own team tool." };
  }
  let decision: Decision;
  switch (kind) {
    case "read":
    case "search":
    case "think":
      decision = { behavior: "allow", reason: "Reading inside the sandbox." };
      break;
    case "edit":
    case "delete":
    case "move":
      if (agent.permission === "look") return { behavior: "deny", reason: "This window is Look only: it cannot change files." };
      if (!paths.length) return { behavior: "deny", reason: "The Console could not tell which files this changes." };
      if (paths.some((p) => !inside(agent.folder, p) || !check(agent.folder, p))) return { behavior: "deny", reason: "Writes outside this agent's own folder are not allowed." };
      decision = { behavior: "allow", reason: "Files in this agent's own folder." };
      break;
    case "execute":
      decision = agent.permission === "look" ? ask("A command needs the owner's approval in a Look only window.") : { behavior: "allow", reason: "Commands run in the sandbox." };
      break;
    case "fetch":
      return ask("Network access needs the owner's approval.");
    default:
      return ask(`${title} needs the owner's approval.`);
  }
  return agent.askFirst && decision.behavior === "allow" ? ask("Ask me first: the owner decides.") : decision;
}

class AcpSession implements AgentSession {
  private driver: AcpDriver;
  private ctx: SessionContext;
  private proc: AcpProcess;
  private spec: SandboxSpec;
  private sessionId: string | null = null;
  private setup: Promise<string> | null = null;
  private loading = false;
  /** The next prompt opens a new conversation: it carries the window's
   * instructions first. */
  private instruct = false;
  /** A new conversation whose instructions have not reached the agent
   * yet: its id is not kept for resume until they have. */
  private unsaved: string | null = null;
  // This turn's state.
  private turn: TurnRequest | null = null;
  /** This turn's session/prompt was sent: anything the agent then says
   * about the session proves it has the prompt. */
  private sent = false;
  /** session/prompt has answered: the turn is over for its updates. */
  private answered = false;
  private text = "";
  /** Permission requests waiting on the Console: answered `cancelled` at
   * cancellation, as the protocol asks. */
  private asking = new Map<number | string, boolean>();

  constructor(driver: AcpDriver, ctx: SessionContext) {
    this.driver = driver;
    this.ctx = ctx;
    const host = driver.host;
    this.spec = driver.sandbox(ctx.agent);
    this.proc = new AcpProcess(host.launcher, ctx.agent.folder, host.binary(ctx.agent.kind), agentKind(ctx.agent.kind)?.acpArgs ?? ["acp"], ctx.credentials, this.spec, host.redactor);
    const kind = agentKind(ctx.agent.kind);
    driver.track(this.proc, ctx, kind?.needsNetwork && !this.spec.network ? `${kind.label} needs Network on for this project (the project's menu, Network…).` : undefined);
    this.proc.onNotification = (method, params) => {
      try {
        this.onNotification(method, params);
      } catch (error) {
        host.log(`event handling failed: ${message(error)}`);
      }
    };
    // A request the Console cannot handle (its input breaks the policy's
    // reading, say) is refused, never an unhandled error in the worker.
    this.proc.onRequest = (id, method, params) =>
      void this.onRequest(id, method, params).catch((error: unknown) => {
        host.log(`ACP request ${method.slice(0, 60)} failed: ${message(error)}`);
        this.asking.delete(id);
        this.proc.refuse(id, "The Console could not answer.", -32603);
      });
    this.proc.onOversize = () => {
      if (this.turn) ctx.emit({ kind: "oversize" });
      // One line this long is not the protocol: the program is ended.
      this.close();
    };
  }
  get exited() {
    return this.proc.exited || this.failed;
  }
  /** Its setup failed: unusable at once, even while its program is still
   * being ended, so the next turn starts a new one. */
  private failed = false;
  stale(agent: ConsoleAgent) {
    return profileKey(this.driver.sandbox(agent)) !== profileKey(this.spec) || agent.permission !== this.ctx.agent.permission;
  }

  /** initialize, then session/load (the saved session) or session/new,
   * then the model confirmed: once per process. */
  private open(): Promise<string> {
    this.setup ??= (async () => {
      const { agent, model } = this.ctx;
      const host = this.driver.host;
      const init = await this.proc.call(
        "initialize",
        { protocolVersion: ACP_PROTOCOL, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "agent-console", version: "1" } },
        this.driver.callMs,
      );
      if (init.protocolVersion !== ACP_PROTOCOL) throw new AcpError(`${this.driver.label} speaks ACP version ${String(init.protocolVersion).slice(0, 20)}, not ${ACP_PROTOCOL}.`);
      const caps = (init.agentCapabilities ?? {}) as { loadSession?: unknown; mcpCapabilities?: { http?: unknown } };
      if (caps.mcpCapabilities?.http !== true) throw new AcpError(`${this.driver.label} cannot reach the Console's team tools (no MCP over HTTP).`);
      // A client that needs to be told to use the key in its environment
      // (Grok Build's `xai.api_key`) is told so, and only with that method:
      // never a sign-in.
      const keyAuth = agentKind(agent.kind)?.acpKeyAuth;
      const methods = Array.isArray(init.authMethods) ? (init.authMethods as { id?: unknown }[]) : [];
      if (keyAuth && methods.some((m) => m?.id === keyAuth))
        await this.proc.call("authenticate", { methodId: keyAuth }, this.driver.callMs).catch((error: unknown) => {
          throw new AcpError(`${this.driver.label} did not accept the key it was given (${message(error).slice(0, 200)}). No turn was started.`);
        });
      const mcpServers = [{ type: "http", name: "console", url: host.mcpUrl(), headers: [{ name: "Authorization", value: `Bearer ${this.ctx.newToken()}` }] }];
      const saved = this.ctx.storedSession();
      let result: Record<string, unknown> | null = null;
      let id: string | null = null;
      if (saved && caps.loadSession === true) {
        // The agent replays the session's history as updates first: not
        // this turn's, so they are not shown again.
        this.loading = true;
        result = await this.proc.call("session/load", { sessionId: saved, cwd: agent.folder, mcpServers }, this.driver.callMs).catch((error: unknown) => {
          host.log(`session ${saved} could not be resumed (${message(error)}); starting a new one`);
          return null;
        });
        this.loading = false;
        if (result) id = saved;
      }
      if (!result) {
        try {
          result = await this.proc.call("session/new", { cwd: agent.folder, mcpServers }, this.driver.callMs);
          // A new conversation opens with the window's instructions (its
          // folder, role and the team's workflow), as Claude's system prompt
          // and Codex's developer instructions carry them; a loaded one has
          // them already.
          this.instruct = true;
        } catch (error) {
          if (error instanceof AcpError && error.code === AUTH_REQUIRED)
            throw new AcpError(`${this.driver.label} asked to sign in. The Console passes only the key its model needs and never signs a client in; no turn was started.`);
          throw error;
        }
        id = typeof result.sessionId === "string" ? result.sessionId : null;
      }
      if (!id) throw new AcpError(`${this.driver.label} did not give a session id.`);
      // The model: the session must report it as current, or take it.
      const reported = readSessionModel(result);
      if (reported?.current !== model.runs) {
        if (!reported || !reported.available.includes(model.runs))
          throw new AcpError(`${this.driver.label} did not offer ${model.runs}. No turn was started.`);
        const set = await (reported.configId
          ? this.proc.call("session/set_config_option", { sessionId: id, configId: reported.configId, value: model.runs }, this.driver.callMs)
          : this.proc.call("session/set_model", { sessionId: id, modelId: model.runs }, this.driver.callMs)
        ).catch(() => null);
        if (!set) throw new AcpError(`${this.driver.label} did not switch to ${model.runs}. No turn was started.`);
        // A config option's answer lists the options again: it must now
        // say the model is the one asked for.
        if (reported.configId && readSessionModel(set)?.current !== model.runs)
          throw new AcpError(`${this.driver.label} did not switch to ${model.runs}. No turn was started.`);
      }
      this.sessionId = id;
      return id;
    })();
    return this.setup;
  }

  async prompt(turn: TurnRequest): Promise<PromptResult> {
    this.turn = turn;
    this.sent = false;
    this.answered = false;
    this.text = "";
    let id: string;
    try {
      id = await this.open();
    } catch (error) {
      // A setup that failed leaves this process unusable: the next turn
      // starts a new one.
      this.failed = true;
      this.close();
      return { outcome: "refused", reason: message(error) };
    }
    // A new conversation is kept for resume only once its first prompt,
    // which carries the window's instructions, has reached the agent: a
    // conversation that never got them is never loaded again.
    this.unsaved = this.instruct ? id : null;
    this.ctx.emit({ kind: "validated", sessionId: this.unsaved ? null : id });
    if (this.turn !== turn || !turn.wanted()) return { outcome: "refused", reason: "The turn ended before it started." };
    let written!: (outcome: "written" | "gone" | "unknown") => void;
    const reached = new Promise<"written" | "gone" | "unknown">((resolve) => (written = resolve));
    const prompt = [...(this.instruct ? [{ type: "text", text: `Your instructions for this conversation:\n\n${this.ctx.system()}\n\n---\n\n` }] : []), { type: "text", text: turn.text }];
    this.sent = true;
    turn.sending();
    // The answer ends the turn at once: updates read after it are dropped.
    const answer = this.proc.call("session/prompt", { sessionId: id, prompt }, 0, written, () => {
      if (this.turn === turn) this.answered = true;
    });
    answer.then(
      (result) => this.end(turn, result),
      (error: unknown) => this.fail(turn, error),
    );
    const outcome = await reached;
    if (outcome === "gone") return { outcome: "refused", reason: `${this.driver.label} is not running.` };
    if (outcome === "unknown") return { outcome: "unknown" };
    this.deliver();
    return { outcome: "started" };
  }
  /** The agent has this turn's prompt: its one-shot records are spent, and
   * a new conversation's instructions have arrived (it is kept now). */
  private deliver() {
    if (!this.turn) return;
    if (this.unsaved) {
      const id = this.unsaved;
      this.unsaved = null;
      this.instruct = false;
      this.ctx.emit({ kind: "session", sessionId: id });
    }
    this.turn.delivered();
  }
  /** session/prompt answered: the turn's end, its stop reason and usage. */
  private end(turn: TurnRequest, result: Record<string, unknown>) {
    if (this.turn !== turn) return;
    // An answer means the agent read the prompt, whatever the write's
    // callback has said so far.
    this.deliver();
    this.flushText();
    const reason = String(result.stopReason ?? "");
    // Where the client reports its usage: ACP's `usage`, or Grok Build's
    // own `_meta.usage`.
    const usage = agentKind(this.ctx.agent.kind)?.acpUsage === "xai-meta" ? readXaiUsage(result._meta) : readAcpUsage(result.usage);
    const emit = this.ctx.emit;
    if (reason === "end_turn") return emit({ kind: "completed", outcome: "done", error: null, usage });
    if (reason === "cancelled") return emit({ kind: "completed", outcome: "stopped", error: `${this.driver.label} stopped the turn.`, usage });
    emit({ kind: "completed", outcome: "failed", error: `${this.driver.label} ended the turn (${reason.slice(0, 40) || "no reason given"}).`, usage });
  }
  private fail(turn: TurnRequest, error: unknown) {
    if (this.turn !== turn || this.proc.exited) return;
    this.deliver();
    this.flushText();
    this.ctx.emit({ kind: "completed", outcome: "failed", error: message(error), usage: null });
  }
  /** The agent's text since its last tool call, as one whole message (the
   * turn's final answer is the last one). */
  private flushText() {
    if (this.text.trim()) this.ctx.emit({ kind: "message", stream: "text", text: this.text });
    this.text = "";
  }

  interrupt() {
    for (const [id, open] of this.asking) if (open) this.proc.respond(id, { outcome: { outcome: "cancelled" } });
    this.asking.clear();
    if (this.sessionId) this.proc.notify("session/cancel", { sessionId: this.sessionId });
  }
  terminate(_reason: string, options: { immediate?: boolean } = {}) {
    return this.driver.terminate(this.proc, options.immediate);
  }
  endTurn() {
    // Requests still waiting on the Console are answered, as the protocol
    // asks, so the agent never waits for ever.
    for (const [id, open] of this.asking) if (open) this.proc.respond(id, { outcome: { outcome: "cancelled" } });
    this.asking.clear();
    this.turn = null;
    this.sent = false;
    this.text = "";
  }
  close() {
    this.driver.retire(this.proc);
  }

  private onNotification(method: string, params: Record<string, unknown>) {
    if (method !== "session/update" || this.loading || !this.turn || this.answered || params.sessionId !== this.sessionId) return;
    // An update about this turn proves the agent has its prompt, whatever
    // the write's callback has said so far.
    if (this.sent) this.deliver();
    const emit = this.ctx.emit;
    const redactor = this.driver.host.redactor;
    for (const u of readAcpUpdate(params.update)) {
      switch (u.type) {
        case "text":
          this.text += u.text;
          emit({ kind: "delta", stream: "text", text: u.text });
          break;
        case "thinking":
          emit({ kind: "delta", stream: "thinking", text: u.text });
          break;
        case "tool":
          this.flushText();
          emit({ kind: "tool", id: u.id, ...acpToolLabel(u.kind, oneLine(redactor, u.title)) });
          break;
        case "tool_result":
          emit({ kind: "tool_result", id: u.id, text: u.text, error: u.error });
          break;
        case "plan":
          emit({ kind: "task_list", op: u.op });
          break;
        case "context":
          emit({ kind: "gauge", update: { tokens: u.used, contextWindow: u.size } });
          break;
      }
    }
  }

  private async onRequest(id: number | string, method: string, params: Record<string, unknown>) {
    if (method !== "session/request_permission") return this.proc.refuse(id, `${method} is not offered by the Console.`);
    const toolCall = (params.toolCall && typeof params.toolCall === "object" ? params.toolCall : {}) as Record<string, unknown>;
    const options = (Array.isArray(params.options) ? params.options : []) as { optionId?: unknown; kind?: unknown }[];
    if (params.sessionId !== this.sessionId || !this.turn || this.answered) return this.proc.respond(id, { outcome: { outcome: "cancelled" } });
    if (this.sent) this.deliver();
    this.asking.set(id, true);
    const answer = await this.ctx.permit(
      typeof toolCall.kind === "string" ? toolCall.kind : "other",
      toolCall.rawInput ?? toolCall.title ?? {},
      decideAcp(toolCall, this.ctx.agent, this.driver.host.realInside),
    );
    // Cancelled meanwhile: already answered.
    if (!this.asking.delete(id)) return;
    // Allow once at most: the Console keeps "Always" rules itself, so the
    // agent never holds a standing grant.
    const pick = options.find((o) => o.kind === (answer.allow ? "allow_once" : "reject_once"));
    this.proc.respond(id, pick ? { outcome: { outcome: "selected", optionId: pick.optionId } } : { outcome: { outcome: "cancelled" } });
  }
}

export class AcpDriver extends OwnProcessDriver<AcpHost> implements AgentDriver {
  readonly label: string;
  readonly permissionTool = false;
  /** Its sandbox names its project's other clones. */
  readonly folderScope = "project";
  readonly sandboxed = true;
  readonly callMs: number;
  constructor(label: string, host: AcpHost, options: { callMs?: number } = {}) {
    super(host);
    this.label = label;
    this.callMs = options.callMs ?? 60_000;
  }
  /** Its sandbox now: its level, its project's network switch, the
   * Console's loopback port and its teammates' clones in the project. */
  sandbox(agent: ConsoleAgent): SandboxSpec {
    const project = this.host.project(agent.projectId);
    const parent = join(this.host.paths.agentHome, "work", agent.projectId);
    const deny = this.host
      .folders()
      .filter((f) => f !== agent.folder && f.startsWith(`${parent}/`) && !f.slice(parent.length + 1).includes("/"));
    // Kimi Code alone may read its membership login.
    const login = agent.kind === "kimi-code" ? { login: "kimi" as const } : {};
    return { level: agent.permission === "look" ? "look" : "edit", network: !!project?.acpNetwork, port: Number(new URL(this.host.mcpUrl()).port), deny, ...login };
  }
  open(ctx: SessionContext): AgentSession {
    return new AcpSession(this, ctx);
  }
  /** A folder being made in its project is not in its sandbox yet, and a
   * network change waits for the project's sessions to restart. */
  waiting(agent: ConsoleAgent) {
    return this.host.creatingFolders(agent.projectId) || this.host.networkChanging(agent.projectId);
  }
}

/** What an ACP driver needs beyond the common host. */
export interface AcpHost extends DriverHost {
  project(projectId: string): ConsoleProject | undefined;
  networkChanging(projectId: string): boolean;
}
