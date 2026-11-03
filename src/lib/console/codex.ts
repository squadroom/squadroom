import type { Launcher } from "./launcher.ts";
import { Redactor } from "./redact.ts";
import { count, isObject, oneLine as shorten, RpcProcess, str, type LateReply } from "./session.ts";
export type { LateReply } from "./session.ts";
import { codexPlanOp, type TaskOp } from "./tasks.ts";

// The Codex driver: one `codex app-server` per login, run as
// `agent` through the launcher, holding one thread per agent window.
// JSON-RPC over stdio. The ChatGPT login lives in the agent account's own
// CODEX_HOME (`~agent/.codex/auth.json`), so no credential crosses the
// launcher. An OpenAI API key gets a server of its own
// that keeps its login in memory only (`cli_auth_credentials_store`
// `ephemeral`: it neither reads nor writes auth.json) and is signed in with
// the key over stdin, never in its environment or on its command line.

/** The server's arguments: an API-key server never touches auth.json. */
export function codexServerArgs(apiKey: boolean): string[] {
  return apiKey ? ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"'] : ["app-server"];
}

/** What one App Server notification means to the Console. Only executed
 * items count as evidence; Codex's reply text is display only. */
export type CodexEvent =
  | { type: "delta"; kind: "text" | "thinking"; text: string }
  | { type: "message"; itemId: string; text: string }
  /** `paths`: a file change's files (`changedFiles`); empty when it
   * cannot be read, which the approval refuses. */
  | { type: "tool"; itemId: string; name: string; summary: string; paths: string[] }
  | { type: "tool_result"; itemId: string; text: string; error: boolean }
  /** One model request's usage (`last`); the thread's `total` spans every
   * earlier turn too, so a turn sums its own requests. `inputTokens`
   * includes `cachedInputTokens` and `cacheWriteInputTokens`, as in
   * OpenAI's usage. Codex can send the same `last` again (a rate-limit
   * update) or replay old usage on resume, so `turnId` and the thread's
   * cumulative `total` come along. */
  | { type: "usage"; turnId: string; total?: number; inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens?: number; contextWindow?: number }
  | { type: "rerouted"; model: unknown }
  /** The thread's whole plan (task list). */
  | { type: "plan"; turnId: string; op: TaskOp }
  | { type: "error"; text: string }
  | { type: "completed"; turnId: string; status: string; error: string | null };

/** The kinds of file change Codex 0.155.1 reports (`PatchChangeKind`). */
const CHANGE_KINDS = new Set(["add", "delete", "update"]);

/** Every file a file change touches: each change's path and, for a rename,
 * where it moves to (`kind.move_path`). Null when a change cannot be read
 * (no path, or a kind the Console does not know), so it is never approved. */
export function changedFiles(changes: unknown): string[] | null {
  if (!Array.isArray(changes) || !changes.length) return null;
  const files: string[] = [];
  for (const change of changes) {
    if (!isObject(change)) return null;
    const kind = isObject(change.kind) ? change.kind : null;
    const path = str(change.path);
    if (!path || !kind || !CHANGE_KINDS.has(str(kind.type))) return null;
    files.push(path);
    for (const move of [kind.move_path, change.move_path]) {
      if (move === undefined || move === null) continue;
      if (typeof move !== "string" || !move) return null;
      files.push(move);
    }
  }
  return files;
}

function itemTool(item: Record<string, unknown>, redactor: Redactor): { name: string; summary: string; paths: string[] } | null {
  const short = (text: string) => shorten(redactor, text);
  switch (item.type) {
    case "commandExecution":
      return { name: "Shell", summary: short(str(item.command)), paths: [] };
    case "fileChange": {
      const files = changedFiles(item.changes);
      return { name: "Edit", summary: short((files ?? []).join(", ")), paths: files ?? [] };
    }
    case "mcpToolCall":
      return { name: `${str(item.server)}:${str(item.tool)}`, summary: short(JSON.stringify(item.arguments ?? {})), paths: [] };
    case "webSearch":
      return { name: "Web search", summary: short(str(item.query)), paths: [] };
    default:
      return null;
  }
}
function itemResult(item: Record<string, unknown>): { text: string; error: boolean } | null {
  switch (item.type) {
    case "commandExecution": {
      const code = item.exitCode;
      return {
        text: `${str(item.aggregatedOutput)}${typeof code === "number" ? `\n(exit ${code})` : ""}`,
        error: item.status === "failed" || item.status === "declined" || (typeof code === "number" && code !== 0),
      };
    }
    case "fileChange":
      return { text: `${str(item.status) || "done"}`, error: item.status === "failed" || item.status === "declined" };
    case "mcpToolCall":
      return { text: JSON.stringify(item.result ?? item.error ?? {}), error: !!item.error };
    case "webSearch":
      return { text: "", error: false };
    default:
      return null;
  }
}

/** Read one notification for a thread. Summaries and error lines are
 * redacted before they are shortened. */
