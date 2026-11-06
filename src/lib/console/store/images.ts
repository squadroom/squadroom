import type { ConsoleStore } from "../store.ts";
import type { ConsoleAgent } from "../types.ts";
import { usd } from "../spend.ts";
import { listPrice } from "../image-tools.ts";
import type { EndedTurn } from "./turns.ts";

// Image calls: each is charged its full list price in the transaction that
// admits it, and refunded only when its job failed or was cancelled. Its
// sequence is its transcript note's event id, so Reset spend (which moves
// the tab's mark to the newest event) covers it like a turn.

type ImageCallState = "open" | "done" | "failed" | "cancelled" | "interrupted";
interface ImageCallRow {
  id: number;
  turnId: number;
  tabId: string;
  tool: string;
  model: string;
  priceUsd: number;
  costUsd: number;
  state: ImageCallState;
  jobId: string | null;
  path: string;
  message: string | null;
}
const micros = (dollars: number) => Math.round(dollars * 1e6);

export const images = {
  /**
   * Admit one call, or say why not: at most `calls` calls and `turnUsd` of
   * list prices in its turn, and the tab's spend plus this price within its
   * limit when it has one, as is the Console-wide spend when the owner set a limit. Admitted, it is charged that price now, with a note in the
   * transcript whose event id is its sequence.
   */
  chargeImageCall(
    this: ConsoleStore,
    epoch: number,
    call: { turnId: number; agent: ConsoleAgent; tool: string; model: string; label: string; priceUsd: number; path: string },
    limits: { calls: number; turnUsd: number },
  ): { id: number } | { refused: string } {
    return this.transaction(() => {
      const turn = this.get("SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS usd FROM console_image_calls WHERE turn_id = ?", call.turnId)!;
      if (Number(turn.n) >= limits.calls) return { refused: `This turn has made its ${limits.calls} image calls. End the turn; the next one may make more.` };
      if (micros(Number(turn.usd) + call.priceUsd) > micros(limits.turnUsd))
        return { refused: `This call (${listPrice(call.priceUsd)}) would take this turn's image calls past ${usd(limits.turnUsd)}.` };
      // The tab's limit as stored now (none unless the owner set one), read
      // in this transaction so a change made meanwhile is honoured.
      const limit = this.tab(call.agent.tabId)?.spendLimitUsd ?? null;
      const spent = this.tabSpend(call.agent.tabId);
      if (limit !== null && micros(spent + call.priceUsd) > micros(limit))
        return { refused: `This call (${listPrice(call.priceUsd)}) would take the tab's spend (${usd(spent)}) past its limit of ${usd(limit)}. Ask the owner to raise it or reset spend.` };
      const all = this.consoleSpend();
      if (all.limitUsd !== null && micros(all.usd + call.priceUsd) > micros(all.limitUsd))
        return { refused: `This call (${listPrice(call.priceUsd)}) would take the Console's spend this month (${usd(all.usd)}) past its limit of ${usd(all.limitUsd)}. Ask the owner to raise it or reset it on the Overview.` };
      const now = this.now();
      const seq = this.insertEvent(call.turnId, call.agent, "note", { text: `${call.tool}: ${call.label}, ${listPrice(call.priceUsd)} charged (refunded if the job fails) → ${call.path}` }, now);
      const id = this.insert(
        "INSERT INTO console_image_calls (turn_id, agent_id, tab_id, tool, model, price_usd, cost_usd, seq, state, path, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)",
        call.turnId, call.agent.id, call.agent.tabId, call.tool, call.model, call.priceUsd, call.priceUsd, seq, call.path, epoch, now,
      );
      return { id };
    }, epoch);
  },
  setImageJob(this: ConsoleStore, epoch: number, id: number, jobId: string) {
    this.write(epoch, "UPDATE console_image_calls SET job_id = ? WHERE id = ? AND state = 'open'", jobId, id);
  },
  /** An open call ends; `refund` sets its cost to $0. */
  settleImageCall(this: ConsoleStore, epoch: number, id: number, state: Exclude<ImageCallState, "open" | "interrupted">, refund: boolean, message: string) {
    this.write(
      epoch,
      "UPDATE console_image_calls SET state = ?, cost_usd = CASE WHEN ? THEN 0 ELSE cost_usd END, message = ?, ended_at = ? WHERE id = ? AND state = 'open'",
      state, refund ? 1 : 0, message, this.now(), id,
    );
  },
  imageCalls(this: ConsoleStore, turnId: number): ImageCallRow[] {
    return this.all("SELECT * FROM console_image_calls WHERE turn_id = ? ORDER BY id", turnId).map((r) => ({
      id: r.id as number,
      turnId: r.turn_id as number,
      tabId: r.tab_id as string,
      tool: r.tool as string,
      model: r.model as string,
      priceUsd: r.price_usd as number,
      costUsd: r.cost_usd as number,
      state: r.state as ImageCallState,
      jobId: (r.job_id as string | null) ?? null,
      path: r.path as string,
      message: (r.message as string | null) ?? null,
    }));
  },
  /** Charged image calls since `since`, shaped as the Overview's turns,
   * each charged to the Krea key (`credential`). */
  imageSpendSince(this: ConsoleStore, since: number, credential: string): EndedTurn[] {
    return this.all(
      "SELECT c.id, c.created_at, c.cost_usd, a.id AS agent_id, a.name, a.tab_id, a.project_id, a.kind, a.model FROM console_image_calls c JOIN console_agents a ON a.id = c.agent_id WHERE c.created_at >= ? AND c.cost_usd > 0",
      since,
    ).map((r) => ({
      id: r.id as number,
      status: "done",
      reason: null,
      endedAt: r.created_at as number,
      costUsd: r.cost_usd as number,
      agentId: r.agent_id as string,
      agentName: r.name as string,
      tabId: r.tab_id as string,
      projectId: r.project_id as string,
      kind: r.kind as ConsoleAgent["kind"],
      model: r.model as string,
      credential,
    }));
  },
};
