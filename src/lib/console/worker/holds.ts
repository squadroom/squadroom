import { agentModel } from "../agents.ts";
import { chargeTurn, consoleSpendPauseReason, pricedAt, spendPauseReason, usd, type BilledModel, type Charge, type RunningUsage } from "../spend.ts";
import { USAGE_PAUSE, type TurnRow } from "../store.ts";
import type { ConsoleAgent, TurnUsage } from "../types.ts";
import type { ConsoleWorker } from "../worker.ts";

// Spend and pauses: a paid turn's charge, and a tab paused at its spend
// limit, for untrusted usage, or for an answer or hold that is not coming.

/** Where a hold-stall pause's reason starts (it clears by itself). */
const HOLD_STALL = "Waiting on a hold that nobody is working to lift: ";

export const holds = {
  /** A tab's paid spend is at or over its limit, or (for a paid turn, or
   * after one) the Console-wide spend is at or over its own. */
  overSpend(this: ConsoleWorker, tabId: string, paid = false): boolean {
    const tab = this.store.tab(tabId);
    if (!tab) return false;
    const limit = tab.spendLimitUsd ?? this.limits.tabSpendUsd;
    const spent = this.store.tabSpend(tabId);
    if (spent >= limit) {
      this.pause(tabId, spendPauseReason(spent, limit));
      return true;
    }
    return paid && this.consoleOverSpend();
  },
  /** The Console-wide spend is at or over its limit: every open tab with an
   * open API-key agent pauses (subscription work goes on). */
  consoleOverSpend(this: ConsoleWorker): boolean {
    const all = this.store.consoleSpend();
    if (all.usd < all.limitUsd) return false;
    const reason = consoleSpendPauseReason(all.usd, all.limitUsd);
    for (const tab of this.store.allTabs()) {
      if (tab.paused || tab.archivedAt !== null) continue;
      const agents = this.store.agents(tab.projectId).filter((a) => a.tabId === tab.id && a.state !== "closed");
      if (agents.some((a) => agentModel(a.kind, a.model)?.paid)) this.pause(tab.id, reason);
    }
    return true;
  },
  /** After a paid turn: the tab pauses at its spend limit, and when the
   * turn's usage was not reported or did not add up. */
  checkSpend(this: ConsoleWorker, agent: ConsoleAgent, charge: { usd: number; basis: "reported" | "allowance" }): void {
    // Usage that could not be trusted holds the tab first (written with
    // the charge), so it always needs a Resume; a spend limit it also
    // reached pauses the tab again at the next paid turn, until Reset spend.
    if (charge.basis === "allowance") return;
    this.overSpend(agent.tabId, true);
  },
  /** A paid turn's charge (spend.ts: `usage` is the client's whole-turn
   * usage once it ended normally, or null); an allowance carries the tab's
   * hold, which the store writes in the same transaction. */
  charge(
    this: ConsoleWorker,
    agent: ConsoleAgent,
    model: BilledModel,
    turnId: number,
    usage: TurnUsage | null | undefined,
    running?: RunningUsage,
  ): (Charge & { hold?: string }) | null {
    // Priced at the rates of when the turn started, never when it ended or
    // a later restart charged it (a scheduled price change, pricing.ts).
    const charge = chargeTurn(model, usage, pricedAt(this.store.turn(turnId), this.now()), running);
    if (!charge || charge.basis !== "allowance") return charge;
    const n = charge.allowances ?? 1;
    const what = n === 1 ? "the full allowance for a request" : `the full allowance for each of ${n} requests`;
    return {
      ...charge,
      hold: `${USAGE_PAUSE}${agent.name}'s turn ${turnId} did not report usage the Console can trust, so it was charged ${what} whose usage it did not report (${usd(charge.usd)} in all). Resume to let the tab continue.`,
    };
  },
  /** A tab at its spend limit pauses, from the costs stored with its turns,
   * however it got there (an allowance, a charge just before a restart):
   * the pause never depends on a write after the charge. */
  spendHolds(this: ConsoleWorker): void {
    for (const tab of this.store.allTabs()) if (!tab.paused && tab.archivedAt === null) this.overSpend(tab.id);
    this.consoleOverSpend();
  },
  /** A tab held for a usage failure whose other pause was lifted pauses
   * again with that reason. */
  usageHolds(this: ConsoleWorker): void {
    for (const { tabId, reason } of this.store.usageHolds()) this.pause(tabId, reason);
  },

  pause(this: ConsoleWorker, tabId: string, reason: string): void {
    this.log(`tab ${tabId} paused: ${reason}`);
    this.safe(() => this.store.pauseTab(this.epoch!, tabId, reason));
  },
  /** An instruction that began at `startedAt` and ran past its wall time
   * pauses its tab. */
  instructionOverdue(this: ConsoleWorker, tabId: string, startedAt: number): boolean {
    if (this.now() - startedAt <= this.limits.instructionMs) return false;
    this.pause(tabId, `Limit reached: one instruction has run for more than ${Math.round(this.limits.instructionMs / 60_000)} minutes. Resume to let the team continue.`);
    return true;
  },

  /** A stalled ask: every agent in a tab idle while an ask is still open
   * means an answer that is not coming; the tab pauses and says so. `open`
   * is the tick's open turns, and what refreshes are owed is read at most
   * once per tick, not once per tab. */
  stallCheck(this: ConsoleWorker, open: TurnRow[]): void {
    let owed: Set<string> | undefined;
    for (const tab of this.store.allTabs()) {
      if (tab.archivedAt !== null || this.store.project(tab.projectId)?.archivedAt != null) continue;
      if (this.store.pausedFor({ projectId: tab.projectId, tabId: tab.id })) continue;
      const agents = this.store.agents(tab.projectId).filter((a) => a.tabId === tab.id);
      const asks = this.store.openAsks(tab.id);
      // Holds count too: a held agent with mail waits on its holder.
      const held = agents.filter((a) => this.heldWaiting(a, open));
      if (!asks && !held.length) continue;
      // A held agent's waiting team turn is not work in progress.
      const working = (a: ConsoleAgent) =>
        open.some((t) => t.agentId === a.id && !(t.status === "queued" && t.trigger === "team" && this.store.heldBy(a)));
      if (agents.some((a) => working(a) || this.runtimes.get(a.id)?.turn || this.runtimes.get(a.id)?.busy)) continue;
      const due = (owed ??= new Set(this.refreshOwed()));
      if (agents.some((a) => this.refreshing.has(a.id) || due.has(a.id) || a.state === "creating")) continue;
      // Mail for a ready agent that is not held is delivered on the next pass.
      if (agents.some((a) => a.state === "ready" && !this.store.heldBy(a) && this.store.queuedMessages(a.id).length)) continue;
      const hold = held.length ? this.store.heldBy(held[0]) : null;
      this.pause(
        tab.id,
        hold
          ? `${HOLD_STALL}${held[0].name} is on hold by ${hold.holderName} (${hold.reason}). Resume (or Lift) ends it.`
          : "Waiting on an answer that is not coming: every agent is idle while an ask is still open.",
      );
    }
  },

  /** A tab paused because nobody was lifting a hold resumes by itself once
   * no such hold is left (Lift, team_resume, the timeout); any other pause
   * stays until the owner resumes. */
  clearHoldStalls(this: ConsoleWorker): void {
    for (const tab of this.store.allTabs()) {
      if (!tab.paused || !tab.pauseReason?.startsWith(HOLD_STALL)) continue;
      const agents = this.store.agents(tab.projectId).filter((a) => a.tabId === tab.id);
      const open = this.store.openTurns();
      if (agents.some((a) => this.heldWaiting(a, open))) continue;
      this.safe(() => this.store.unpauseTab(this.epoch!, tab.id, HOLD_STALL));
    }
  },
  /** On hold, with mail or a team turn waiting. */
  heldWaiting(this: ConsoleWorker, agent: ConsoleAgent, open: TurnRow[]): boolean {
    if (!this.store.heldBy(agent)) return false;
    return this.store.queuedMessages(agent.id).length > 0 || open.some((t) => t.agentId === agent.id && t.status === "queued" && t.trigger === "team");
  },
};
