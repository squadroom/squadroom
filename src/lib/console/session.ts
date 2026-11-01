import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentKind, AgentModel } from "./agents.ts";
import type { Launcher } from "./launcher.ts";
import type { ConsolePaths, Decision } from "./permissions.ts";
import type { Redactor } from "./redact.ts";
import type { TaskOp } from "./tasks.ts";
import type { ConsoleAgent, TurnUsage } from "./types.ts";

// The driver seam: every agent kind sits behind one `AgentSession`, and the
// worker drives turns, limits, permissions, the mailbox and the store
// without knowing which client runs. A driver owns its processes: how a
// client is started, prompted, interrupted and ended, and whether one
// process serves one window (Claude Code, ACP agents) or every window of a
// login (Codex's App Server) is the driver's business. The worker never
// signals a process itself: it asks for outcomes.
//
// The contract each driver is tested against (tests/console-lifecycle,
// tests/console-session, tests/console-acp):
// - An unknown start: a prompt whose acceptance cannot be known is
//   `unknown`; the worker then contains the turn (stopping, the window
//   occupied, nothing snapshot or started) until the driver confirms it
//   ended or `terminate` resolves.
// - Ownership: a process is owned from its spawn; one whose start failed is
//   ended through the same escalation as any other, and counted until it
//   exits.
// - Shared processes: ending a shared process names the other windows it
//   ended; their turns end `interrupted`, with the reason, so their messages
//   reach Needs you for a Re-send.
// - Parallel requests: while any of a turn's requests waits for the owner
//   the whole turn is waiting (no slot, no clock), even if another branch of
//   the same turn was answered and works on. Recorded as the current
//   behaviour, not necessarily the final design.

/** How a prompt went. `unknown`: the driver cannot say whether the agent
 * accepted it (an acknowledgement that timed out), so the worker must
 * contain the turn before the window is used again. */
export type PromptResult = { outcome: "started" } | { outcome: "refused"; reason: string } | { outcome: "unknown" };

/** One turn's prompt, as the worker hands it to a session. */
export interface TurnRequest {
  /** The Console's turn id. */
  id: number;
  /** What the agent receives. */
  text: string;
  /** False once the worker no longer wants it started (stopped meanwhile). */
  wanted(): boolean;
  /** Called immediately before the paid request is handed to the client:
   * the turn is recorded as prompted first (durably), so a worker that dies
   * at any point after cannot leave a paid request uncharged. A refusal
   * (nothing reached the client) clears it again. */
  sending(): void;
  /** The agent has the prompt: the one-shot records it carried (uploads
   * announced, a summary, commits shown) are spent. Called once, when the
   * client has accepted it, which for an unacknowledged start may be later
   * or never. */
  delivered(): void;
}

/** The context gauge's figures. */
export interface GaugeUpdate {
  tokens?: number;
  contextWindow?: number | null;
  model?: string | null;
  compactedFrom?: number | null;
}

/** What a session tells the worker about its running turn. Events about a
 * turn that has ended are dropped by the worker. */
