import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { McpBackend, ToolResult } from "../../shared/mcp.ts";
import { AcpDriver } from "../acp-session.ts";
import { decide, inside, realInside, type Decision } from "../permissions.ts";
import { truncateBytes } from "../redact.ts";
import { errorMessage as message } from "../session.ts";
import { claimCovers, TEAM_TOOL_NAMES, TEAM_TOOLS, TeamError, teamToolsFor } from "../team.ts";
import { IMAGE_TOOL_NAMES, IMAGE_TOOLS, ImageError } from "../image-tools.ts";
import type { ConsoleAgent } from "../types.ts";
import type { ConsoleWorker } from "../worker.ts";
import { REPLY_MAX, type OwnerAnswer, type Runtime } from "./shared.ts";
import { currentStepFiles } from "../templates.ts";

// Permissions and the owner (Needs you), and the loopback MCP backend that
// serves the team tools and Claude Code's permission prompt tool.

/** A permission request's stored input. */
const REQUEST_INPUT_BYTES = 8 * 1024;
/** The permission prompt tool Claude Code calls (`--permission-prompt-tool`). */
const APPROVE_TOOL = {
  name: "approve",
  description: "The Console's permission check for a tool use. Called by Claude Code, not by the agent.",
  inputSchema: {
    type: "object",
    properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
    required: ["tool_name"],
  },
};

/** A name of the Console's own where Claude Code asks about a tool of its
 * own: `approve` itself (the agent calling it directly, which Claude Code
 * asks about first), a team or image tool's bare name, or another name on
 * the Console's server. A request the agent wrote itself can then never
 * pass for one of the Console's own decisions (team_push, team_pr_reply). */
export function consoleToolName(tool: string): boolean {
  const own = /^mcp__console__(.*)$/.exec(tool);
  if (own) return !TEAM_TOOL_NAMES.has(own[1]) && !IMAGE_TOOL_NAMES.has(own[1]);
  return tool === APPROVE_TOOL.name || TEAM_TOOL_NAMES.has(tool) || IMAGE_TOOL_NAMES.has(tool);
}

/** A path with every existing part's links resolved (the rest appended). */
function realPath(path: string): string {
  let probe = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(probe), ...rest.reverse());
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return resolve(path);
      rest.push(basename(probe));
      probe = parent;
    }
  }
}

