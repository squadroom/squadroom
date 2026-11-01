import { randomUUID } from "node:crypto";
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentKind, reportsExpectedModel, type AgentModel } from "./agents.ts";
import { claudeArgs, ClaudeProcess, PERMISSION_TOOL, toolSummary, type ClaudeEvent } from "./claude.ts";
import { claudeSettings, decideControl } from "./permissions.ts";
import { errorMessage, OwnProcessDriver, type AgentDriver, type AgentSession, type PromptResult, type SessionContext, type TurnRequest } from "./session.ts";
import { claudeTaskOp, unfollowable } from "./tasks.ts";
import type { ConsoleAgent, TurnUsage } from "./types.ts";

// The Claude Code driver behind the session seam: one long-lived `claude`
// process per window, stream-json in and out. Its settings are fixed at
// start (an Ask me first switch restarts it, resuming the session);
// permission prompts arrive through the Console's `approve` tool and its
// sandbox's control requests.

/** Where an agent's MCP settings live: a 0640 owner:agent file in the shared
 * folder, which the sandbox hides from every agent. */
export function mcpConfigPath(shared: string, agentId: string) {
  return join(shared, `${agentId}.json`);
}

/** The credential Claude Code must report for a turn (`apiKeySource`): its
 * API key's name for an API-key model, "none" (the login token) otherwise.
 * Either way, no silent switch to the other. */
export function expectedKeySource(model: AgentModel): string {
  return model.paid ? model.paid.credential : "none";
}

/**
 * What an API-key turn is charged from: every model's usage this turn
 * (`modelUsage`, so helpers and Claude Code's own small requests count),
 * summed and priced at the window's model. A model priced above it, one
 * the Console does not know, or a web search (which has its own price)
 * makes the usage untrusted: the turn is then charged its full allowance.
 */
export function apiKeyUsage(model: AgentModel, parts: { model: string; usage: TurnUsage; webSearches: number | undefined }[]): TurnUsage | null {
  const paid = model.paid;
  if (!paid || !parts.length) return null;
  const known = agentKind("claude-code")?.models.filter((m) => m.paid) ?? [];
  const rate = (p: NonNullable<AgentModel["paid"]>["prices"]) => [p.inputPerMtok, p.outputPerMtok, p.cachedInputPerMtok ?? p.inputPerMtok, p.cacheWritePerMtok ?? p.inputPerMtok];
  const own = rate(paid.prices);
  const sum: Required<Pick<TurnUsage, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "outputTokens">> = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  for (const part of parts) {
    if (part.webSearches !== 0) return null;
    const other = known.find((m) => reportsExpectedModel(m, part.model));
    if (!other || rate(other.paid!.prices).some((r, i) => r > own[i])) return null;
    const u = part.usage;
    if (u.inputTokens === undefined || u.outputTokens === undefined) return null;
    sum.inputTokens += u.inputTokens;
    sum.cacheReadTokens += u.cacheReadTokens ?? 0;
    sum.cacheWriteTokens += u.cacheWriteTokens ?? 0;
    sum.outputTokens += u.outputTokens;
  }
  return sum;
}

class ClaudeSession implements AgentSession {
  private proc: ClaudeProcess;
  private ctx: SessionContext;
  private driver: ClaudeDriver;
  private askFirst: boolean;
  // This turn's state.
  private active = false;
  private initSeen = false;
  private discard = false;
  private topModel: string | undefined;
  private taskCalls = new Set<string>();

