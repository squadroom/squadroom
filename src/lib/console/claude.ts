import type { AgentModel, ConsoleEffort } from "./agents.ts";
import type { Launcher } from "./launcher.ts";
import { Redactor } from "./redact.ts";
import { ClientProcess, count, isObject, oneLine, str } from "./session.ts";
import type { TurnUsage } from "./types.ts";

// The Claude Code driver: the official CLI kept running between turns,
// stream-json in and out, run as `agent` through the launcher. Every
// setting is a flag (`--setting-sources ""`), the MCP settings are a file
// (never inline JSON, which `ps` shows), and permission prompts go to the
// Console's MCP tool. After a restart the session continues with --resume.

export const PERMISSION_TOOL = "mcp__console__approve";

interface ClaudeLaunch {
  model: AgentModel;
  effort: ConsoleEffort | null;
  settings: unknown;
  mcpConfig: string;
  system: string;
  resume: string | null;
}

export function claudeArgs(launch: ClaudeLaunch): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    launch.model.model,
    ...(launch.effort && launch.model.efforts.includes(launch.effort) ? ["--effort", launch.effort] : []),
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify(launch.settings),
    "--mcp-config",
    launch.mcpConfig,
    "--strict-mcp-config",
    "--permission-prompt-tool",
    PERMISSION_TOOL,
    "--permission-mode",
    "default",
    "--append-system-prompt",
    launch.system,
    ...(launch.resume ? ["--resume", launch.resume] : []),
  ];
}

/** What one stream-json line means to the Console. */
export type ClaudeEvent =
  | { type: "init"; sessionId: string | null; model: unknown; apiKeySource: unknown }
  | { type: "fallback" }
  | { type: "model"; model: unknown }
  | { type: "delta"; kind: "text" | "thinking"; text: string }
  | { type: "message"; kind: "text" | "thinking"; text: string }
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; text: string; error: boolean }
  | { type: "control"; requestId: string; subtype: string; tool: string; input: unknown }
  | { type: "rate_limit"; status: string; resetsAt: number | null }
  /** A helper (subagent) called a tool (helpers row). */
  | { type: "helper_tool"; parent: string; id: string; name: string; input: unknown }
  /** A helper's tool result: only its task calls use it (task list). */
  | { type: "helper_result"; id: string; text: string; error: boolean }
  /** A top-level model request began. */
  | { type: "request_start" }
  /** One top-level model request's whole input, cache included. */
  | { type: "request_usage"; inputTokens: number }
  /** Claude Code compacted the conversation. */
  | { type: "compacted"; preTokens: number | null }
  | {
      type: "result";
      ok: boolean;
      sessionId: string | null;
      text: string;
      subtype: string;
      usage: TurnUsage;
      /** Each model's context window as the client reports it. */
      windows: { model: string; contextWindow: number; inputTokens: number }[];
      /** Each model's usage this turn, helpers included (`modelUsage`):
       * what an API-key turn is charged from. */
      models: { model: string; usage: TurnUsage; webSearches: number | undefined }[];
    };

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((c) => (isObject(c) && c.type === "text" ? str(c.text) : `[${(isObject(c) && str(c.type)) || "content"}]`)).join("\n");
  return "";
}

function toolResults(content: unknown[]): { id: string; text: string; error: boolean }[] {
  return content
    .filter(isObject)
    .filter((c) => c.type === "tool_result")
    .map((c) => ({ id: str(c.tool_use_id), text: resultText(c.content), error: c.is_error === true }));
}

/** Read one line of Claude Code's stream-json output. A subagent's own
 * messages (Task, marked by `parent_tool_use_id`) are skipped: the Task row
 * and its result stand for them, and a built-in subagent may run another
 * model of the same subscription, which is not a fallback. */