export const needs = {
  /**
   * Decide one request: the policy's allow or deny, or the owner's answer
   * (an "Always for this agent" rule answers without asking). Nothing is
   * allowed outside a running turn whose login and model were confirmed, nor
   * once it is being stopped or has filled up.
   */
  async permit(this: ConsoleWorker, rt: Runtime, tool: string, input: unknown, policy: Decision): Promise<OwnerAnswer & { reason: string }> {
    const t = rt.turn;
    const deny = (reason: string) => ({ allow: false, always: false, answer: null, reason });
    if (!t || !t.validated || t.stopping) {
      const reason = t?.stopping ? "This turn is being stopped." : "This agent's login and model are not confirmed for a running turn.";
      this.record(rt, tool, input, { behavior: "deny", reason });
      return deny(reason);
    }
    if (t.events.full) return deny("This turn reached its output limit.");
    let decision = policy;
    if (decision.behavior === "ask" && decision.ruleKey && this.store.hasRule(rt.agent.id, decision.ruleKey))
      decision = { behavior: "allow", reason: "Allowed always for this agent by the owner." };
    if (decision.behavior !== "ask") {
      // An allow that could not be stored (a full turn, a store failure)
      // is not given.
      if (this.record(rt, tool, input, decision) === null && decision.behavior === "allow") return deny("This turn reached its output limit, or the decision could not be recorded.");
      return decision.behavior === "allow" ? { allow: true, always: false, answer: null, reason: decision.reason } : deny(decision.reason);
    }
    const id = this.record(rt, tool, input, decision);
    if (id === null) return deny("This turn reached its output limit.");
    const answer = await new Promise<OwnerAnswer>((resolve) =>
      this.waits.set(id, { rt, turnId: t.id, ruleKey: decision.ruleKey ?? null, resolve }),
    );
    if (answer.closed) return deny(answer.closed);
    const reason = decision.question
      ? answer.answer
        ? `The owner answered: ${answer.answer}`
        : "The owner did not answer."
      : answer.allow
        ? "Allowed by the owner."
        : "Denied by the owner.";
    if (rt.turn === t) t.events.emit("permission", { tool, decision: answer.allow ? "allow" : "deny", reason });
    // A question is answered through a denial carrying the answer (Claude
    // reads the message); Codex gets the answer itself.
    return { ...answer, allow: decision.question ? false : answer.allow, reason };
  },

  /** Store one decision (or open request). Its input counts toward the
   * turn's output bound. Returns the request's id, or null when full. */
  record(this: ConsoleWorker, rt: Runtime, tool: string, input: unknown, decision: Decision): number | null {
    const t = rt.turn;
    if (!t || this.epoch === null) return null;
    const shown = truncateBytes(this.redactor.text(JSON.stringify(input ?? {})), REQUEST_INPUT_BYTES).text;
    if (!t.events.charge(Buffer.byteLength(shown))) return null;
    const epoch = this.epoch;
    const id = this.safe(() =>
      this.store.recordRequest(epoch, {
        turnId: t.id,
        agentId: rt.agent.id,
        kind: decision.question ? "question" : "permission",
        tool,
        summary: this.redactor.text(decision.summary ?? tool).slice(0, REPLY_MAX + 200),
        input: shown,
        ruleKey: decision.ruleKey ?? null,
        state: decision.behavior === "ask" ? "open" : decision.behavior === "allow" ? "allowed" : "denied",
        reason: decision.reason,
      }),
    );
    if (id === undefined) return null;
    if (decision.behavior === "ask") {
      t.events.emit("permission", { tool, decision: "ask", reason: this.redactor.text(decision.summary ?? decision.reason) });
      if (t.waitingSince === null) {
        t.waitingSince = this.now();
        this.safe(() => this.store.setWaiting(epoch, t.id, true));
      }
    } else t.events.emit("permission", { tool, decision: decision.behavior, reason: decision.reason });
    return id;
  },

  /** Owner answers arrive through the store (the page writes them). A turn
   * that waited held no slot, so it continues only once a slot is free
   * again (total and per login); until then it keeps waiting. */
  pollWaits(this: ConsoleWorker): void {
    for (const [id, w] of this.waits) {
      const r = this.store.request(id);
      if (!r || r.state === "open") continue;
      const last = ![...this.waits].some(([other, x]) => other !== id && x.turnId === w.turnId && this.store.request(other)?.state === "open");
      if (last && !this.slotFree(w.rt)) continue;
      this.waits.delete(id);
      w.resolve({
        allow: r.state === "allowed" || r.state === "answered",
        always: !!w.ruleKey && this.store.hasRule(w.rt.agent.id, w.ruleKey),
        answer: r.answer,
      });
      this.resumeAfterWait(w.rt, w.turnId);
    }
  },
  slotFree(this: ConsoleWorker, rt: Runtime): boolean {
    const running = this.running();
    return running.length < this.limits.runningTurns && running.filter((r) => r.login === rt.login).length < this.limits.turnsPerLogin;
  },
  /** The turn waits no longer once none of its requests is open. */
  resumeAfterWait(this: ConsoleWorker, rt: Runtime, turnId: number): void {
    const t = rt.turn;
    if (!t || t.id !== turnId || t.waitingSince === null) return;
    if ([...this.waits.values()].some((w) => w.turnId === turnId)) return;
    const waited = this.now() - t.waitingSince;
    t.waitedMs += waited;
    t.waitingSince = null;
    t.lastActivity = this.now();
    this.safe(() => this.store.setWaiting(this.epoch!, turnId, false, waited));
  },
  /** Close a turn's open requests (stopped, ended): each is refused. */
  releaseWaits(this: ConsoleWorker, turnId: number, reason: string): void {
    for (const [id, w] of this.waits) {
      if (w.turnId !== turnId) continue;
      this.waits.delete(id);
      w.resolve({ allow: false, always: false, answer: null, closed: reason });
    }
    // Its image calls' jobs are cancelled too.
    this.abortImages(turnId);
    const rt = [...this.runtimes.values()].find((r) => r.turn?.id === turnId);
    if (rt) this.resumeAfterWait(rt, turnId);
    if (this.epoch !== null) this.safe(() => this.store.expireRequests(this.epoch!, turnId));
  },

  /** The loopback MCP server's backend: the team tools, and the permission
   * prompt tool (Claude). */
  backend(this: ConsoleWorker): McpBackend {
    const text = (value: unknown, isError = false): ToolResult => ({
      content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
      ...(isError ? { isError } : {}),
    });
    return {
      authorized: (token) => this.tokens.has(token),
      // Each agent is offered the team tools it may use. `approve` stays in
      // every list but an ACP agent's: Claude Code is started with it as
      // its permission prompt tool and finds it only here; ACP agents ask
      // through session/request_permission.
      tools: (token: string) => {
        const rt = this.runtimes.get(this.tokens.get(token) ?? "");
        const agent = rt ? this.store.agent(rt.agent.id) : undefined;
        const project = agent ? this.store.project(agent.projectId) : undefined;
        const team = agent ? teamToolsFor(agent, project) : TEAM_TOOLS;
        // The image tools, as the session lists them at its start.
        const image = agent && this.imageToolsOffered(agent, project) ? IMAGE_TOOLS : [];
        const acp = agent && this.drivers.get(agent.kind) instanceof AcpDriver;
        return acp ? [...team] : [...team, ...image, APPROVE_TOOL];
      },
      call: async (token, name, args) => {
        const agentId = this.tokens.get(token);
        const rt = agentId ? this.runtimes.get(agentId) : undefined;
        if (!rt) return text("This agent session has ended.", true);
        if (TEAM_TOOL_NAMES.has(name) || IMAGE_TOOL_NAMES.has(name))
          try {
            return text(await (IMAGE_TOOL_NAMES.has(name) ? this.imageCall(rt, name, args) : this.teamCall(rt, name, args)));
          } catch (error) {
            if (error instanceof TeamError || error instanceof ImageError) return text(error.message, true);
            this.log(`tool ${name} failed: ${message(error)}`);
            return text("The Console could not record this call.", true);
          } finally {
            // Whatever it stored, even before an error, counts toward the
            // turn's bound.
            if (rt.turn) rt.turn.events.atLeast(this.store.turnBytes(rt.turn.id));
          }
        if (!this.drivers.get(rt.agent.kind)?.permissionTool) return text("This agent session has ended.", true);
        if (name !== "approve") return text(`Unknown tool: ${name}`, true);
        const a = (args && typeof args === "object" ? args : {}) as { tool_name?: unknown; input?: unknown };
        const tool = typeof a.tool_name === "string" ? a.tool_name : "";
        if (consoleToolName(tool)) {
          const reason = "The Console's own tools are not decided through this tool.";
          this.record(rt, tool, a.input, { behavior: "deny", reason });
          return text({ behavior: "deny", message: reason });
        }
        // A tab with steps: writes only to the current step's files.
        const stepped = this.store.tabSteps(rt.agent.tabId);
        const agent = { ...rt.agent, stepFiles: currentStepFiles(stepped) };
        const answer = await this.permit(rt, tool, a.input, this.claimed(rt.agent, tool, a.input) ?? decide(tool, a.input, agent, this.options.realInside ?? realInside));
        return text(answer.allow ? { behavior: "allow", updatedInput: a.input ?? {} } : { behavior: "deny", message: answer.reason });
      },
    };
  },

  /** Claude's file writes inside another agent's claim are refused, naming
   * the claimant. */
  claimed(this: ConsoleWorker, agent: ConsoleAgent, tool: string, raw: unknown): Decision | null {
    if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) return null;
    const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const path = String((tool === "NotebookEdit" ? input.notebook_path : input.file_path) ?? "");
    if (!path || !agent.folder) return null;
    const full = resolve(agent.folder, path);
    if (!inside(agent.folder, full)) return null;
    // The path the write really touches: normalized (`a/../b`) and through
    // any link on the way (`alias -> src`).
    const rel = relative(realPath(agent.folder), realPath(full));
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    const claim = this.store.claims(agent.tabId).find((c) => c.agentId !== agent.id && claimCovers(c.pattern, rel));
    return claim
      ? { behavior: "deny", reason: `${claim.agentName} is editing ${claim.pattern}${claim.note ? ` (${claim.note})` : ""}. Ask them with team_send, or wait for team_release.` }
      : null;
  },
};
