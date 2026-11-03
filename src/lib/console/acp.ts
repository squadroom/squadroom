import type { Launcher, SandboxSpec } from "./launcher.ts";
import { Redactor } from "./redact.ts";
import { count, isObject, RpcProcess, str } from "./session.ts";
import { codexPlanOp, type TaskOp } from "./tasks.ts";
import type { TurnUsage } from "./types.ts";

// The Agent Client Protocol, v1: JSON-RPC 2.0 over the agent program's
// stdio, one message per line. The Console is the client and offers no file
// system or terminal of its own (`clientCapabilities` all false), so the
// agent works only in its own clone, in the launcher's sandbox. What the
// Console uses:
//   initialize, session/new, session/load, session/set_model or
//   session/set_config_option (the model selector, readSessionModel),
//   session/prompt (its answer ends the turn: stopReason, usage),
//   session/cancel (a notification), session/update (the agent's stream),
//   session/request_permission (the agent asks; Needs you decides).

/**
 * The model a session reports, in either shape an ACP agent answers
 * session/new and session/load with: the older `models` (currentModelId,
 * availableModels; OpenCode, Gemini CLI) or the protocol's session config
 * options, where the model is the `select` option of category (or id)
 * "model" (Kimi Code 2.x). `configId` says which way it is switched: by
 * session/set_config_option with that id, or (null) by session/set_model.
 * Null when the session names no model at all.
 */
export function readSessionModel(result: Record<string, unknown>): { current: string | null; available: string[]; configId: string | null } | null {
  const models = result.models as { currentModelId?: unknown; availableModels?: { modelId?: unknown }[] } | null | undefined;
  if (models && typeof models === "object") {
    const available = Array.isArray(models.availableModels) ? models.availableModels.map((m) => m?.modelId).filter((m): m is string => typeof m === "string") : [];
    return { current: typeof models.currentModelId === "string" ? models.currentModelId : null, available, configId: null };
  }
  const options = Array.isArray(result.configOptions) ? (result.configOptions as Record<string, unknown>[]) : [];
  const option = options.find((o) => o && typeof o === "object" && (o.category === "model" || (o.category === undefined && o.id === "model")));
  if (!option || typeof option.id !== "string") return null;
  // Values may be listed flat or in groups.
  const values: string[] = [];
  for (const entry of Array.isArray(option.options) ? (option.options as Record<string, unknown>[]) : []) {
    if (typeof entry?.value === "string") values.push(entry.value);
    else if (Array.isArray(entry?.options)) for (const inner of entry.options as Record<string, unknown>[]) if (typeof inner?.value === "string") values.push(inner.value);
  }
  return { current: typeof option.currentValue === "string" ? option.currentValue : null, available: values, configId: option.id };
}

export const ACP_PROTOCOL = 1;

/** What one session/update means to the Console. */
export type AcpUpdate =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; id: string; kind: string; title: string }
  | { type: "tool_result"; id: string; text: string; error: boolean }
  | { type: "plan"; op: TaskOp }
  /** The context gauge: the session's tokens and window. */
  | { type: "context"; used: number; size: number | null };

