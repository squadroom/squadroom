import { agentModel } from "./agents.ts";
import { keysPageView, needsView, tabSpend, workerView, type TabSpend, type WorkerView } from "./views.ts";
import { consolePaths } from "./config.ts";
import { IMAGE_KEY } from "./image-tools.ts";
import type { KeyRow } from "./keys-page.ts";
import { MIN_FREE_BYTES, freeBytes } from "./repos.ts";
import type { ConsoleStore, EndedTurn } from "./store.ts";
import { needCount } from "./ui.ts";

// The Overview: one page of what the owner checks first — health,
// activity, spend and problems — from reads the Console already has.
// Nothing here starts work or calls a model.

const DAY_MS = 24 * 60 * 60_000;
/** Problems shown: failed and interrupted turns of the last 24 hours. */
const PROBLEMS_MAX = 50;

export interface OverviewSpend {
  tabs: { tabId: string; tabName: string; projectId: string; projectName: string; today: number; month: number; sinceReset: TabSpend }[];
  /** API keys by name and where they are set (a project's own, or the
   * global one), this month, against the provider-side cap. */
  keys: { name: string; label: string; projectName: string | null; month: number; capUsd: number | null }[];
}

export interface Overview {
  health: {
    worker: WorkerView;
    leaseRenewedAt: number | null;
    backup: { succeededAt: number; failedAt: number };
    /** E-mails given up on after their 24 hours of retries. */
    mailFailed: number;
    disk: { freeBytes: number | null; floorBytes: number };
    /** Each offered agent kind's verified version and, once Check
     * connection has run, the version it found. */
    clients: { kind: string; label: string; pinned: string; installed: string | null; checkedAt: number | null }[];
  };
  activity: { running: number; queued: number; needs: number; paused: { scope: string; name: string; reason: string }[] };
  spend: OverviewSpend;
  problems: { turnId: number; agentId: string; agentName: string; place: string; status: string; reason: string | null; endedAt: number }[];
}

/** Local midnight and the first of the month, for `now`. */
export function spendWindows(now: number): { dayStart: number; monthStart: number } {
  const d = new Date(now);
  return { dayStart: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), monthStart: new Date(d.getFullYear(), d.getMonth(), 1).getTime() };
}

/** Which stored key a turn was charged to: its model's credential, from
 * the project's own entry when it has one, else the global one (as
 * `keyFor` chooses). Null for a subscription turn. */
export function chargedKey(turn: Pick<EndedTurn, "kind" | "model" | "projectId" | "credential">, keys: { global: KeyRow[]; projects: Record<string, KeyRow[]> }): { name: string; projectId: string | null; row: KeyRow | null } | null {
  const credential = turn.credential ?? agentModel(turn.kind, turn.model)?.paid?.credential;
  if (!credential) return null;
  const own = keys.projects[turn.projectId]?.find((r) => r.name === credential);
  if (own) return { name: credential, projectId: turn.projectId, row: own };
  return { name: credential, projectId: null, row: keys.global.find((r) => r.name === credential) ?? null };
}

/** Today's and this month's spend per tab and per key (pure). */
export function sumSpend(
  turns: EndedTurn[],
  windows: { dayStart: number; monthStart: number },
  keyOf: (t: EndedTurn) => { name: string; projectId: string | null; row: KeyRow | null } | null,
): { tabs: Map<string, { today: number; month: number }>; keys: Map<string, { name: string; projectId: string | null; row: KeyRow | null; month: number }> } {
  const tabs = new Map<string, { today: number; month: number }>();
  const keys = new Map<string, { name: string; projectId: string | null; row: KeyRow | null; month: number }>();
  for (const t of turns) {
    if (!t.costUsd || t.endedAt < windows.monthStart) continue;
    const tab = tabs.get(t.tabId) ?? { today: 0, month: 0 };
    tab.month += t.costUsd;
    if (t.endedAt >= windows.dayStart) tab.today += t.costUsd;
    tabs.set(t.tabId, tab);
    const key = keyOf(t);
    if (!key) continue;
    const id = `${key.name}:${key.projectId ?? ""}`;
    const k = keys.get(id) ?? { ...key, month: 0 };
    k.month += t.costUsd;
    keys.set(id, k);
  }
  return { tabs, keys };
}

/** Failed and interrupted turns since `since`, newest first (pure). */
export function problemTurns(turns: EndedTurn[], since: number): EndedTurn[] {
  return turns.filter((t) => t.endedAt >= since && (t.status === "failed" || t.status === "interrupted")).slice(0, PROBLEMS_MAX);
}

export function overviewView(store: ConsoleStore, keysPath: string, now: number): Overview {
  const windows = spendWindows(now);
  const since = Math.min(windows.monthStart, now - DAY_MS);
  const turns = store.endedSince(since);
  const page = keysPageView(store, keysPath);
  // Image calls count as spend; they are never problems.
  const { tabs, keys } = sumSpend([...turns, ...store.imageSpendSince(since, IMAGE_KEY)], windows, (t) => chargedKey(t, page.keys));
  const projectName = (id: string | null) => (id ? (store.project(id)?.name ?? id) : null);
  const open = store.openTurns();
  let disk: number | null = null;
  try {
    disk = freeBytes(consolePaths().agentHome);
  } catch {
    // The agent's home is not readable here: shown as unknown.
  }
  return {
    health: {
      worker: workerView(store, now),
      leaseRenewedAt: store.lease()?.renewedAt ?? null,
      backup: store.backupState(),
      mailFailed: store.failedMailCount(),
      disk: { freeBytes: disk, floorBytes: MIN_FREE_BYTES },
      clients: page.connections
        .filter((c) => c.offered)
        .map((c) => ({ kind: c.kind, label: c.label, pinned: c.pinned, installed: c.check?.installed ?? null, checkedAt: c.check?.checkedAt ?? null })),
    },
    activity: {
      running: open.filter((t) => t.status !== "queued").length,
      queued: open.filter((t) => t.status === "queued").length,
      needs: needCount(needsView(store)),
      paused: store.pausedList().map((p) => ({ scope: p.scope, name: p.name, reason: p.reason })),
    },
    spend: {
      // Tabs are archived, never deleted, so every charged turn's tab exists.
      tabs: [...tabs].map(([tabId, s]) => {
        const tab = store.tab(tabId)!;
        return { tabId, tabName: tab.name, projectId: tab.projectId, projectName: projectName(tab.projectId)!, ...s, sinceReset: tabSpend(store, tab) };
      }),
      keys: [...keys.values()].map((k) => ({ name: k.name, label: k.row?.label ?? k.name, projectName: projectName(k.projectId), month: k.month, capUsd: k.row?.cap?.usd ?? null })),
    },
    problems: problemTurns(turns, now - DAY_MS).map((t) => ({
      turnId: t.id,
      agentId: t.agentId,
      agentName: t.agentName,
      place: `${projectName(t.projectId)} › ${store.tab(t.tabId)?.name ?? ""}`,
      status: t.status,
      reason: t.reason,
      endedAt: t.endedAt,
    })),
  };
}
