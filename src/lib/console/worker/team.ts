import { createHash } from "node:crypto";
import { agentKind, agentModel } from "../agents.ts";
import { callSummary, claimPattern, findTeammate, holdCycle, HoldCycleError, MESSAGE_MAX, REPORT_MAX, TeamError, TEAM_DIFF_CHARS, teamDiffMissing, teamDiffText, teamPrompt } from "../team.ts";
import { agentStatus, type ConsoleAgent } from "../types.ts";
import type { ConsoleWorker } from "../worker.ts";
import type { ActiveTurn, Runtime } from "./shared.ts";

// Team tools and the mailbox; the tools on Git and GitHub are in
// team-git.ts.

/** One team-tool call: its turn, its agent and tab, its arguments, and
 * its key (the call itself, with its arguments in a fixed order). */
export type TeamCall = { rt: Runtime; t: ActiveTurn; me: ConsoleAgent; team: ConsoleAgent[]; args: Record<string, unknown>; key: string; epoch: number };

/** One delivered batch of team messages, at most (the rest follow). */
const BATCH_CHARS = 40_000;

/** A team tool's store write. A store failure other than the agent's own
 * mistake stops the worker (as every other write does); the agent hears
 * that it was not recorded. */
export function write<T>(w: ConsoleWorker, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof TeamError) throw error;
    w.fatal(error instanceof Error ? error : new Error(String(error)));
    throw new TeamError("The Console could not record this.");
  }
}
/** A message's text: required, bounded and redacted. */
export function body(w: ConsoleWorker, args: Record<string, unknown>): string {
  if (typeof args.message !== "string" || !args.message.trim()) throw new TeamError("message is required.");
  if (args.message.length > MESSAGE_MAX) throw new TeamError(`A message is at most ${MESSAGE_MAX} characters.`);
  return w.redactor.text(args.message.trim());
}