export function readCodexNotification(method: string, params: Record<string, unknown>, redactor: Redactor = new Redactor()): CodexEvent[] {
  const short = (text: string) => shorten(redactor, text);
  switch (method) {
    case "item/agentMessage/delta":
      return [{ type: "delta", kind: "text", text: str(params.delta) }];
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
      return [{ type: "delta", kind: "thinking", text: str(params.delta) }];
    case "item/started": {
      const item = (params.item ?? {}) as Record<string, unknown>;
      const tool = itemTool(item, redactor);
      return tool ? [{ type: "tool", itemId: str(item.id), ...tool }] : [];
    }
    case "item/completed": {
      const item = (params.item ?? {}) as Record<string, unknown>;
      if (item.type === "agentMessage") return [{ type: "message", itemId: str(item.id), text: str(item.text) }];
      const result = itemResult(item);
      return result ? [{ type: "tool_result", itemId: str(item.id), ...result }] : [];
    }
    case "thread/tokenUsage/updated": {
      const usage = (params.tokenUsage ?? {}) as { last?: Record<string, unknown>; total?: Record<string, unknown>; modelContextWindow?: unknown };
      const last = usage.last ?? {};
      return [
        {
          type: "usage",
          turnId: str(params.turnId),
          total: count(usage.total?.totalTokens),
          inputTokens: count(last.inputTokens),
          cacheReadTokens: count(last.cachedInputTokens),
          // Optional in the 0.155.1 schema, where it defaults to 0.
          cacheWriteTokens: count(last.cacheWriteInputTokens ?? 0),
          outputTokens: count(last.outputTokens),
          // The window the App Server reports for the thread's model.
          ...(count(usage.modelContextWindow) !== undefined ? { contextWindow: count(usage.modelContextWindow) } : {}),
        },
      ];
    }
    case "turn/plan/updated": {
      const op = codexPlanOp(params.plan);
      return op ? [{ type: "plan", turnId: str(params.turnId), op }] : [];
    }
    case "model/rerouted":
      return [{ type: "rerouted", model: params.toModel ?? params.model }];
    case "error": {
      const error = (params.error ?? {}) as { message?: unknown };
      return [{ type: "error", text: short(str(error.message) || "Codex reported an error.") }];
    }
    case "turn/completed": {
      const turn = (params.turn ?? {}) as { id?: unknown; status?: unknown; error?: { message?: unknown } | null };
      return [{ type: "completed", turnId: str(turn.id), status: str(turn.status), error: turn.error ? short(str(turn.error.message)) : null }];
    }
    default:
      return [];
  }
}

/** How a call ended short of a result: `refused` is a
 * definitive error reply, `ended` the server's exit, and `unknown` a
 * timeout, after which the server may well have accepted the request and
 * be acting on it. */
export type CodexOutcome = "refused" | "ended" | "unknown";
export class CodexError extends Error {
  readonly outcome: CodexOutcome;
  constructor(message: string, outcome: CodexOutcome = "refused") {
    super(message);
    this.name = "CodexError";
    this.outcome = outcome;
  }
}

/** One App Server process and its JSON-RPC traffic. */
export class CodexServer extends RpcProcess {
  // Its notifications carry `threadId`; its requests are approvals and
  // elicitations.
  private redactor: Redactor;
  /** The API key it signs in with; none for the ChatGPT login. */
  private apiKey: string | null;
  constructor(launcher: Launcher, home: string, binary: string, redactor: Redactor = new Redactor(), apiKey: string | null = null) {
    // No credential crosses the launcher: the ChatGPT login is in the
    // agent's own CODEX_HOME, and an API key is sent in `initialize`.
    super(launcher.spawn(home, binary, codexServerArgs(!!apiKey), {}), home, "The Codex server");
    this.redactor = redactor;
    this.apiKey = apiKey;
  }
  protected gone() {
    return new CodexError("The Codex server ended.", "ended");
  }
  protected timedOut(method: string) {
    return new CodexError(`Codex did not answer ${method} in time.`, "unknown");
  }
  protected refusal(message: Record<string, unknown>) {
    if (!message.error) return null;
    return new CodexError(`Codex refused: ${shorten(this.redactor, str((message.error as { message?: unknown }).message) || "an error")}`);
  }
  /** One request. A timeout rejects with outcome `unknown`: the server may
   * have accepted it. `late` then receives the reply if it still arrives:
   * the result, or the refusal (nothing was accepted). */
  call(method: string, params: unknown, timeoutMs = 60_000, late?: LateReply): Promise<Record<string, unknown>> {
    return this.request(method, params, { timeoutMs, late });
  }

  /** Initialize and check the login, with no switch either way: a
   * ChatGPT server must report ChatGPT, never an API key; an API-key server
   * is signed in with its key and must report exactly that. */
  async initialize() {
    await this.call("initialize", { clientInfo: { name: "agent_console", version: "1" }, capabilities: { experimentalApi: true } });
    this.notify("initialized");
    if (this.apiKey) await this.call("account/login/start", { type: "apiKey", apiKey: this.apiKey });
    const account = await this.call("account/read", { refreshToken: false });
    const type = (account.account as { type?: unknown } | undefined)?.type;
    if (this.apiKey) {
      if (type !== "apiKey") throw new CodexError("Codex did not sign in with the OpenAI API key. The turn was not started.");
    } else if (type !== "chatgpt")
      throw new CodexError("Codex is not signed in with ChatGPT for the agent account. API keys are not used. Sign it in as the agent user (docs/setup.md, step 4).");
  }
}