export function readClaudeEvent(line: Record<string, unknown>): ClaudeEvent[] {
  const type = line.type;
  // A helper's lines (its own context, its own compaction) never reach the
  // window's events; only the tools it calls feed the helpers row, and its
  // tool results only settle its task calls.
  if (typeof line.parent_tool_use_id === "string" && line.parent_tool_use_id && (type === "stream_event" || type === "assistant" || type === "user" || type === "system")) {
    const parent = line.parent_tool_use_id;
    const content = isObject(line.message) ? (line.message.content ?? []) : [];
    if (!Array.isArray(content)) return [];
    if (type === "user") return toolResults(content).map((r) => ({ ...r, type: "helper_result" as const }));
    if (type !== "assistant") return [];
    return content
      .filter(isObject)
      .filter((c) => c.type === "tool_use")
      .map((c) => ({ type: "helper_tool" as const, parent, id: String(c.id ?? ""), name: String(c.name ?? "tool"), input: c.input }));
  }
  if (type === "system") {
    if (line.subtype === "init")
      return [
        {
          type: "init",
          sessionId: typeof line.session_id === "string" ? line.session_id : null,
          model: line.model,
          apiKeySource: line.apiKeySource,
        },
      ];
    if (line.subtype === "model_fallback" || line.subtype === "model_consent_fallback") return [{ type: "fallback" }];
    if (line.subtype === "compact_boundary")
      return [{ type: "compacted", preTokens: count((line.compact_metadata as { pre_tokens?: unknown } | undefined)?.pre_tokens) ?? null }];
    return [];
  }
  if (type === "stream_event") {
    const part = isObject(line.event) ? line.event : {};
    // A top-level model request begins (the gauge's latest request).
    if (part.type === "message_start") {
      const model = isObject(part.message) ? part.message.model : undefined;
      return model !== undefined ? [{ type: "request_start" }, { type: "model", model }] : [{ type: "request_start" }];
    }
    if (part.type === "content_block_delta" && isObject(part.delta)) {
      const delta = part.delta;
      if (delta.type === "text_delta" && typeof delta.text === "string") return [{ type: "delta", kind: "text", text: delta.text }];
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") return [{ type: "delta", kind: "thinking", text: delta.thinking }];
    }
    return [];
  }
  if (type === "assistant") {
    const message = isObject(line.message) ? line.message : {};
    // A client-made error wrapper is not the model speaking.
    if (line.is_api_error_message === true || message.model === "<synthetic>") return [];
    const out: ClaudeEvent[] = message.model !== undefined ? [{ type: "model", model: message.model }] : [];
    // The request's own input (helpers' lines never reach here).
    const usage = isObject(message.usage) ? message.usage : {};
    const used = [usage.input_tokens, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0].map(count);
    if (used.every((v) => v !== undefined)) out.push({ type: "request_usage", inputTokens: used.reduce((a, b) => a! + b!, 0)! });
    for (const c of Array.isArray(message.content) ? message.content.filter(isObject) : []) {
      if (c.type === "text" && typeof c.text === "string") out.push({ type: "message", kind: "text", text: c.text });
      if (c.type === "thinking" && typeof c.thinking === "string") out.push({ type: "message", kind: "thinking", text: c.thinking });
      if (c.type === "tool_use") out.push({ type: "tool", id: String(c.id ?? ""), name: String(c.name ?? "tool"), input: c.input });
    }
    return out;
  }
  if (type === "user") {
    const content = isObject(line.message) ? line.message.content : undefined;
    if (!Array.isArray(content)) return [];
    return toolResults(content).map((r) => ({ ...r, type: "tool_result" as const }));
  }
  if (type === "control_request") {
    const request = (line.request ?? {}) as { subtype?: unknown; tool_name?: unknown; input?: unknown };
    return [
      {
        type: "control",
        requestId: String(line.request_id ?? ""),
        subtype: String(request.subtype ?? ""),
        tool: String(request.tool_name ?? ""),
        input: request.input,
      },
    ];
  }
  if (type === "rate_limit_event") {
    const info = line.rate_limit_info as { status?: unknown; resetsAt?: unknown } | undefined;
    return [{ type: "rate_limit", status: String(info?.status ?? "unknown"), resetsAt: count(info?.resetsAt) ?? null }];
  }
  if (type === "result") {
    const usage = (line.usage ?? {}) as Record<string, unknown>;
    const input = [usage.input_tokens, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0].map(count);
    const exact = input.every((v) => v !== undefined);
    return [
      {
        type: "result",
        ok: line.subtype === "success" && line.is_error !== true,
        sessionId: typeof line.session_id === "string" ? line.session_id : null,
        text: typeof line.result === "string" ? line.result : "",
        subtype: String(line.subtype ?? ""),
        windows: Object.entries((line.modelUsage ?? {}) as Record<string, Record<string, unknown>>).flatMap(([model, u]) => {
          const contextWindow = count(u?.contextWindow);
          const used = [u?.inputTokens, u?.cacheReadInputTokens ?? 0, u?.cacheCreationInputTokens ?? 0].map(count);
          return contextWindow ? [{ model, contextWindow, inputTokens: used.every((v) => v !== undefined) ? used.reduce((a, b) => a! + b!, 0)! : 0 }] : [];
        }),
        models: Object.entries((line.modelUsage ?? {}) as Record<string, Record<string, unknown>>).map(([model, u]) => {
          const used = [u?.inputTokens, u?.cacheReadInputTokens ?? 0, u?.cacheCreationInputTokens ?? 0].map(count);
          const whole = used.every((v) => v !== undefined);
          return {
            model,
            usage: {
              inputTokens: whole ? used.reduce((a, b) => a! + b!, 0) : undefined,
              cacheReadTokens: whole ? used[1] : undefined,
              cacheWriteTokens: whole ? used[2] : undefined,
              outputTokens: count(u?.outputTokens),
            },
            webSearches: count(u?.webSearchRequests ?? 0),
          };
        }),
        usage: {
          inputTokens: exact ? input.reduce((a, b) => a! + b!, 0) : undefined,
          cacheReadTokens: exact ? input[1] : undefined,
          cacheWriteTokens: exact ? input[2] : undefined,
          outputTokens: count(usage.output_tokens),
          turns: count(line.num_turns),
          durationMs: count(line.duration_ms),
        },
      },
    ];
  }
  return [];
}