export type SessionEvent =
  /** The login and the model are confirmed for this turn (no silent paid
   * fallback); its session id is kept for resume. */
  | { kind: "validated"; sessionId: string | null }
  /** The client's session id, kept only for a validated turn. */
  | { kind: "session"; sessionId: string }
  /** A rule broke (another model, API credentials, an unconfirmed start):
   * the turn fails and nothing more of it is kept. */
  | { kind: "violation"; reason: string }
  /** The login is out of usage until then: its queue pauses. */
  | { kind: "rate_limit"; until: number; text: string }
  /** Streamed text. `marks`: whole messages of this kind are not written
   * again (false for Codex's thinking, whose messages never repeat it). */
  | { kind: "delta"; stream: "text" | "thinking"; text: string; marks?: boolean }
  | { kind: "message"; stream: "text" | "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; summary: string }
  | { kind: "tool_result"; id: string; text: string; error: boolean }
  /** Usage reported for one model request, added to the turn's. */
  | { kind: "usage"; usage: TurnUsage }
  /** A top-level model request began and has not reported its usage. */
  | { kind: "request_start" }
  /** `measuredOnly`: written only if a request of this turn reported usage. */
  | { kind: "gauge"; update: GaugeUpdate; measuredOnly?: boolean }
  | { kind: "task_call"; id: string; op: TaskOp }
  | { kind: "task_result"; id: string; ok: boolean; text: string }
  | { kind: "task_list"; op: TaskOp }
  | { kind: "task_unfollowed" }
  | { kind: "helper_start"; toolUseId: string; name: string; type: string }
  | { kind: "helper_tool"; parent: string; summary: string }
  | { kind: "helper_end"; toolUseId: string; subagentId: string | null }
  | { kind: "error"; text: string }
  /** A decision the client asked for and the Console refused outright
   * (shown in the window, not stored as a request). */
  | { kind: "permission"; tool: string; decision: "deny"; reason: string }
  /** One line of output was too long: the turn stops ("output limit"). */
  | { kind: "oversize" }
  /** The client ended the turn. `text`: its final answer when no whole
   * message carried one. `usage`: the turn's whole usage, when the client
   * reports it at the end. */
  | { kind: "completed"; outcome: "done" | "stopped" | "failed"; error: string | null; text?: string; usage?: TurnUsage | null }
  /** The client refused the turn after all (a late refusal): nothing ran. */
  | { kind: "refused"; reason: string }
  /** The session ended under a running turn (its process exited, or a
   * shared process was ended for another window). */
  | { kind: "ended"; status: "failed" | "interrupted"; reason: string };

/** What the worker gives one session. */
export interface SessionContext {
  agent: ConsoleAgent;
  model: AgentModel;
  /** The credentials this session's process gets (by name). */
  credentials: Record<string, string>;
  emit(event: SessionEvent): void;
  /** Decide one permission request or question (Needs you, rules, policy). */
  permit(tool: string, input: unknown, policy: Decision): Promise<{ allow: boolean; always: boolean; answer: string | null; reason: string }>;
  /** A new MCP bearer token for this session (the old one is revoked). */
  newToken(): string;
  /** The agent's saved client session, to resume. */
  storedSession(): string | null;
  /** The agent's instructions (its window, folder and role). */
  system(): string;
  /** Its tab has steps: document turns, no commands. */
  documentsOnly?: boolean;
}

/** One agent window's client session. */
export interface AgentSession {
  /** Its process (or its thread on a shared one) is gone: the next turn
   * opens a new session. */
  readonly exited: boolean;
  /** Started with settings that no longer match the agent (Ask me first
   * switched, its sandbox's folder list changed): retired when idle. */
  stale(agent: ConsoleAgent): boolean;
  /** Start a turn: the paid request. */
  prompt(turn: TurnRequest): Promise<PromptResult>;
  /** The polite stop; `force` says the owner's Force stop (a shared
   * process then starts no other turn until it is ended). */
  interrupt(options?: { force?: boolean }): void;
  /** Force stop with escalation: the driver ends what runs this window (a
   * private process TERM then KILL, `immediate` KILL at once; a shared one
   * ended for every window on it). Resolves once execution is contained,
   * naming the other windows' agents it also ended. */
  terminate(reason: string, options?: { immediate?: boolean }): Promise<{ contained: boolean; collateral: string[] }>;
  /** The worker ended the turn (any way): per-turn state is settled; an
   * unacknowledged start's usage is reported first. */
  endTurn(): void;
  /** Take it out of service when idle (eviction, close, Start fresh). */
  close(): void;
}

/** What a driver needs from the worker beyond one session. */
export interface DriverHost {
  launcher: Launcher;
  paths: ConsolePaths;
  redactor: Redactor;
  now: () => number;
  log: (line: string) => void;
  /** The client binary for a kind (tests point it at a fake). */
  binary(kind: AgentKind): string;
  /** The loopback MCP server the team tools run on. */
  mcpUrl(): string;
  /** Interrupt, then TERM after this, then KILL after twice this. */
  graceMs: number;
  stopped(): boolean;
  flag(key: string): string | null;
  setFlag(key: string, value: string | null): void;
  realInside: (folder: string, path: string) => boolean;
  /** Every agent folder on the Mac (closed agents' folders stay on disk). */
  folders(): string[];
  /** A folder is being made now (anywhere, or one a sandbox of this
   * project would not know: in this project, or a new project's first). */
  creatingFolders(projectId?: string): boolean;
  /** What a Codex thread of this agent denies: every other project's
   * folder, and its own project's other clones by name (the agent's own
   * project folder is never denied: that breaks Node). */
  codexDenied(agent: ConsoleAgent): string[];
}

/** One kind of client. */
export interface AgentDriver {
  /** How the worker names it ("Claude Code", "Codex"). */
  readonly label: string;
  /** Each window has a process of its own (counted against the live
   * process limit; idle ones are evicted first). */
  readonly ownProcess: boolean;
  /** Claude Code calls the Console's `approve` tool for permissions. */
  readonly permissionTool: boolean;
  /** How long an interrupt gets before `terminate`: after a stop, after
   * the owner's Force stop, and after a rule broke. */
  readonly stopMs: { grace: number; force: number; violation: number };
  open(ctx: SessionContext): AgentSession;
  /** A reason every turn of this kind fails now (the kind is off). */
  refusal(agent: ConsoleAgent): string | null;
  /** Turns of this kind wait now (a process ending, folders being made). */
  waiting(agent: ConsoleAgent): boolean;
  /** Whose new folders a running turn of this kind must not see appear:
   * its sandbox lists the folders that existed when it started. "project":
   * its own project's, and a new project's first folder (Codex names each
   * project folder; ACP its teammates); null: none (Claude's sandbox
   * blocks reads outside its folder). A folder is made only while no such
   * turn runs, and the sessions take the new list before their next turn. */
  readonly folderScope: "project" | null;
  /** Its sessions are programs started with a fixed sandbox (ACP): an
   * idle one is ended before a new clone appears or the project's network
   * switch changes. A Codex thread instead takes the new list on resume. */
  readonly sandboxed?: boolean;
  /** Processes taken out of service that have not exited (counted against
   * the live process limit). */
  retiring(): number;
  /** A process of this driver (live or exiting) still runs in this folder. */
  usesFolder(folder: string): boolean;
  /** Each tick: escalation of processes being ended. */
  tick(): void;
  /** Worker stop: every process ended (TERM, then KILL). */
  shutdown(): Promise<void>;
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Protocol readers' guards: a string, a whole non-negative count, a plain
 * object. */
export const str = (v: unknown) => (typeof v === "string" ? v : "");
export const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** One line of at most 200 characters, redacted before it is shortened so a
 * credential is never cut in two. */
export const oneLine = (redactor: Redactor, text: string) => redactor.shorten(text.replace(/\s+/g, " ").trim(), 200);

/** One stdout line longer than this is not the protocol: the client's
 * `onOversize` (the turn stops on "output limit", a server is ended). */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * A client program run as `agent` through the launcher, one JSON message per
 * line on its stdio (Claude Code's stream-json, Codex's App Server, ACP). It
 * is owned from its spawn; stderr can carry anything the client prints, so
 * it is drained, never stored.
 */
export abstract class ClientProcess {
  readonly child: ChildProcessWithoutNullStreams;
  /** The folder it runs in (the cleanup never touches it while it lives). */
  readonly folder: string;
  exited = false;
  onOversize: () => void = () => {};
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
  private label: string;
  private decoder = new StringDecoder("utf8");
  private pending = "";

  /** `label` names it in a refused write ("Claude Code is not running."). */
  constructor(child: ChildProcessWithoutNullStreams, folder: string, label: string) {
    this.child = child;
    this.folder = folder;
    this.label = label;
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => this.exit(null, null));
    child.on("close", (code, signal) => this.exit(code, signal));
  }
  get pid(): number {
    return this.child.pid ?? 0;
  }
  /** Settle what waits on the process (its calls), before `onExit`. */
  protected ended(): void {}
  private exit(code: number | null, signal: NodeJS.Signals | null) {
    if (this.exited) return;
    this.exited = true;
    this.ended();
    this.onExit(code, signal);
  }
  private read(chunk: Buffer) {
    this.pending += this.decoder.write(chunk);
    let at;
    while ((at = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, at);
      this.pending = this.pending.slice(at + 1);
      // A whole line this long is not the protocol either: never parsed.
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        this.pending = "";
        return this.onOversize();
      }
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Not a protocol line.
      }
      if (isObject(message)) this.received(message);
    }
    if (Buffer.byteLength(this.pending) > MAX_LINE_BYTES) {
      this.pending = "";
      this.onOversize();
    }
  }
  /** One message from the program. */
  protected abstract received(message: Record<string, unknown>): void;
  /** Write one line; resolves once it was handed to the client's input,
   * rejects if the program has ended or its input is closed. */
  protected write(value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.exited || !this.child.stdin.writable) return reject(new Error(`${this.label} is not running.`));
      this.child.stdin.write(`${JSON.stringify(value)}\n`, (error) => (error ? reject(new Error(`${this.label} did not take the message.`)) : resolve()));
    });
  }
  /** Write one line, if the program still runs. */
  protected send(value: unknown) {
    void this.write(value).catch(() => {});
  }
}