  constructor(driver: ClaudeDriver, ctx: SessionContext) {
    this.driver = driver;
    this.ctx = ctx;
    const host = driver.host;
    const { agent, model } = ctx;
    const token = ctx.newToken();
    const config = mcpConfigPath(host.paths.shared, agent.id);
    const temp = `${config}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ mcpServers: { console: { type: "http", url: host.mcpUrl(), headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o640 });
    chmodSync(temp, 0o640);
    renameSync(temp, config);
    const args = claudeArgs({
      model,
      effort: agent.effort,
      settings: claudeSettings(agent.folder, agent.permission, host.paths, !!agent.askFirst, !!ctx.documentsOnly, !!model.paid),
      mcpConfig: config,
      system: ctx.system(),
      resume: ctx.storedSession(),
    });
    this.askFirst = !!agent.askFirst;
    this.proc = new ClaudeProcess(host.launcher, agent.folder, host.binary(agent.kind), args, ctx.credentials);
    driver.track(this.proc, ctx);
    this.proc.onEvent = (events) => {
      try {
        for (const ev of events) this.onEvent(ev);
      } catch (error) {
        host.log(`event handling failed: ${errorMessage(error)}`);
      }
    };
    this.proc.onOversize = () => this.active && ctx.emit({ kind: "oversize" });
  }
  get exited() {
    return this.proc.exited;
  }
  stale(agent: ConsoleAgent) {
    return this.askFirst !== !!agent.askFirst;
  }
  async prompt(turn: TurnRequest): Promise<PromptResult> {
    this.active = true;
    this.initSeen = false;
    this.discard = false;
    this.topModel = undefined;
    this.taskCalls = new Set();
    try {
      turn.sending();
      await this.proc.prompt(turn.text);
    } catch (error) {
      return { outcome: "refused", reason: errorMessage(error) };
    }
    turn.delivered();
    return { outcome: "started" };
  }
  interrupt() {
    this.proc.interrupt(randomUUID());
  }
  terminate(_reason: string, options: { immediate?: boolean } = {}) {
    return this.driver.terminate(this.proc, options.immediate);
  }
  endTurn() {
    this.active = false;
  }
  close() {
    this.driver.retire(this.proc);
  }

  private onEvent(ev: ClaudeEvent) {
    const ctx = this.ctx;
    const emit = ctx.emit;
    if (ev.type === "control") {
      // Answered even between turns, so the client never waits on us.
      if (ev.subtype !== "can_use_tool") return this.proc.refuse(ev.requestId, "Not handled by the Console.");
      void ctx.permit(ev.tool, ev.input, decideControl(ev.tool, ev.input)).then((answer) =>
        this.proc.answer(ev.requestId, answer.allow ? "allow" : "deny", answer.reason, ev.input),
      );
      return;
    }
    // A turn that broke a rule keeps nothing more; its process is ended.
    if (!this.active || this.discard) return;
    const fail = (reason: string) => {
      this.discard = true;
      emit({ kind: "violation", reason });
    };
    if (ev.type === "init") {
      this.initSeen = true;
      // No silent switch: a subscription window never runs on API
      // credentials, an API-key window runs only on its own key, and each
      // runs only the model the registry expects.
      const source = expectedKeySource(ctx.model);
      if (ev.apiKeySource !== source)
        return fail(
          source === "none"
            ? "Claude Code selected API credentials. The turn was stopped; no API fallback is allowed."
            : `Claude Code did not run on ${source}. The turn was stopped.`,
        );
      if (!reportsExpectedModel(ctx.model, ev.model)) return fail(`Claude Code reported ${String(ev.model).slice(0, 80)}, not ${ctx.model.runs}. The turn was stopped.`);
      // Kept only once both checks pass, so a rejected session is never resumed.
      return emit({ kind: "validated", sessionId: ev.sessionId });
    }
    if (ev.type === "rate_limit") {
      // The shared login is out of usage: its queue pauses, with
      // the reason on the page, until the reported reset.
      if (ev.status === "allowed" || ev.status === "allowed_warning") return;
      const now = this.driver.host.now();
      const reset = ev.resetsAt && ev.resetsAt * 1000 > now && ev.resetsAt * 1000 < now + 7 * 86_400_000 ? ev.resetsAt * 1000 : now + 15 * 60_000;
      return emit({
        kind: "rate_limit",
        until: reset,
        text: `The Claude account reached its usage limit. Queued turns wait until ${new Date(reset).toISOString().slice(11, 16)} UTC.`,
      });
    }
    if (!this.initSeen && ev.type !== "result") return fail("Claude Code did not confirm its login and model before working. The turn was stopped.");
    const redactor = this.driver.host.redactor;
    switch (ev.type) {
      case "fallback":
        return fail("Claude Code switched to another model. The turn was stopped.");
      case "request_start":
        return emit({ kind: "request_start" });
      case "request_usage":
        // The context gauge: the latest top-level request; the
        // window stays only while the request is on the window's model.
        return emit({ kind: "gauge", update: { tokens: ev.inputTokens, model: this.topModel ?? null } });
      case "compacted":
        return emit({ kind: "gauge", update: { compactedFrom: ev.preTokens } });
      case "model":
        if (typeof ev.model === "string" && ev.model !== "<synthetic>") this.topModel = ev.model;
        if (ev.model !== "<synthetic>" && !reportsExpectedModel(ctx.model, ev.model))
          return fail(`Claude Code answered with ${String(ev.model).slice(0, 80)}, not ${ctx.model.runs}. The turn was stopped.`);
        return;
      case "delta":
        return emit({ kind: "delta", stream: ev.kind, text: ev.text });
      case "message":
        return emit({ kind: "message", stream: ev.kind, text: ev.text });
      case "tool":
        if (ev.name !== PERMISSION_TOOL) emit({ kind: "tool", id: ev.id, name: ev.name, summary: toolSummary(ev.name, ev.input, redactor) });
        this.taskCall(ev.id, ev.name, ev.input);
        // A helper (subagent) begins.
        if (ev.name === "Agent" || ev.name === "Task") {
          const input = (ev.input && typeof ev.input === "object" ? ev.input : {}) as { description?: unknown; subagent_type?: unknown };
          emit({ kind: "helper_start", toolUseId: ev.id, name: String(input.description ?? "Helper"), type: String(input.subagent_type ?? "helper") });
        }
        return;
      case "helper_tool":
        // A helper's TaskCreate and TaskUpdate act on the session's shared
        // list; its TodoWrite is its private checklist.
        if (ev.name !== "TodoWrite") this.taskCall(ev.id, ev.name, ev.input);
        return emit({ kind: "helper_tool", parent: ev.parent, summary: `${ev.name} ${toolSummary(ev.name, ev.input, redactor)}`.trim().replace(/\s+/g, " ") });
      case "helper_result":
        return this.taskResult(ev.id, ev.error, ev.text);
      case "tool_result": {
        this.taskResult(ev.id, ev.error, ev.text);
        // A helper's own result ends its row; it names its subagent id,
        // which locates its transcript.
        emit({ kind: "helper_end", toolUseId: ev.id, subagentId: /agentId: (a[0-9a-f]{8,40})\b/.exec(ev.text)?.[1] ?? null });
        return emit({ kind: "tool_result", id: ev.id, text: ev.text, error: ev.error });
      }
      case "result": {
        if (ev.sessionId) emit({ kind: "session", sessionId: ev.sessionId });
        // The window the client reports for the model in use: only
        // the exact model of the top-level requests (a helper on another
        // variant reports its own window).
        const window = this.topModel ? ev.windows.find((w) => w.model === this.topModel) : undefined;
        emit({ kind: "gauge", update: { contextWindow: window?.contextWindow ?? null, model: this.topModel ?? null }, measuredOnly: true });
        return emit({
          kind: "completed",
          outcome: ev.ok ? "done" : "failed",
          error: ev.ok ? null : `Claude Code reported ${ev.subtype}${ev.text ? `: ${ev.text}` : ""}`,
          text: ev.ok ? ev.text : undefined,
          // An API-key turn is charged from every model's usage this turn.
          usage: ctx.model.paid ? apiKeyUsage(ctx.model, ev.models) : ev.usage,
        });
      }
    }
  }
  /** A Claude task call (task list), pending until its result. */
  private taskCall(id: string, name: string, input: unknown) {
    const op = claudeTaskOp(name, input);
    if (!op) return;
    // Not followed, but never silently: the list may be out of date.
    if (unfollowable(id, op)) return this.ctx.emit({ kind: "task_unfollowed" });
    this.taskCalls.add(id);
    this.ctx.emit({ kind: "task_call", id, op });
  }
  private taskResult(id: string, error: boolean, text: string) {
    if (!this.taskCalls.delete(id)) return;
    this.ctx.emit({ kind: "task_result", id, ok: !error, text });
  }
}

export class ClaudeDriver extends OwnProcessDriver implements AgentDriver {
  readonly label = "Claude Code";
  readonly permissionTool = true;
  readonly folderScope = null;
  open(ctx: SessionContext): AgentSession {
    return new ClaudeSession(this, ctx);
  }
}