export const teamTools = {
  /** One team-tool call, during a running turn whose login and model are
   * confirmed. Every call is recorded with its turn: the same call again in
   * the same turn returns the recorded result, and a Re-send lists them. */
  async teamCall(this: ConsoleWorker, rt: Runtime, name: string, raw: unknown): Promise<string> {
    const t = rt.turn;
    if (!t || !t.validated || t.stopping) throw new TeamError(t?.stopping ? "This turn is being stopped." : "Team tools work only during a running turn.");
    const args = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const epoch = this.epoch!;
    const me = this.store.agent(rt.agent.id)!;
    const team = this.store.agents(me.projectId).filter((a) => a.tabId === me.tabId && a.state !== "closed");
    const key = createHash("sha256")
      .update(JSON.stringify([name, Object.keys(args).sort().map((k) => [k, args[k]])]))
      .digest("hex");
    const call: TeamCall = { rt, t, me, team, args, key, epoch };
    switch (name) {
      case "team_list": {
        const open = this.store.openTurns();
        return team
          .map((a) => {
            const turn = open.find((x) => x.agentId === a.id && x.status !== "queued") ?? open.find((x) => x.agentId === a.id) ?? null;
            // Its role name (and note) from "Role: Lead (frontend).",
            // else the first line of its instructions.
            const role = a.role.split("\n")[0].trim().replace(/^Role: (.*)\.$/, "$1");
            const model = agentModel(a.kind, a.model);
            const claims = this.store.claims(me.tabId).filter((c) => c.agentId === a.id);
            const hold = this.store.heldBy(a);
            // What the Orchestrator plans with: AI, model and thinking
            // level, access, role note, state, claims and holds.
            return `- ${a.name} (id ${a.id})${a.id === me.id ? " (you)" : ""}: ${agentKind(a.kind)?.label ?? a.kind} ${model?.label ?? a.model}${a.effort ? ` (thinking ${a.effort})` : ""}, ${a.permission === "look" ? "Look only" : "edits its folder"}, ${agentStatus(a, turn)}${role ? `; role: ${role.slice(0, 160)}` : ""}${
              claims.length ? `; editing ${claims.map((c) => `${c.pattern}${c.note ? ` (${c.note})` : ""}`).join(", ")}` : ""
            }${hold ? `; on hold by ${hold.holderName}: ${hold.reason}` : ""}`;
          })
          .join("\n");
      }
      case "team_send":
      case "team_ask": {
        const to = this.teammate(team, me, args.to);
        if (to.state === "error") throw new TeamError(`${to.name} could not be set up, so it cannot take messages.`);
        const text = body(this, args);
        return write(this, () =>
          this.store.sendTeamMessage(epoch, {
            turnId: t.id,
            from: me,
            to,
            kind: name === "team_ask" ? "ask" : "send",
            body: text,
            key,
            summary: this.redactor.text(callSummary(name, args, { to: to.name })),
          }),
        );
      }
      case "team_reply": {
        const id = typeof args.correlation_id === "string" ? args.correlation_id.trim() : "";
        if (!id) throw new TeamError("correlation_id is required.");
        const text = body(this, args);
        return write(this, () =>
          this.store.replyTeamMessage(epoch, { turnId: t.id, from: me, correlationId: id, body: text, key, summary: this.redactor.text(callSummary(name, args)) }),
        );
      }
      case "team_read": {
        // Only a message this agent received; any other id is unknown.
        const id = Number(args.message_id);
        const offset = args.offset === undefined ? 0 : Number(args.offset);
        if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(offset) || offset < 0) throw new TeamError("Give the message_id (and offset) the message names.");
        const text = this.store.readMessage(me.id, id, offset);
        if (text === null) throw new TeamError("No such message of yours has more to read.");
        return text;
      }
      case "team_report": {
        if (typeof args.message !== "string" || !args.message.trim()) throw new TeamError("message is required.");
        const text = this.redactor.text(args.message.trim());
        if (text.length > REPORT_MAX) throw new TeamError(`A report is at most ${REPORT_MAX} characters: keep it short, and put the details in your final message.`);
        return write(this, () => this.store.reportToOwner(epoch, { turnId: t.id, agentId: me.id, key, summary: this.redactor.text(callSummary(name, args)), text }));
      }
      case "team_claim": {
        if (me.permission !== "edit") throw new TeamError("Only an agent that edits its folder can claim paths.");
        const list = Array.isArray(args.paths) ? args.paths : [];
        if (!list.length || list.length > 20) throw new TeamError("Give 1 to 20 paths to claim.");
        // A path holding a credential is never stored (redacting it would
        // change what it claims).
        if (list.some((p) => typeof p === "string" && (this.redactor.holdsSecret(p) || this.redactor.text(p) !== p)))
          throw new TeamError("A path holds a credential; it was not claimed.");
        const patterns = claimPatterns(list);
        const note = typeof args.note === "string" ? this.redactor.text(args.note.trim()).slice(0, 200) : "";
        return write(this, () =>
          this.store.addClaims(epoch, { turnId: t.id, agent: me, patterns, note, ttlMs: this.limits.claimMs, key, summary: `team_claim ${patterns.join(", ")}` }),
        );
      }
      case "team_release": {
        // No paths (or none given) releases all; an invalid one is an error,
        // never "all".
        const patterns = claimPatterns(Array.isArray(args.paths) ? args.paths : []);
        return write(this, () =>
          this.store.callOnce(epoch, { turnId: t.id, agentId: me.id, key, tool: "team_release", summary: `team_release ${patterns.join(", ") || "all"}` }, () => {
            const n = this.store.releaseClaims(null, me.id, patterns);
            return n ? `Released ${n} claim${n === 1 ? "" : "s"}.` : "You held no such claim.";
          }),
        );
      }
      case "team_hold": {
        const held = this.teammate(team, me, args.to);
        const reason = typeof args.reason === "string" ? this.redactor.text(args.reason.trim()).slice(0, 300) : "";
        if (!reason) throw new TeamError("reason is required.");
        // Two agents holding each other wait for ever: the owner decides.
        const refuse = (cycle: string[]): never => {
          const names = cycle.map((id) => team.find((a) => a.id === id)?.name ?? id).join(" → ");
          this.pause(me.tabId, `Agents are holding each other (${names}). Resume lifts every hold in this tab.`);
          throw new TeamError(`That would make agents hold each other (${names}); the tab is paused for the owner.`);
        };
        const cycle = holdCycle(
          this.store.holds(me.tabId).map((h) => ({ holder: h.holder, held: h.held })),
          me.id,
          held.id,
        );
        if (cycle) refuse(cycle);
        try {
          return write(this, () =>
            this.store.addHold(epoch, {
              turnId: t.id,
              tabId: me.tabId,
              holder: me.id,
              held: held.id,
              reason,
              ttlMs: this.limits.holdMs,
              key,
              summary: `team_hold ${held.name}: ${reason.slice(0, 100)}`,
              result: `${held.name} is on hold: after its current turn, no team messages reach it until you call team_resume("${held.name}") (at most ${Math.round(this.limits.holdMs / 60_000)} minutes).`,
            }),
          );
        } catch (error) {
          if (error instanceof HoldCycleError) refuse(error.cycle);
          throw error;
        }
      }
      case "team_resume": {
        const held = this.teammate(team, me, args.to);
        return write(this, () =>
          this.store.callOnce(epoch, { turnId: t.id, agentId: me.id, key, tool: "team_resume", summary: `team_resume ${held.name}` }, () =>
            this.store.releaseHold(me.id, held.id) ? `${held.name} is no longer on hold.` : `You were not holding ${held.name}.`,
          ),
        );
      }
      case "team_diff": {
        // Read-only, from the diff kept after each of the teammate's turns:
        // nothing in another agent's folder is opened.
        const from = this.teammate(team, me, args.from);
        const { branch } = this.store.agentBase(from.id);
        if (from.permission !== "edit" || !branch)
          throw new TeamError(`${from.name} does not edit code on a branch of its own, so it has no changes to read.`);
        // A turn that just ended is still being committed: wait for it, so
        // the answer is the teammate's latest finished work.
        const committing = this.runtimes.get(from.id)?.busy;
        if (committing) await committing.catch(() => {});
        const running = !!this.runtimes.get(from.id)?.turn || this.store.openTurns().some((x) => x.agentId === from.id && x.status !== "queued");
        const kept = this.store.diff(from.id);
        // Files past the kept patch's bound are read from the teammate's
        // clone, between the same two commits.
        const missing = teamDiffMissing(kept, args.path);
        if (kept && missing) {
          const patch = await this.repos.diffUnder(from, kept.base, kept.head, missing, TEAM_DIFF_CHARS * 4).catch(() => null);
          if (patch) return teamDiffText({ name: from.name, branch, running }, { ...kept, patch }, args.path);
        }
        return teamDiffText({ name: from.name, branch, running }, kept, args.path);
      }
      case "team_pull":
        return this.teamPull(call);
      case "team_pull_abort":
        return this.teamPullAbort(call);
      case "team_pr":
        return this.teamPr(call);
      case "team_pr_reply":
        return this.teamPrReply(call);
      case "team_push":
        return this.teamPush(call);
    }
    throw new TeamError(`Unknown tool: ${name}`);
  },

  /** A teammate named in a tool call (by name, or by id when names repeat). */
  teammate(this: ConsoleWorker, team: ConsoleAgent[], me: ConsoleAgent, raw: unknown): ConsoleAgent {
    const others = team.filter((a) => a.id !== me.id);
    const wanted = String(raw ?? "").trim().toLowerCase();
    if (others.filter((a) => a.name.trim().toLowerCase() === wanted).length > 1)
      throw new TeamError(`Several teammates are called "${String(raw).slice(0, 60)}"; give the id that team_list shows.`);
    const found = findTeammate(others, String(raw ?? ""));
    if (!found) throw new TeamError(`No teammate called "${String(raw ?? "").slice(0, 60)}" in this tab (team_list shows who is here).`);
    return found;
  },

  /** Queued messages become one turn when their agent is free, within the
   * instruction's limits and unless paused. */
  deliverMail(this: ConsoleWorker): void {
    const epoch = this.epoch!;
    for (const agentId of this.store.agentsWithMail()) {
      const agent = this.store.agent(agentId);
      if (!agent || agent.state !== "ready" || this.store.pausedFor(agent)) continue;
      // On hold by a teammate: team messages wait.
      if (this.store.heldBy(agent)) continue;
      if (this.runtimes.get(agentId)?.turn || this.store.openTurns().some((t) => t.agentId === agentId)) continue;
      // A message waits until the turn that sent it has ended and its commit
      // is done, so a reviewer never reads the author's work half finished;
      // one batch holds one instruction's messages, so each instruction's
      // turn count stays right.
      const open = new Set(this.store.openTurns().map((t) => t.id));
      const queued = this.store
        .queuedMessages(agentId)
        .filter((m) => !(m.fromTurn !== null && open.has(m.fromTurn)) && !this.runtimes.get(m.from)?.busy);
      const batch: typeof queued = [];
      let chars = 0;
      for (const m of queued) {
        if (m.instructionId !== queued[0]?.instructionId) continue;
        if (batch.length && (chars + m.body.length > BATCH_CHARS || batch.length >= 50)) break;
        batch.push(m);
        chars += m.body.length;
      }
      if (!batch.length) continue;
      const instruction = Math.max(...batch.map((m) => m.instructionId ?? 0));
      if (instruction) {
        const use = this.store.instructionUse(instruction, agent.tabId);
        if (use.turns >= this.limits.turnsPerInstruction) {
          this.pause(agent.tabId, `Limit reached: one instruction caused ${use.turns} agent turns (the limit is ${this.limits.turnsPerInstruction}). Resume to let the team continue.`);
          continue;
        }
        if (this.instructionOverdue(agent.tabId, use.startedAt)) continue;
      }
      // Two agents going round in circles. Only settled messages count: the
      // turn that sent one may still commit.
      const circle = this.store.circle(
        agent.tabId,
        this.limits.circleMessages,
        (from, fromTurn) => open.has(fromTurn) || !!this.runtimes.get(from)?.busy,
      );
      if (circle) {
        this.pause(
          agent.tabId,
          `Going round in circles: ${circle.a} and ${circle.b} have exchanged ${circle.count} messages with no new commit and no word from you. Resume to let them continue, or tell one of them what to do.`,
        );
        continue;
      }
      this.safe(() => this.store.deliver(epoch, agentId, batch.map((m) => m.id), teamPrompt(batch)));
    }
  },
};

/** Claim patterns from a tool's paths; an invalid one is the call's error. */
function claimPatterns(list: unknown[]): string[] {
  const patterns = list.map(claimPattern);
  const bad = patterns.find((p): p is { error: string } => typeof p !== "string");
  if (bad) throw new TeamError(bad.error);
  return patterns as string[];
}
