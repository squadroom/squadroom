import { randomUUID } from "node:crypto";
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentKind, reportsExpectedModel, type AgentModel } from "./agents.ts";
import { claudeArgs, ClaudeProcess, PERMISSION_TOOL, toolSummary, type ClaudeEvent } from "./claude.ts";
import { claudeSettings, decideControl } from "./permissions.ts";
import { errorMessage, guarded, OwnProcessDriver, type AgentDriver, type AgentSession, type PromptResult, type SessionContext, type SessionTotals, type TurnRequest } from "./session.ts";
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

/** One model's figures in a result's `modelUsage`. */
type ModelPart = { model: string; usage: TurnUsage; webSearches: number | undefined };

/**
 * This turn's share of Claude Code's per-model usage. `modelUsage` is a
 * running total for the session: each result carries every earlier turn
 * too, and a resumed session's first result already carries the turns
 * before the restart. So a turn is the latest totals less the last result's
 * (`before`): this worker's, or after a restart the totals the store kept
 * with the session's last charged turn. Null when that cannot be read:
 * there is no earlier result to subtract (no charged turn kept its totals),
 * a figure is missing, or a total went down (a zeroed or reset report). A
 * model that did not move this turn is left out.
 */
export function turnModelUsage(now: ModelPart[], before: ModelPart[] | null): ModelPart[] | null {
  if (!before) return null;
  if (before.some((b) => !now.some((p) => p.model === b.model))) return null;
  const fields = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"] as const;
  const out: ModelPart[] = [];
  for (const part of now) {
    const prev = before.find((b) => b.model === part.model);
    const usage: TurnUsage = {};
    for (const f of fields) {
      const a = part.usage[f];
      const b = prev ? prev.usage[f] : 0;
      if (a === undefined || b === undefined || a < b) return null;
      usage[f] = a - b;
    }
    const searches = part.webSearches === undefined || (prev && prev.webSearches === undefined) ? undefined : part.webSearches - (prev?.webSearches ?? 0);
    if (searches === undefined || searches < 0) return null;
    if (searches || fields.some((f) => usage[f])) out.push({ model: part.model, usage, webSearches: searches });
  }
  return out;
}

/**
 * What an API-key turn is charged from: every model's usage this turn
 * (`turnModelUsage`, so helpers and Claude Code's own small requests count),
 * summed and priced at the window's model. A model priced above it, one
 * the Console does not know, or a web search (which has its own price)
 * makes the usage untrusted: the turn is then charged its full allowance.
 */
export function apiKeyUsage(model: AgentModel, parts: ModelPart[]): TurnUsage | null {
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

/** An API-key turn's usage from a result: this turn's share of the running
 * totals (null: charged its full allowance). A turn no model moved in used
 * nothing. */
export function apiKeyTurnUsage(model: AgentModel, now: ModelPart[], before: ModelPart[] | null): TurnUsage | null {
  const parts = turnModelUsage(now, before);
  if (!parts) return null;
  if (!parts.length) return now.length ? { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } : null;
  return apiKeyUsage(model, parts);
}

/** Totals the store kept (`storedTotals`), or null when they do not read
 * as a list of models with numeric figures. */
function readTotals(value: unknown): ModelPart[] | null {
  if (!Array.isArray(value)) return null;
  const num = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v));
  const ok = value.every(
    (p: unknown) =>
      !!p &&
      typeof p === "object" &&
      typeof (p as ModelPart).model === "string" &&
      !!(p as ModelPart).usage &&
      typeof (p as ModelPart).usage === "object" &&
      Object.values((p as ModelPart).usage).every(num) &&
      num((p as ModelPart).webSearches),
  );
  return ok ? (value as ModelPart[]) : null;
}

