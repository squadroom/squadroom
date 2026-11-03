import { CONSOLE_SPEND_PAUSE, LIMITS, SPEND_PAUSE, USAGE_PAUSE, type ConsoleAgent } from "../types.ts";
import type { ConsoleStore } from "../store.ts";
import { consoleSpendPauseReason, consoleSpendRaisedReason, spendPauseReason, spendRaisedReason } from "../spend.ts";

/** The flag that pauses everything (its value is the reason). */
export const PAUSE_ALL = "pause-all";
/** Set ("on") when the owner wants the Needs you e-mail. */
export const NEEDS_MAIL = "needs-mail";
/** The Console-wide spend limit in dollars, when the owner set one. */
const CONSOLE_SPEND_LIMIT = "console-spend-limit";
/** When the owner last reset the Console-wide spend (ms). */
const CONSOLE_SPEND_FROM = "console-spend-from";

/** The Console-wide spend as the Overview shows it and the worker applies
 * it: API-key spend since the start of this UTC month or the last reset. */
export interface ConsoleSpend {
  usd: number;
  limitUsd: number;
  /** True when the owner has not set a limit of their own. */
  isDefault: boolean;
  defaultUsd: number;
  /** Spend counts from here: the month's start or the last reset. */
  from: number;
}

type Paused = { scope: "all" | "project" | "tab"; id: string | null; name: string; projectId: string | null; reason: string };