/** A JSON-RPC client (Codex's App Server, ACP): the program's requests and
 * notifications go to their handlers, replies to its own calls to `reply`.
 * `envelope` is what every message carries (ACP: `jsonrpc: "2.0"`). */
export abstract class RpcProcess extends ClientProcess {
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {};
  onRequest: (id: number | string, method: string, params: Record<string, unknown>) => void = () => {};
  protected envelope: Record<string, unknown> = {};
  protected abstract reply(message: Record<string, unknown>): void;
  protected received(message: Record<string, unknown>) {
    const id = message.id;
    const method = typeof message.method === "string" ? message.method : null;
    const params = isObject(message.params) ? message.params : {};
    if (method && id !== undefined && id !== null) return this.onRequest(id as number | string, method, params);
    if (method) return this.onNotification(method, params);
    this.reply(message);
  }
  notify(method: string, params?: unknown) {
    this.send(params === undefined ? { ...this.envelope, method } : { ...this.envelope, method, params });
  }
  respond(id: number | string, result: unknown) {
    this.send({ ...this.envelope, id, result });
  }
  refuse(id: number | string, message: string, code = -32601) {
    this.send({ ...this.envelope, id, error: { code, message } });
  }
}

/**
 * The common part of a driver whose windows each have a process of their
 * own (Claude Code, ACP agents): the live processes and the ones being
 * ended, which count against the live process limit until they have exited.
 */