function contentText(content: unknown): string {
  const list = Array.isArray(content) ? content : [content];
  return list
    .map((c) => {
      if (!isObject(c)) return "";
      // A tool call's content wraps a content block; a diff names its file.
      if (c.type === "content") return contentText(c.content);
      if (c.type === "text") return str(c.text);
      if (c.type === "diff") return `(changed ${str(c.path)})`;
      return c.type ? `[${str(c.type)}]` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Read one session/update. Unknown kinds are ignored. */
export function readAcpUpdate(update: unknown): AcpUpdate[] {
  if (!isObject(update)) return [];
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return [{ type: "text", text: contentText(update.content) }];
    case "agent_thought_chunk":
      return [{ type: "thinking", text: contentText(update.content) }];
    case "tool_call":
    case "tool_call_update": {
      const id = str(update.toolCallId);
      const out: AcpUpdate[] = [];
      if (update.sessionUpdate === "tool_call") out.push({ type: "tool", id, kind: str(update.kind) || "other", title: str(update.title) || str(update.kind) || "tool" });
      if (update.status === "completed" || update.status === "failed")
        out.push({
          type: "tool_result",
          id,
          text: contentText(update.content) || (update.rawOutput === undefined ? "" : JSON.stringify(update.rawOutput)),
          error: update.status === "failed",
        });
      return out;
    }
    case "plan": {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      const op = codexPlanOp(entries.map((e) => (isObject(e) ? { step: e.content, status: e.status } : e)));
      return op ? [{ type: "plan", op }] : [];
    }
    case "usage_update": {
      const used = count(update.used);
      return used === undefined ? [] : [{ type: "context", used, size: count(update.size) ?? null }];
    }
    default:
      return [];
  }
}

/**
 * A turn's usage from session/prompt's answer (`usage`), as the Console
 * counts it: input includes cache reads and writes; output includes
 * thinking. Undefined fields stay undefined, so the spend rule sees usage
 * that is missing; a reported total smaller than its parts is
 * contradictory, and is reported as missing too.
 */
export function readAcpUsage(usage: unknown): TurnUsage | null {
  if (!isObject(usage)) return null;
  // An optional counter that is present but not a whole number (null
  // included) is contradictory, never "absent".
  for (const field of ["cachedReadTokens", "cachedWriteTokens", "thoughtTokens", "totalTokens"])
    if (usage[field] !== undefined && count(usage[field]) === undefined) return {};
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  const read = count(usage.cachedReadTokens) ?? 0;
  const write = count(usage.cachedWriteTokens) ?? 0;
  const thought = count(usage.thoughtTokens) ?? 0;
  const total = count(usage.totalTokens);
  if (input === undefined || output === undefined) return {};
  // ACP's total is the sum of every token type: any other figure means the
  // parts do not add up.
  if (total !== undefined && total !== input + read + write + output + thought) return {};
  return { inputTokens: input + read + write, cacheReadTokens: read, cacheWriteTokens: write, outputTokens: output + thought };
}

/**
 * Usage where input already includes the cached tokens, thinking is billed
 * as output but is not in it, and the total is input plus output: xAI's
 * meaning and Gemini's. Usage that does not add up is contradictory ({}),
 * and none at all is null.
 */
function readInclusiveUsage(usage: unknown, fields: { read: string; write?: string; thought: string }): TurnUsage | null {
  if (!isObject(usage)) return null;
  for (const field of [fields.read, fields.write, fields.thought, "totalTokens"])
    if (field && usage[field] !== undefined && count(usage[field]) === undefined) return {};
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  const read = count(usage[fields.read]) ?? 0;
  const write = (fields.write && count(usage[fields.write])) || 0;
  const thought = count(usage[fields.thought]) ?? 0;
  const total = count(usage.totalTokens);
  if (input === undefined || output === undefined || read + write > input) return {};
  if (total !== undefined && total !== input + output) return {};
  return { inputTokens: input, cacheReadTokens: read, cacheWriteTokens: write, outputTokens: output + thought };
}

/**
 * Grok Build's usage (live check 2026-10-22, 1.0.62): not in session/prompt's
 * `usage` but in its `_meta.usage`, with xAI's own meaning. `inputTokens`
 * already includes the cached tokens (`cachedReadTokens`,
 * `cacheCreationTokens`); `reasoningTokens` are billed as output but are not
 * in `outputTokens`; `totalTokens` is input plus output. So priced at
 * catalog rates, it matched the client's own `costUsdTicks` exactly.
 */
export function readXaiUsage(meta: unknown): TurnUsage | null {
  return readInclusiveUsage(isObject(meta) ? meta.usage : undefined, { read: "cachedReadTokens", write: "cacheCreationTokens", thought: "reasoningTokens" });
}

/**
 * Gemini CLI's usage (live check 2026-11-01, 0.65.0): in session/prompt's
 * `usage` under ACP's names, but with Gemini's meaning. `inputTokens` is the
 * prompt count, cached tokens included; `thoughtTokens` are billed as output
 * but are not in `outputTokens`; `totalTokens` is input plus output. Read
 * as plain ACP usage it never adds up once the model thinks, and every turn
 * was charged its whole allowance.
 */
export function readGeminiUsage(usage: unknown): TurnUsage | null {
  return readInclusiveUsage(usage, { read: "cachedReadTokens", thought: "thoughtTokens" });
}

export class AcpError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = "AcpError";
    this.code = code;
  }
}
/** ACP's code for "authentication required" (the agent wants a login). */
export const AUTH_REQUIRED = -32000;

/** One ACP agent program and its JSON-RPC traffic. */
export class AcpProcess extends RpcProcess {
  protected envelope = { jsonrpc: "2.0" };
  private redactor: Redactor;

  constructor(launcher: Launcher, folder: string, binary: string, args: string[], credentials: Record<string, string>, sandbox: SandboxSpec, redactor: Redactor = new Redactor()) {
    super(launcher.spawn(folder, binary, args, credentials, sandbox), folder, "The agent program");
    this.redactor = redactor;
  }
  protected gone() {
    return new AcpError("The agent program ended.");
  }
  protected timedOut(method: string) {
    return new AcpError(`The agent did not answer ${method} in time.`);
  }
  protected refusal(message: Record<string, unknown>) {
    if (!isObject(message.error)) return null;
    const error = message.error;
    return new AcpError(`The agent refused: ${this.redactor.shorten(str(error.message) || "an error", 300)}`, typeof error.code === "number" ? error.code : null);
  }
  /**
   * One request. `timeoutMs` 0: no timeout (session/prompt, which answers
   * at the end of the turn). `onWritten` is told whether the request reached
   * the program's input: false when the program is gone, an error when the
   * write failed with the program still running (then whether it read the
   * request cannot be known). `answered` is told as the reply is read.
   */
  call(
    method: string,
    params: unknown,
    timeoutMs = 60_000,
    onWritten?: (outcome: "written" | "gone" | "unknown") => void,
    answered?: () => void,
  ): Promise<Record<string, unknown>> {
    return this.request(method, params, { timeoutMs, written: onWritten, answered });
  }
}