// Pause and Resume, usage holds and spend limits, the ACP network switch,
// worker flags and logins out of usage.
export const pause = {
  /** A worker-wide state the page shows (for example why Codex is off). */
  setFlag(this: ConsoleStore, epoch: number, key: string, value: string | null) {
    this.transaction(() => this.putFlag(key, value), epoch);
  },
  /** setFlag's work, in the caller's transaction (null deletes it). */
  putFlag(this: ConsoleStore, key: string, value: string | null) {
    if (value === null) this.run("DELETE FROM console_flags WHERE key = ?", key);
    else this.run("INSERT INTO console_flags (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  },
  flag(this: ConsoleStore, key: string): string | null {
    return (this.get("SELECT value FROM console_flags WHERE key = ?", key)?.value as string) ?? null;
  },
  /** A login out of usage: its queued turns wait until then. The longest
   * pause wins: a later report with an earlier reset never shortens a
   * window that is still exhausted. */
  setPause(this: ConsoleStore, epoch: number, login: string, until: number) {
    this.write(epoch, "INSERT INTO console_pauses (login, until) VALUES (?, ?) ON CONFLICT(login) DO UPDATE SET until = MAX(until, excluded.until)", login, until);
  },
  pausedUntil(this: ConsoleStore, login: string): number {
    return (this.get("SELECT until FROM console_pauses WHERE login = ?", login)?.until as number) ?? 0;
  },
  /** Why an agent's work is paused (the narrowest reason), or null. */
  pausedFor(this: ConsoleStore, agent: Pick<ConsoleAgent, "projectId" | "tabId">): string | null {
    const all = this.flag(PAUSE_ALL);
    if (all !== null) return all || "Everything is paused.";
    const project = this.pauseReason("project", agent.projectId);
    if (project !== null) return project || "This project is paused.";
    const tab = this.pauseReason("tab", agent.tabId);
    if (tab !== null) return tab || "This tab is paused.";
    return null;
  },
  pauseReason(this: ConsoleStore, scope: "tab" | "project", id: string): string | null {
    const r = this.get(`SELECT paused, pause_reason FROM console_${scope === "tab" ? "tabs" : "projects"} WHERE id = ?`, id);
    return r?.paused ? ((r.pause_reason as string | null) ?? "") : null;
  },
  /** Pause or Resume: a tab, a project, or everything. Resume also
   * resumes what lies inside, and restarts the instruction limits' count. */
  setPaused(this: ConsoleStore, scope: "tab" | "project" | "all", id: string | null, paused: boolean, reason: string | null = null) {
    this.transaction(() => {
      const now = this.now();
      const last = this.lastTurnId();
      const resumeTabs = (where: string, ...args: string[]) => {
        // A usage hold is lifted only by resuming that tab's own pause that
        // showed it; resuming a project or everything leaves it, and the
        // tab pauses again with it. A spend-limit pause outlasts any
        // Resume: only Reset spend lifts it; the Console-wide one, only
        // raising or resetting that limit.
        this.run(
          `UPDATE console_tabs SET usage_hold = CASE WHEN ? AND paused = 1 AND substr(pause_reason, 1, ?) = ? THEN NULL ELSE usage_hold END, paused = 0, pause_reason = NULL, count_from = ?, resumed_at = ? ${where ? `${where} AND` : "WHERE"} NOT (paused = 1 AND (substr(COALESCE(pause_reason, ''), 1, ?) = ? OR substr(COALESCE(pause_reason, ''), 1, ?) = ?))`,
          scope === "tab" ? 1 : 0, USAGE_PAUSE.length, USAGE_PAUSE, last, now, ...args, SPEND_PAUSE.length, SPEND_PAUSE, CONSOLE_SPEND_PAUSE.length, CONSOLE_SPEND_PAUSE,
        );
        // The owner's Resume also lifts the agents' holds.
        this.run(`UPDATE console_holds SET released_at = ? WHERE released_at IS NULL AND tab_id IN (SELECT id FROM console_tabs ${where})`, now, ...args);
      };
      if (scope === "all") {
        this.putFlag(PAUSE_ALL, paused ? (reason ?? "") : null);
        if (!paused) {
          this.run("UPDATE console_projects SET paused = 0, pause_reason = NULL");
          resumeTabs("");
        }
        return;
      }
      if (scope === "project") {
        if (!this.project(id!)) throw new Error("That project does not exist.");
        this.run("UPDATE console_projects SET paused = ?, pause_reason = ? WHERE id = ?", paused ? 1 : 0, paused ? reason : null, id!);
        if (!paused) resumeTabs("WHERE project_id = ?", id!);
        return;
      }
      if (!this.tab(id!)) throw new Error("That tab does not exist.");
      if (paused) this.run("UPDATE console_tabs SET paused = 1, pause_reason = ? WHERE id = ?", reason, id!);
      else resumeTabs("WHERE id = ?", id!);
    });
  },
  /** The worker pauses a tab (a limit, the stall check). */
  pauseTab(this: ConsoleStore, epoch: number, tabId: string, reason: string) {
    this.write(epoch, "UPDATE console_tabs SET paused = 1, pause_reason = ? WHERE id = ? AND paused = 0", reason, tabId);
  },
  /** The worker lifts its own pause (only if the reason is still its own). */
  unpauseTab(this: ConsoleStore, epoch: number, tabId: string, reasonPrefix: string) {
    this.transaction(() => this.liftPause(tabId, reasonPrefix), epoch);
  },
  /** A tab's pause is lifted if its reason starts with `prefix`. */
  liftPause(this: ConsoleStore, tabId: string, prefix: string) {
    this.run("UPDATE console_tabs SET paused = 0, pause_reason = NULL WHERE id = ? AND paused = 1 AND substr(pause_reason, 1, ?) = ?", tabId, prefix.length, prefix);
  },
  /** Stop now: running turns stop; queued ones stay for Resume. */
  stopRunning(this: ConsoleStore, agentIds: string[]): number {
    let n = 0;
    for (const id of agentIds)
      n += this.run("UPDATE console_turns SET stop_requested = 'stop' WHERE agent_id = ? AND status IN ('running', 'waiting_for_owner') AND stop_requested IS NULL", id);
    return n;
  },
  /** Paused tabs and projects (Needs you). */
  pausedList(this: ConsoleStore): Paused[] {
    const out: Paused[] = [];
    const all = this.flag(PAUSE_ALL);
    if (all !== null) out.push({ scope: "all", id: null, name: "Everything", projectId: null, reason: all });
    for (const r of this.all("SELECT id, name, pause_reason FROM console_projects WHERE paused = 1 AND archived_at IS NULL"))
      out.push({ scope: "project", id: r.id as string, name: r.name as string, projectId: r.id as string, reason: (r.pause_reason as string | null) ?? "" });
    for (const r of this.all(
      "SELECT t.id, t.name, t.project_id, t.pause_reason FROM console_tabs t JOIN console_projects p ON p.id = t.project_id WHERE t.paused = 1 AND t.archived_at IS NULL AND p.archived_at IS NULL",
    ))
      out.push({ scope: "tab", id: r.id as string, name: r.name as string, projectId: r.project_id as string, reason: (r.pause_reason as string | null) ?? "" });
    return out;
  },

  // ── Usage holds and spend limits ───────────────────────────
  /** Inside a transaction: the tab holds for the owner's Resume, and pauses
   * with that reason unless it is paused already (it then pauses with it
   * again when that other pause is lifted). */
  holdForUsage(this: ConsoleStore, tabId: string, reason: string) {
    this.run("UPDATE console_tabs SET usage_hold = ? WHERE id = ?", reason, tabId);
    this.run("UPDATE console_tabs SET paused = 1, pause_reason = ? WHERE id = ? AND paused = 0", reason, tabId);
  },
  /** Unpaused tabs that still hold for a usage failure. */
  usageHolds(this: ConsoleStore): { tabId: string; reason: string }[] {
    return this.all("SELECT id, usage_hold FROM console_tabs WHERE usage_hold IS NOT NULL AND paused = 0").map((r) => ({
      tabId: r.id as string,
      reason: r.usage_hold as string,
    }));
  },
  /** A tab's paid spend since its last Reset spend: the sum of its turns'
   * costs and its image calls'. Resume does not reset it. */
  tabSpend(this: ConsoleStore, tabId: string): number {
    const since = "(SELECT spend_reset_seq FROM console_tabs WHERE id = ?1)";
    return Number(
      this.get(
        `SELECT (SELECT COALESCE(SUM(t.cost_usd), 0) FROM console_turns t JOIN console_agents a ON a.id = t.agent_id WHERE a.tab_id = ?1 AND t.ended_seq > ${since})
          + (SELECT COALESCE(SUM(cost_usd), 0) FROM console_image_calls WHERE tab_id = ?1 AND seq > ${since}) AS usd`,
        tabId,
      )!.usd,
    );
  },
  /** The project's Image tools switch, set by the owner (turning it on
   * needs a fresh code). A Claude Code session is offered the tools from
   * its start. */
  setImageTools(this: ConsoleStore, projectId: string, on: boolean) {
    if (!this.run("UPDATE console_projects SET image_tools = ? WHERE id = ?", on ? 1 : 0, projectId)) throw new Error("That project does not exist.");
  },
  /** Reset spend, by the owner with a fresh code: the tab's spend counts
   * turns ending from now on; a tab paused by its spend limit resumes. */
  resetSpend(this: ConsoleStore, tabId: string) {
    this.transaction(() => {
      if (!this.tab(tabId)) throw new Error("That tab does not exist.");
      // Costs already incurred are dropped; every turn ending later counts,
      // the ones queued or running now included.
      this.run("UPDATE console_tabs SET spend_reset_seq = (SELECT COALESCE(MAX(id), 0) FROM console_events) WHERE id = ?", tabId);
      this.liftPause(tabId, SPEND_PAUSE);
    });
  },
  /** A tab's spend limit as the worker applies it: its own, or the default. */
  spendLimit(this: ConsoleStore, tabId: string, defaultUsd: number): number | null {
    const tab = this.tab(tabId);
    return tab ? (tab.spendLimitUsd ?? defaultUsd) : null;
  },
  /**
   * The owner sets a tab's spend limit: dollars, or null for the default.
   * Raising it needs a fresh code; the caller says whether it checked one,
   * and a raise without one is refused here, in the same transaction that
   * reads the limit, so a change made meanwhile from another device cannot
   * turn a lowering into a raise. Setting a limit
   * never lifts a pause: a tab paused at its old limit that is now under
   * its new one waits for an ordinary Resume (or Reset spend); one still at
   * or over it stays paused for spend, with the new limit in its reason. A
   * lower limit the tab has already reached pauses it at the worker's next
   * check, from the costs stored with its turns.
   */
  setSpendLimit(this: ConsoleStore, tabId: string, limitUsd: number | null, defaultUsd: number, mayRaise: boolean) {
    this.transaction(() => {
      const tab = this.tab(tabId);
      if (!tab) throw new Error("That tab does not exist.");
      const before = tab.spendLimitUsd ?? defaultUsd;
      const after = limitUsd ?? defaultUsd;
      if (after > before && !mayRaise) throw new Error("The limit changed meanwhile; set it again.");
      this.run("UPDATE console_tabs SET spend_limit_usd = ? WHERE id = ?", limitUsd, tabId);
      if (!tab.paused || !(tab.pauseReason ?? "").startsWith(SPEND_PAUSE)) return;
      const spent = this.tabSpend(tabId);
      this.run("UPDATE console_tabs SET pause_reason = ? WHERE id = ?", spent < after ? spendRaisedReason(spent, after) : spendPauseReason(spent, after), tabId);
    });
  },

  // ── The Console-wide spend limit ───────────────────────────────────────
  /** API-key spend across every tab, open or closed, this UTC month and
   * since the owner's last reset: a turn in the month it started (as the
   * Overview counts it and its prices are fixed) and charged since the
   * reset, image calls by when they were charged. */
  consoleSpend(this: ConsoleStore): ConsoleSpend {
    const d = new Date(this.now());
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const from = Math.max(monthStart, Number(this.flag(CONSOLE_SPEND_FROM) ?? 0));
    const own = this.flag(CONSOLE_SPEND_LIMIT);
    const spent = Number(
      this.get(
        `SELECT (SELECT COALESCE(SUM(cost_usd), 0) FROM console_turns WHERE cost_usd IS NOT NULL AND COALESCE(started_at, ended_at) >= ?1 AND ended_at >= ?2)
          + (SELECT COALESCE(SUM(cost_usd), 0) FROM console_image_calls WHERE created_at >= ?2) AS usd`,
        monthStart,
        from,
      )!.usd,
    );
    const defaultUsd = LIMITS.consoleSpendUsd;
    return { usd: spent, limitUsd: own === null ? defaultUsd : Number(own), isDefault: own === null, defaultUsd, from };
  },
  /**
   * The owner sets the Console-wide limit (dollars, or null for the
   * default). Raising it needs a fresh code: the caller says whether it
   * checked one, and a raise without one is refused in the transaction that
   * reads the limit. Tabs paused at it become ordinary pauses (Resume)
   * once the limit is above the spend; others keep the new limit in their
   * reason.
   */
  setConsoleSpendLimit(this: ConsoleStore, limitUsd: number | null, mayRaise: boolean) {
    this.transaction(() => {
      const before = this.consoleSpend();
      const after = limitUsd ?? before.defaultUsd;
      if (after > before.limitUsd && !mayRaise) throw new Error("The limit changed meanwhile; set it again.");
      this.putFlag(CONSOLE_SPEND_LIMIT, limitUsd === null ? null : String(limitUsd));
      const reason = before.usd < after ? consoleSpendRaisedReason(before.usd, after) : consoleSpendPauseReason(before.usd, after);
      this.run("UPDATE console_tabs SET pause_reason = ? WHERE paused = 1 AND substr(pause_reason, 1, ?) = ?", reason, CONSOLE_SPEND_PAUSE.length, CONSOLE_SPEND_PAUSE);
    });
  },
  /** Reset the Console-wide spend (owner, behind a fresh code): it counts
   * from now, and the tabs paused at its limit resume. */
  resetConsoleSpend(this: ConsoleStore) {
    this.transaction(() => {
      this.putFlag(CONSOLE_SPEND_FROM, String(this.now()));
      this.run("UPDATE console_tabs SET paused = 0, pause_reason = NULL WHERE paused = 1 AND substr(pause_reason, 1, ?) = ?", CONSOLE_SPEND_PAUSE.length, CONSOLE_SPEND_PAUSE);
    });
  },

  // ── The ACP network switch ───────────────────────────────
  /** The project's network switch for ACP agents, set by the owner with a
   * fresh code: recorded as wanted; the worker applies it once the
   * project's ACP sessions have restarted (`now`: their running turns are
   * stopped first). */
  setAcpNetwork(this: ConsoleStore, projectId: string, on: boolean, now: boolean) {
    this.transaction(() => {
      const p = this.project(projectId);
      if (!p) throw new Error("That project does not exist.");
      if (p.acpNetwork === on && p.acpNetworkPending === null) return;
      this.run("UPDATE console_projects SET acp_network_wanted = ?, acp_network_now = ? WHERE id = ?", on ? 1 : 0, now ? 1 : 0, projectId);
    });
  },
  /** A pending network change, and whether its running ACP turns are to be
   * stopped rather than waited for. */
  acpNetworkChange(this: ConsoleStore, projectId: string): { on: boolean; now: boolean } | null {
    const r = this.get("SELECT acp_network_wanted, acp_network_now FROM console_projects WHERE id = ?", projectId);
    if (!r || r.acp_network_wanted === null) return null;
    return { on: r.acp_network_wanted === 1, now: r.acp_network_now === 1 };
  },
  /** The worker applies the change (its ACP sessions have restarted). */
  applyAcpNetwork(this: ConsoleStore, epoch: number, projectId: string, on: boolean) {
    this.write(epoch, "UPDATE console_projects SET acp_network = ?, acp_network_wanted = NULL, acp_network_now = 0 WHERE id = ? AND acp_network_wanted = ?", on ? 1 : 0, projectId, on ? 1 : 0);
  },
};