export abstract class OwnProcessDriver<H extends DriverHost = DriverHost> {
  readonly ownProcess = true;
  readonly host: H;
  readonly live = new Set<ClientProcess>();
  readonly endings = new Set<Ending>();
  /** Each process ended by `terminate`, once. */
  private terminated = new WeakMap<ClientProcess, Ending>();
  abstract readonly label: string;
  constructor(host: H) {
    this.host = host;
  }
  get stopMs() {
    return { grace: this.host.graceMs, force: 0, violation: 0 };
  }
  refusal(): string | null {
    return null;
  }
  waiting(agent: ConsoleAgent): boolean {
    void agent;
    return false;
  }
  /** Own a new session's process: it leaves the live set when it exits,
   * which ends the session under any running turn. */
  track(proc: ClientProcess, ctx: SessionContext) {
    this.live.add(proc);
    proc.onExit = (code, signal) => {
      this.live.delete(proc);
      ctx.emit({ kind: "ended", status: "failed", reason: `${this.label} ended unexpectedly (${signal ?? `exit ${code}`}).` });
    };
  }
  /** Take a process out of service: it stays tracked until it has exited,
   * with TERM, then KILL resent each grace period, and shutdown ends it. */
  retire(proc: ClientProcess) {
    if (proc.exited || [...this.endings].some((e) => e.proc === proc)) return;
    this.endings.add(new Ending(this.host, proc));
  }
  /** A session's `terminate`: its process ended (`immediate`: KILL at once). */
  terminate(proc: ClientProcess, immediate?: boolean): Promise<{ contained: boolean; collateral: string[] }> {
    let ending = this.terminated.get(proc);
    if (!ending && !proc.exited) {
      ending = new Ending(this.host, proc, immediate);
      this.terminated.set(proc, ending);
      this.endings.add(ending);
    }
    return (ending?.done ?? Promise.resolve()).then(() => ({ contained: true, collateral: [] }));
  }
  retiring() {
    return [...this.endings].filter((e) => !e.proc.exited).length;
  }
  usesFolder(folder: string) {
    return [...this.live].some((p) => !p.exited && p.folder === folder);
  }
  tick() {
    for (const e of this.endings) if (e.step()) this.endings.delete(e);
  }
  async shutdown() {
    await endProcesses(this.host.launcher, [...this.live, ...[...this.endings].map((e) => e.proc)], this.host.graceMs, this.host.log);
  }
}

