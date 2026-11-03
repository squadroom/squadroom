import { agentModel } from "./agents.ts";
import { keysPageView, needsView, tabSpendView, workerView, type TabSpend, type WorkerView } from "./views.ts";
import { consolePaths } from "./config.ts";
import { IMAGE_KEY } from "./image-tools.ts";
import { readKeyFile } from "./keys.ts";
import { fingerprint } from "./spend.ts";
import { credentialInfo, type KeyRow } from "./keys-page.ts";
import { MIN_FREE_BYTES, freeBytes } from "./repos.ts";
import type { ConsoleStore, EndedTurn } from "./store.ts";
import type { ConsoleSpend } from "./store/pause.ts";
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
  /** The Console-wide limit across every tab (this UTC month). */
  console: ConsoleSpend;
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

/** UTC midnight and the first of the month in UTC, for `now`: the months
 * providers bill and cap by. */
export function spendWindows(now: number): { dayStart: number; monthStart: number } {
  const d = new Date(now);
  return { dayStart: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), monthStart: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) };
}

/** A charged key: its name and where it is set; `row` is the key there now,
 * or null when the turn was paid by another key since replaced there (its
 * spend stays with that earlier key). */
export interface ChargedKey {
  name: string;
  projectId: string | null;
  row: KeyRow | null;
  /** The paying key's fingerprint, when the turn recorded it. */
  print?: string;
}

/** Which stored key a turn was charged to: the one it recorded when it
 * started (by its fingerprint and where it was set), or, for a turn from
 * before that was kept and an image call, its model's credential from the
 * project's own entry when it has one, else the global one (as `keyFor`
 * chooses). `printAt` gives the fingerprint of the key set there now. Null
 * for a subscription turn. */
export function chargedKey(
  turn: Pick<EndedTurn, "kind" | "model" | "projectId" | "credential" | "paidBy">,
  keys: { global: KeyRow[]; projects: Record<string, KeyRow[]> },
  printAt: (name: string, projectId: string | null) => string | null = () => null,
): ChargedKey | null {
  const credential = turn.credential ?? turn.paidBy?.name ?? agentModel(turn.kind, turn.model)?.paid?.credential;
  if (!credential) return null;
  const rowAt = (projectId: string | null) => (projectId ? keys.projects[projectId] : keys.global)?.find((r) => r.name === credential) ?? null;
  if (turn.paidBy?.print) {
    const projectId = turn.paidBy.scope === "project" ? turn.projectId : null;
    const print = turn.paidBy.print;
    return { name: credential, projectId, row: printAt(credential, projectId) === print ? rowAt(projectId) : null, print };
  }
  const own = rowAt(turn.projectId);
  if (own) return { name: credential, projectId: turn.projectId, row: own };
  return { name: credential, projectId: null, row: rowAt(null) };
}

/** The fingerprints of the keys set now, by name and place. */
function currentPrints(keysPath: string): (name: string, projectId: string | null) => string | null {
  try {
    const file = readKeyFile(keysPath);
    return (name, projectId) => {
      const value = (projectId ? file.projects[projectId]?.[name] : file.keys[name])?.value.trim();
      return value ? fingerprint(value) : null;
    };
  } catch {
    // No key file, or one that cannot be read: no key is the current one.
    return () => null;
  }
}

/** Today's and this month's spend per tab and per key (pure). */
export function sumSpend(
  turns: EndedTurn[],
  windows: { dayStart: number; monthStart: number },
  keyOf: (t: EndedTurn) => ChargedKey | null,
): { tabs: Map<string, { today: number; month: number }>; keys: Map<string, ChargedKey & { month: number }> } {
  const tabs = new Map<string, { today: number; month: number }>();
  const keys = new Map<string, ChargedKey & { month: number }>();
  for (const t of turns) {
    // A turn counts in the month (and day) it started, as its prices do,
    // never the one a restart charged it in.
    const at = t.startedAt ?? t.endedAt;
    if (!t.costUsd || at < windows.monthStart) continue;
    const tab = tabs.get(t.tabId) ?? { today: 0, month: 0 };
    tab.month += t.costUsd;
    if (at >= windows.dayStart) tab.today += t.costUsd;
    tabs.set(t.tabId, tab);
    const key = keyOf(t);
    if (!key) continue;
    // A key replaced since keeps what it paid, apart from the one there now.
    const id = `${key.name}:${key.projectId ?? ""}${key.row ? "" : `:${key.print ?? ""}`}`;
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
  const printAt = currentPrints(keysPath);
  const { tabs, keys } = sumSpend([...turns, ...store.imageSpendSince(since, IMAGE_KEY)], windows, (t) => chargedKey(t, page.keys, printAt));
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
        return { tabId, tabName: tab.name, projectId: tab.projectId, projectName: projectName(tab.projectId)!, ...s, sinceReset: tabSpendView(store, tab) };
      }),
      keys: [...keys.values()].map((k) => ({
        name: k.name,
        label: k.row ? k.row.label : k.print ? `${credentialInfo(k.name)?.label ?? k.name} (a key since replaced)` : k.name,
        projectName: projectName(k.projectId),
        month: k.month,
        capUsd: k.row?.cap?.usd ?? null,
      })),
      console: store.consoleSpend(),
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
