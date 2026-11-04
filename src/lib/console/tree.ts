// The navigation tree: every project → its tabs → the agents in each tab,
// by name, with a status dot. Projects and tabs collapse; the collapsed set
// is remembered per device as a convenience only. Browser-safe and pure.

/** What an agent's dot says. */
export type TreeStatus = "working" | "needs_you" | "queued" | "idle" | "paused" | "error" | "creating";

interface TreeAgent {
  id: string;
  name: string;
  status: TreeStatus;
  /** Its AI (`claude-code`, `codex`, …), for the kind badge. */
  kind?: string;
}
interface TreeTab {
  id: string;
  name: string;
  paused: boolean;
  agents: TreeAgent[];
}
export interface TreeProject {
  id: string;
  name: string;
  paused: boolean;
  /** The busiest of its agents' states, for the project's own dot. */
  status: TreeStatus;
  tabs: TreeTab[];
}

/** Rows the sidebar draws, top to bottom, after collapsing. */
export type TreeRow =
  | { key: string; kind: "project"; depth: 0; id: string; name: string; status: TreeStatus; expanded: boolean; count: number; paused: boolean }
  | { key: string; kind: "tab"; depth: 1; id: string; projectId: string; name: string; expanded: boolean; count: number; paused: boolean }
  | { key: string; kind: "agent"; depth: 2; id: string; projectId: string; tabId: string; name: string; status: TreeStatus; agentKind?: string };

export const projectKey = (id: string) => `p:${id}`;
export const tabKey = (id: string) => `t:${id}`;

/** Most to least urgent: a project's dot shows the first its agents have. */
const URGENCY: TreeStatus[] = ["needs_you", "error", "working", "queued", "creating", "paused", "idle"];

export function projectStatus(agents: TreeAgent[]): TreeStatus {
  for (const status of URGENCY) if (agents.some((a) => a.status === status)) return status;
  return "idle";
}

/** A paused tab or project shows its idle agents as paused (a running turn
 * still shows as working until it ends). */
function effective(status: TreeStatus, paused: boolean): TreeStatus {
  return paused && (status === "idle" || status === "queued") ? "paused" : status;
}

export function buildTree(input: {
  projects: { id: string; name: string; paused?: boolean }[];
  tabs: { id: string; projectId: string; name: string; paused?: boolean }[];
  agents: { id: string; tabId: string; name: string; status: TreeStatus; kind?: string }[];
}): TreeProject[] {
  return input.projects.map((p) => {
    const tabs = input.tabs
      .filter((t) => t.projectId === p.id)
      .map((t) => {
        const paused = !!(t.paused || p.paused);
        return {
          id: t.id,
          name: t.name,
          paused,
          agents: input.agents.filter((a) => a.tabId === t.id).map((a) => ({ id: a.id, name: a.name, status: effective(a.status, paused), kind: a.kind })),
        };
      });
    return { id: p.id, name: p.name, paused: !!p.paused, status: projectStatus(tabs.flatMap((t) => t.agents)), tabs };
  });
}

/** The rows to draw: a collapsed project hides its tabs, a collapsed tab its
 * agents. */
export function visibleRows(tree: TreeProject[], collapsed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const p of tree) {
    const pOpen = !collapsed.has(projectKey(p.id));
    rows.push({
      key: projectKey(p.id),
      kind: "project",
      depth: 0,
      id: p.id,
      name: p.name,
      status: p.status,
      expanded: pOpen,
      count: p.tabs.reduce((n, t) => n + t.agents.length, 0),
      paused: p.paused,
    });
    if (!pOpen) continue;
    for (const t of p.tabs) {
      const tOpen = !collapsed.has(tabKey(t.id));
      rows.push({ key: tabKey(t.id), kind: "tab", depth: 1, id: t.id, projectId: p.id, name: t.name, expanded: tOpen, count: t.agents.length, paused: t.paused });
      if (!tOpen) continue;
      for (const a of t.agents)
        rows.push({ key: `a:${a.id}`, kind: "agent", depth: 2, id: a.id, projectId: p.id, tabId: t.id, name: a.name, status: a.status, agentKind: a.kind });
    }
  }
  return rows;
}

export function toggle(collapsed: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(collapsed);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Where clicking an agent goes: its project and tab, and the collapsed set
 * with both opened so the agent stays visible. Null for an unknown agent. */
export function focusTarget(
  tree: TreeProject[],
  agentId: string,
  collapsed: ReadonlySet<string>,
): { projectId: string; tabId: string; agentId: string; collapsed: Set<string> } | null {
  for (const p of tree)
    for (const t of p.tabs)
      if (t.agents.some((a) => a.id === agentId)) {
        const next = new Set(collapsed);
        next.delete(projectKey(p.id));
        next.delete(tabKey(t.id));
        return { projectId: p.id, tabId: t.id, agentId, collapsed: next };
      }
  return null;
}

/** The remembered collapsed set (per device; anything unreadable is empty).
 * Keys of projects and tabs that no longer exist are dropped. */
export function readCollapsed(raw: string | null, tree?: TreeProject[]): Set<string> {
  let keys: string[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) keys = parsed.filter((k): k is string => typeof k === "string" && /^[pt]:[a-z0-9]{1,40}$/.test(k));
  } catch {
    keys = [];
  }
  if (tree) {
    const known = new Set(tree.flatMap((p) => [projectKey(p.id), ...p.tabs.map((t) => tabKey(t.id))]));
    keys = keys.filter((k) => known.has(k));
  }
  return new Set(keys);
}
export function writeCollapsed(collapsed: ReadonlySet<string>): string {
  return JSON.stringify([...collapsed].sort());
}

export const STATUS_TEXT: Record<TreeStatus, string> = {
  working: "Working",
  needs_you: "Needs you",
  queued: "Queued",
  idle: "Idle",
  paused: "Paused",
  error: "Error",
  creating: "Setting up",
};