/** End processes the way the worker's stop does: TERM, then KILL twice,
 * a grace period apart, with failed signals sent again. */
export async function endProcesses(launcher: Launcher, procs: { pid: number; exited: boolean }[], grace: number, log: (line: string) => void) {
  for (const [signal, wait] of [["TERM", grace], ["KILL", grace], ["KILL", grace]] as const) {
    const alive = procs.filter((p) => !p.exited);
    if (!alive.length) return;
    for (const p of alive) await launcher.signal(signal, p.pid);
    const end = Date.now() + wait;
    while (Date.now() < end && procs.some((p) => !p.exited)) await new Promise((r) => setTimeout(r, 50));
  }
  const left = procs.filter((p) => !p.exited).map((p) => p.pid);
  if (left.length) log(`agent processes still running after stop: ${left.join(", ")}`);
}

/**
 * A process being ended (a retired one, or one under `terminate`): TERM,
 * then KILL a grace period later and again each grace period until it has
 * exited. A signal the launcher could not send is sent again after 2 s.
 */
export class Ending {
  private next: number;
  private retry: "TERM" | "KILL" | null = null;
  private resolve: (() => void) | null = null;
  readonly done: Promise<void>;
  readonly proc: { pid: number; exited: boolean };
  private host: Pick<DriverHost, "launcher" | "now" | "graceMs" | "log">;
  constructor(host: Pick<DriverHost, "launcher" | "now" | "graceMs" | "log">, proc: { pid: number; exited: boolean }, immediate = false) {
    this.host = host;
    this.proc = proc;
    this.done = new Promise((r) => (this.resolve = r));
    this.next = host.now() + host.graceMs;
    this.send(immediate ? "KILL" : "TERM");
  }
  private send(signal: "TERM" | "KILL") {
    void this.host.launcher.signal(signal, this.proc.pid).then((ok) => {
      if (ok || this.proc.exited) return;
      this.host.log(`could not send ${signal} to agent process ${this.proc.pid}; retrying`);
      this.next = Math.min(this.next, this.host.now() + 2_000);
      this.retry = signal;
    });
  }
  /** Call each tick: true once the process has exited. */
  step(): boolean {
    if (this.proc.exited) {
      this.resolve?.();
      this.resolve = null;
      return true;
    }
    if (this.host.now() < this.next) return false;
    this.next = this.host.now() + this.host.graceMs;
    if (this.retry) {
      const signal = this.retry;
      this.retry = null;
      this.send(signal);
      return false;
    }
    this.send("KILL");
    return false;
  }
}