class ClaudeSession implements AgentSession {
  private proc: ClaudeProcess;
  private ctx: SessionContext;
  private driver: ClaudeDriver;
  private askFirst: boolean;
  /** The folders its settings deny reading. */
  private others: string[];
  // This turn's state.
  private active = false;
  private initSeen = false;
  private discard = false;
  private topModel: string | undefined;
  private taskCalls = new Set<string>();
  /** The last result's running totals in this process (`modelUsage`);
   * null until one is seen for a resumed session whose totals neither this
   * worker nor the store knows. */
  private totals: ModelPart[] | null;
  /** The latest result's totals when they moved, for the store to keep
   * with this turn's charge. */
  private moved: SessionTotals | undefined;

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
    const resume = ctx.storedSession();
    this.totals = resume ? (driver.totals.get(resume) ?? readTotals(ctx.storedTotals(resume))) : [];
    this.others = host.deniedFolders(agent);
    const args = claudeArgs({
      model,
      effort: agent.effort,
      settings: claudeSettings(agent.folder, agent.permission, host.paths, !!agent.askFirst, !!ctx.documentsOnly, !!model.paid, this.others),
      mcpConfig: config,
      system: ctx.system(),
      resume,
    });
    this.askFirst = !!agent.askFirst;
    this.proc = new ClaudeProcess(host.launcher, agent.folder, host.binary(agent.kind), args, ctx.credentials);
    driver.track(this.proc, ctx);
    this.proc.onEvent = (events) => guarded(host.log, () => {
      for (const ev of events) this.onEvent(ev);
    });
    this.proc.onOversize = () => this.active && ctx.emit({ kind: "oversize" });
  }
  get exited() {
    return this.proc.exited;
  }
  /** Settings are fixed at spawn, so a new teammate's clone or a new
   * project's folder restarts the process (resuming its session). */
  stale(agent: ConsoleAgent) {
    return this.askFirst !== !!agent.askFirst || JSON.stringify(this.driver.host.deniedFolders(agent)) !== JSON.stringify(this.others);
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
      // A failure while deciding (the policy reading the input, or the
      // store) is a deny, never an unhandled error in the worker.
      void Promise.resolve()
        .then(() => ctx.permit(ev.tool, ev.input, decideControl(ev.tool, ev.input)))
        .then(
          (answer) => this.proc.answer(ev.requestId, answer.allow ? "allow" : "deny", answer.reason, ev.input),
          (error: unknown) => {
            this.driver.host.log(`Claude permission request failed: ${errorMessage(error)}`);
            this.proc.answer(ev.requestId, "deny", "The Console could not answer.", ev.input);
          },
        );
      return;
    }
    // Every result moves the running totals, a discarded turn's too.
    const charged = ev.type === "result" ? this.turnUsage(ev) : undefined;
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
          usage: charged,
          // Only an API-key turn is charged from the totals.
          totals: ctx.model.paid ? this.moved : undefined,
        });
      }
    }
  }
  /** A result's usage: an API-key turn's from every model's usage this
   * turn (its share of the running totals, which are kept for the next
   * result, for a resume of this session by this worker, and with the
   * turn's charge for a resume after a restart). */
  private turnUsage(ev: Extract<ClaudeEvent, { type: "result" }>): TurnUsage | null {
    const before = this.totals;
    this.moved = undefined;
    // A zeroed report (a crash or startup-error result may carry one, or a
    // result without `modelUsage`) is not a new starting point: the totals
    // it came after still are.
    const zeroed = ev.models.every((p) => !p.webSearches && !p.usage.inputTokens && !p.usage.outputTokens && !p.usage.cacheReadTokens && !p.usage.cacheWriteTokens);
    if (!zeroed) {
      this.totals = ev.models;
      if (ev.sessionId) {
        this.driver.totals.set(ev.sessionId, ev.models);
        this.moved = { sessionId: ev.sessionId, value: ev.models };
      }
    }
    return this.ctx.model.paid ? apiKeyTurnUsage(this.ctx.model, ev.models, before) : ev.usage;
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
  /** Each Claude session's last running totals (`modelUsage`), so a new
   * process resuming it charges only what comes after. */
  readonly totals = new Map<string, ModelPart[]>();
  open(ctx: SessionContext): AgentSession {
    return new ClaudeSession(this, ctx);
  }
}