/** A one-line summary of a tool call for its transcript row: redacted
 * before it is shortened, so a credential is never cut in two. */
export function toolSummary(name: string, input: unknown, redactor: Redactor = new Redactor()): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = i.command ?? i.file_path ?? i.notebook_path ?? i.pattern ?? i.path ?? i.url ?? i.query ?? i.description;
  const text = typeof pick === "string" ? pick : input === undefined ? "" : JSON.stringify(input);
  return oneLine(redactor, text);
}

/** A live Claude Code process for one agent. */
export class ClaudeProcess extends ClientProcess {
  onEvent: (events: ClaudeEvent[]) => void = () => {};

  constructor(launcher: Launcher, folder: string, binary: string, args: string[], credentials: Record<string, string>) {
    super(launcher.spawn(folder, binary, args, credentials), folder, "Claude Code");
  }
  /** Stream-json, not JSON-RPC. */
  protected received(line: Record<string, unknown>) {
    this.onEvent(readClaudeEvent(line));
  }
  /** Resolves once the prompt was written to the client's input; rejects
   * if the process has ended or the write failed. */
  prompt(text: string): Promise<void> {
    return this.write({ type: "user", message: { role: "user", content: text } });
  }
  /** Ask Claude Code to stop the current turn; the process stays alive. */
  interrupt(id: string) {
    this.send({ type: "control_request", request_id: id, request: { subtype: "interrupt" } });
  }
  /** Answer a `can_use_tool` control request. */
  answer(requestId: string, behavior: "allow" | "deny", message: string, input?: unknown) {
    this.send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: behavior === "allow" ? { behavior, updatedInput: input ?? {} } : { behavior, message },
      },
    });
  }
  /** Refuse a control request the Console does not handle. */
  refuse(requestId: string, error: string) {
    this.send({ type: "control_response", response: { subtype: "error", request_id: requestId, error } });
  }
}
