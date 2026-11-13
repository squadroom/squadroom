// The page's reads: each view the route answers with, built from the store.
// The owner's commands are in commands.ts.

import { agentModel, networkAutoKind, type AgentKind } from "./agents.ts";
import { connectionPanels, type ConnectionPanel } from "./connections.ts";
import { keysView, type KeysView } from "./keys-page.ts";
import { networkRequest } from "./permissions.ts";
import { roleLibrary, type RoleDef } from "./roles.ts";
import { LEASE_TTL_MS, NEEDS_MAIL, PAUSE_ALL, type ConsoleStore, type TurnRow } from "./store.ts";
import { DOCUMENT_REVIEW, DOCUMENT_REVIEW_ID, isOrchestrator, templateNames, type TabTemplate } from "./templates.ts";
import { buildTree, type TreeProject, type TreeStatus } from "./tree.ts";
import { CODEX_DISABLED, agentStatus, isOpen, type AgentStatus, type ConsoleAgent, type ConsoleProject, type ConsoleTab, type ConsoleTurn } from "./types.ts";

/** An agent's current turn: working beats queued, since a later message may
 * wait behind a running turn. */
const currentTurn = (open: TurnRow[], agentId: string) =>
  open.find((t) => t.agentId === agentId && t.status !== "queued") ?? open.find((t) => t.agentId === agentId) ?? null;

/** The Keys page: the key file's entries without their values, the
 * projects that may override them, and each agent kind's connection. */
export function keysPageView(store: ConsoleStore, keysPath: string): { keys: KeysView; projects: { id: string; name: string; archived: boolean }[]; connections: ConnectionPanel[] } {
  const keys = keysView(keysPath);
  const checks = new Map<AgentKind, ConnectionPanel["check"]>();
  for (const c of store.latestChecks()) {
    const result = (c.result ?? {}) as Record<string, unknown>;
    checks.set(c.kind as AgentKind, {
      state: c.state as "pending" | "running" | "done" | "failed",
      installed: typeof result.installed === "string" ? result.installed : null,
      missing: result.missing === true,
      login: (result.login as "connected" | "signed_out" | "wrong_account" | null | undefined) ?? null,
      note: typeof result.note === "string" ? result.note : null,
      checkedAt: typeof result.checkedAt === "number" ? result.checkedAt : 0,
    });
  }
  return {
    keys,
    projects: store.projects().map((p) => ({ id: p.id, name: p.name, archived: p.archivedAt !== null })),
    connections: connectionPanels(keys, checks),
  };
}

/** The role library (built-ins with the owner's edits, then theirs). */
export function rolesView(store: ConsoleStore): RoleDef[] {
  return roleLibrary(store.roleRows());
}

/** The built-in Document review template, then the owner's. */
export function allTemplates(store: ConsoleStore): { id: string; name: string; body: TabTemplate; builtIn?: boolean }[] {
  return [{ id: DOCUMENT_REVIEW_ID, name: "Document review", body: DOCUMENT_REVIEW, builtIn: true }, ...store.templates()];
}

/** The templates as the page lists them. */
export function templatesView(store: ConsoleStore) {
  return allTemplates(store).map((t) => ({ id: t.id, name: t.name, builtIn: !!t.builtIn, agents: templateNames(t.body), steps: t.body.steps }));
}

export interface WorkerView {
  online: boolean;
  /** Why Codex windows are off, when they are. */
  codexOff: string | null;
  /** A restart interrupts these turns. */
  running: number;
  /** The Claude login is out of usage until then (ms), or null. */
  claudePausedUntil: number | null;
  /** Pause all (everything), with its reason, or null. */
  pausedAll: string | null;
  /** The owner wants the Needs you e-mail. */
  needsMail: boolean;
}
export interface AgentView extends ConsoleAgent {
  status: AgentStatus;
  /** What it is editing (its claims), who holds it, its unfinished merge. */
  claims: { id: number; pattern: string; note: string }[];
  heldBy: { id: number; holderName: string; reason: string } | null;
  merging: { fromName: string; files: string[] } | null;
  turn: Pick<ConsoleTurn, "id" | "status" | "reason" | "startedAt" | "endedAt" | "usage"> | null;
  /** The owner's queued messages, first to run first. */
  queued: { id: number; text: string; first: boolean; next: boolean; edited: boolean; summary: boolean; files: string[]; steering?: boolean; steer?: boolean }[];
  /** A summary waits for its new session's first message. */
  summaryWaiting: boolean;
  /** The context gauge for its current session. */
  gauge: ReturnType<ConsoleStore["gauge"]>;
  /** Its subagents in the current session (helpers row). */
  helpers: ReturnType<ConsoleStore["helpers"]>;
  /** Its task list in the current session, or null. */
  tasks: ReturnType<ConsoleStore["tasks"]>;
  /** False when its client gives this model no task tools. */
  taskTools: boolean;
  /** The base branch's name when GitHub's has commits this agent's branch
   * has not taken in; else null. */
  baseMoved: string | null;
}
export interface TimelineEntry {
  id: number;
  from: string;
  to: string;
  kind: "send" | "ask" | "reply" | "route";
  correlationId: string | null;
  text: string;
  state: string;
  createdAt: number;
}
export interface TabSpend {
  usd: number;
  /** The owner's limit, or null when none is set. */
  limitUsd: number | null;
}

export function tabSpendView(store: ConsoleStore, tab: Pick<ConsoleTab, "id" | "spendLimitUsd">): TabSpend {
  return { usd: store.tabSpend(tab.id), limitUsd: tab.spendLimitUsd };
}


export interface ProjectView {
  project: ConsoleProject;
  tabs: (ConsoleTab & {
    timeline: TimelineEntry[];
    openAsks: number;
    holds: ReturnType<ConsoleStore["holds"]>;
    claims: ReturnType<ConsoleStore["claims"]>;
    routes: ReturnType<ConsoleStore["routes"]>;
    /** Its paid spend since its last Reset spend, and the limit it pauses
     * at: its own or the default. */
    spend: TabSpend;
    steps: ReturnType<ConsoleStore["tabSteps"]>;
  })[];
  /** Closed tabs, for Restore. */
  closedTabs: { id: string; name: string; archivedAt: number }[];
  agents: AgentView[];
  /** Codex windows with a turn running or waiting, in every project: they
   * share one App Server, which Force stop ends. */
  codexRunning: number;
}

/** The team timeline: messages between a tab's agents, each cut at 2,000
 * characters. */
function timelineView(store: ConsoleStore, tabId: string): TimelineEntry[] {
  // A character more than is shown, so a longer body is still marked as cut.
  return store.timeline(tabId, 100, 2001).map((m) => ({
    id: m.id,
    from: m.fromName,
    to: m.toName,
    kind: m.kind,
    correlationId: m.correlationId,
    text: m.body.length > 2000 ? `${m.body.slice(0, 1999)}…` : m.body,
    state: m.state,
    createdAt: m.createdAt,
  }));
}

export function workerView(store: ConsoleStore, now: number): WorkerView {
  const lease = store.lease();
  return {
    online: !!lease && now - lease.renewedAt < LEASE_TTL_MS,
    running: store.openTurns().filter((t) => t.status !== "queued").length,
    claudePausedUntil: store.pausedUntil("claude-code") > now ? store.pausedUntil("claude-code") : null,
    codexOff: store.flag(CODEX_DISABLED),
    pausedAll: store.flag(PAUSE_ALL),
    needsMail: store.flag(NEEDS_MAIL) !== null,
  };
}

export function projectsView(store: ConsoleStore) {
  const running = new Set(
    store
      .openTurns()
      .filter((t) => t.status !== "queued")
      .map((t) => t.agentId),
  );
  return store.projects().map((p) => ({
    ...p,
    working: store.agents(p.id).some((a) => running.has(a.id)),
  }));
}

/** What archiving a project or closing a tab affects: its open agents, how
 * many are working, and how many have commits not yet pushed (a project
 * without GitHub: commits only in their folders). The owner types the name
 * to confirm when any are working or unpushed. */
export interface ArchiveImpact {
  scope: "project" | "tab";
  id: string;
  name: string;
  agents: number;
  working: number;
  unpushed: number;
  github: boolean;
  typeToConfirm: boolean;
}
export function archiveImpact(store: ConsoleStore, scope: "project" | "tab", targetId: string): ArchiveImpact | null {
  const tab = scope === "tab" ? store.tab(targetId) : undefined;
  const project = store.project(scope === "tab" ? (tab?.projectId ?? "") : targetId);
  if (!project || (scope === "tab" && !tab)) return null;
  const agents = store.agents(project.id).filter((a) => a.state !== "closed" && (scope === "project" || a.tabId === targetId));
  const ids = agents.map((a) => a.id);
  const open = store.openTurns();
  const working = agents.filter((a) => open.some((t) => t.agentId === a.id && t.status !== "queued")).length;
  const github = project.source === "github";
  // The branch as last seen after a turn (it includes commits the agent made
  // itself), against the commit its latest push sent.
  const pushed = store.lastPushes(ids);
  const unpushed = ids.filter((a) => {
    const d = store.diff(a);
    if (!d || d.head === d.base) return false;
    if (!github) return true;
    const p = pushed.get(a);
    return !p || (p.head ? p.head !== d.head : d.updatedAt > p.at);
  }).length;
  return { scope, id: targetId, name: (tab ?? project).name, agents: agents.length, working, unpushed, github, typeToConfirm: working > 0 || unpushed > 0 };
}

export function projectView(store: ConsoleStore, projectId: string): ProjectView | null {
  const project = store.project(projectId);
  if (!project) return null;
  // Closed tabs are listed (for Restore) but carry no timeline.
  const tabs = store.tabs(projectId);
  const latest = new Map(store.latestTurns(projectId).map((t) => [t.agentId, t]));
  const claims = new Map(tabs.map((t) => [t.id, store.claims(t.id)]));
  const holds = new Map(tabs.map((t) => [t.id, store.holds(t.id)]));
  const open = store.openTurns();
  const kinds = new Map(store.agents().map((a) => [a.id, a.kind]));
  return {
    project,
    codexRunning: open.filter((t) => t.status !== "queued" && kinds.get(t.agentId) === "codex").length,
    tabs: tabs
      .filter((t) => t.archivedAt === null)
      .map((t) => ({
        ...t,
        timeline: timelineView(store, t.id),
        openAsks: store.openAsks(t.id),
        holds: holds.get(t.id) ?? [],
        claims: claims.get(t.id) ?? [],
        routes: store.routes(t.id),
        spend: tabSpendView(store, t),
        /** Its steps and the current one, or null. */
        steps: store.tabSteps(t.id),
      })),
    closedTabs: tabs.filter((t) => t.archivedAt !== null).map((t) => ({ id: t.id, name: t.name, archivedAt: t.archivedAt! })),
    // A failed agent is listed, with its error.
    agents: store
      .agents(projectId)
      .filter((a) => a.state !== "closed")
      .map((a) => {
        const t = latest.get(a.id) ?? null;
        return {
          ...a,
          claims: (claims.get(a.tabId) ?? []).filter((c) => c.agentId === a.id).map((c) => ({ id: c.id, pattern: c.pattern, note: c.note })),
          // Who holds it: the oldest active hold, as `store.heldBy` reads it.
          heldBy: (holds.get(a.tabId) ?? []).find((h) => h.held === a.id) ?? null,
          merging: store.merging(a.id),
          status: agentStatus(a, currentTurn(open, a.id)),
          turn: t && { id: t.id, status: t.status, reason: t.reason, startedAt: t.startedAt, endedAt: t.endedAt, usage: t.usage },
          // The owner's queued messages, first to run first.
          queued: (() => {
            const all = store.queuedTurns(a.id);
            // First, a message on its way into the running turn: handed to
            // the client, which has not taken it yet.
            const steering = store.steering(a.id).map((q) => ({ id: q.id, text: q.prompt, first: false, next: false, edited: q.revisedAt !== null, summary: false, files: [], steering: true, steer: false }));
            // The one message Steer can hand to the running turn now, if any.
            const offer = store.steerable(a.id)?.id;
            const waiting = all
              .filter((q) => q.trigger === "owner")
              .map((q) => ({
                id: q.id,
                // Whole (at most PROMPT_MAX): Edit loads it into the composer.
                text: q.prompt,
                // The real head of the agent's queue, teammate turns included.
                first: all[0]?.id === q.id,
                next: q.nextAt !== null,
              edited: q.revisedAt !== null,
                summary: q.summary,
                files: store.boundUploads(q.id),
                steering: false,
                steer: q.id === offer,
              }));
            return [...steering, ...waiting];
          })(),
          gauge: store.gauge(a.id),
          helpers: store.helpers(a.id),
          tasks: store.tasks(a.id),
          summaryWaiting: store.carriedSummary(a.id) !== null,
          taskTools: agentModel(a.kind, a.model)?.taskTools !== false,
          baseMoved: store.baseMoved(a) ? project.baseBranch : null,
        };
      }),
  };
}

/** What the owner should know before creating a tab an agent proposed
 *: in a GitHub project, new folders are made from the base
 * branch on GitHub, so work on the proposing agent's branch is not in them.
 * Null when its branch has no changes against the base it started from. */
function unmergedWork(store: ConsoleStore, agentId: string): string | null {
  const agent = store.agent(agentId);
  const project = agent && store.project(agent.projectId);
  if (!agent || project?.source !== "github" || agent.permission !== "edit") return null;
  const files = store.diff(agentId)?.files.length ?? 0;
  if (!files) return null;
  const base = project.baseBranch;
  return `${agent.name}'s branch has changes in ${files === 1 ? "1 file" : `${files} files`} that were not on ${base} when it last took ${base} in. The new tab's folders are made from ${base} on GitHub, so its agents will not have that work unless it has been merged there.`;
}

/** The Needs you tray: open requests and interrupted turns, across
 * every project. */
export function needsView(store: ConsoleStore) {
  const asked = (r: ReturnType<ConsoleStore["openRequests"]>[number]) => ({
    id: r.id,
    agentId: r.agentId,
    agentName: r.agentName,
    projectId: r.projectId,
    kind: r.kind,
    tool: r.tool,
    summary: r.summary,
    // The whole stored input (redacted, at most 64 KB, a cut marked): the
    // tray shows it on request, so the owner sees what Allow once allows.
    input: r.input,
    // Only where there is a rule to remember (a compound command has none).
    canAlways: r.kind === "permission" && !!r.ruleKey,
    canProject: r.kind === "permission" && !!r.ruleKey?.startsWith("network:"),
    // A network request of an agent that has the Network setting: one
    // click allows it and switches the agent to Auto.
    canAuto: r.kind === "permission" && networkRequest(r.tool, r.ruleKey) && networkAutoKind(r.agentKind),
    createdAt: r.createdAt,
  });
  return {
    requests: store.openRequests().map(asked),
    // Permission requests that closed unanswered, each with how
    // often it was asked and when it last closed.
    expired: store.expiredRequests().map((r) => ({ ...asked(r), count: r.count, expiredAt: r.expiredAt })),
    messages: store.interruptedMessages().map((m) => ({
      id: m.id,
      projectId: m.projectId,
      from: m.fromName,
      to: m.toName,
      kind: m.kind,
      text: m.body.length > 300 ? `${m.body.slice(0, 299)}…` : m.body,
    })),
    // A paused tab carries its spend, so a spend pause shows it with the
    // limit beside Reset spend.
    paused: store.pausedList().map((p) => {
      const tab = p.scope === "tab" && p.id ? store.tab(p.id) : undefined;
      return { ...p, spend: tab ? tabSpendView(store, tab) : null };
    }),
    notices: store.notices().map((n) => ({ ...n, warning: n.proposal ? unmergedWork(store, n.agentId) : null })),
    interrupted: store.interruptedTurns().map((t) => ({
      id: t.id,
      agentId: t.agentId,
      agentName: t.agentName,
      projectId: t.projectId,
      prompt: t.prompt.length > 300 ? `${t.prompt.slice(0, 299)}…` : t.prompt,
      reason: t.reason,
    })),
  };
}

/** The owner's search words as an FTS5 query (pure): letters and digits
 * only, each word a prefix, all of them required; null when there are none.
 * Nothing the owner types reaches FTS5's own syntax. */
export function ftsQuery(text: string): string | null {
  const words = (text.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 10);
  return words.length ? words.map((w) => `"${w}"*`).join(" ") : null;
}

/** Search: the 50 best matches in the stored conversations, with where
 * each is. */
export function searchView(store: ConsoleStore, text: string) {
  const match = ftsQuery(text);
  return {
    results: (match ? store.search(match, 50) : []).map((h) => ({
      ...h,
      projectName: store.project(h.projectId)?.name ?? "",
      tabName: store.tab(h.tabId)?.name ?? "",
    })),
  };
}

/** An agent whose review a step waits for: any open Code analysis agent
 * but the Orchestrator, which plans. */
export const stepReviewer = (a: ConsoleAgent) => a.permission === "look" && isOpen(a) && !isOrchestrator(a);

function approvalView(store: ConsoleStore, agent: ConsoleAgent, diff: ReturnType<ConsoleStore["diff"]>) {
  // The head is the shown diff's, so Approve names the commit whose
  // changes the owner sees (read once, not again).
  const head = diff?.head ?? null;
  const approval = store.approval(agent.id);
  const name = (id: string | null) => (id ? (store.agent(id)?.name ?? null) : null);
  return {
    /** Only an editing agent's work is approved. */
    editing: agent.permission === "edit",
    head,
    current: approval && { ...approval, reviewerName: name(approval.reviewerId) },
    /** In a tab with steps and a reviewer, a step moves on only after an
     * approval that follows a review (`setStep`): the gate
     * offers no other kind there. */
    reviewNeeded: !!store.tabSteps(agent.tabId) && store.agents(agent.projectId).some((a) => a.tabId === agent.tabId && stepReviewer(a)),
    reviewers: store
      .agents(agent.projectId)
      // Where a step waits for a review, only the agents whose review counts.
      .filter((a) => a.tabId === agent.tabId && a.permission === "look" && a.state !== "closed" && (!store.tabSteps(agent.tabId) || stepReviewer(a)))
      .map((a) => ({ id: a.id, name: a.name, reviewed: !!head && store.reviewedAt(a.id, agent.id, head) !== null })),
  };
}

/** One agent's changes view: each turn's commit and the branch against its
 * base (without their patches, which the dialog asks for when one is
 * opened), and its latest push. */
export function changesView(store: ConsoleStore, agentId: string) {
  const agent = store.agent(agentId);
  if (!agent) return null;
  const project = store.project(agent.projectId);
  const diff = store.diff(agentId);
  return {
    agentId,
    source: project?.source ?? null,
    repo: project?.repo ?? null,
    baseBranch: project?.baseBranch ?? null,
    branch: store.agentBase(agentId).branch,
    folder: agent.folder,
    commits: store.commits(agentId),
    diff: diff && { base: diff.base, head: diff.head, stat: diff.stat, files: diff.files, updatedAt: diff.updatedAt },
    push: store.latestJob(agentId) ?? null,
    // The approve gate: its approval, and the tab's Code analysis agents with
    // whether each has reviewed the current head.
    approval: approvalView(store, agent, diff),
  };
}

/** The branch's whole patch in the changes view, asked for when it is
 * opened: "" before the agent has changed anything. */
export function branchPatchView(store: ConsoleStore, agentId: string): { patch: string } | null {
  return store.agent(agentId) ? { patch: store.diff(agentId)?.patch ?? "" } : null;
}

/** One commit's patch in the changes view, asked for when it is opened. */
export function commitPatchView(store: ConsoleStore, agentId: string, commitId: number): { patch: string } | null {
  const patch = Number.isSafeInteger(commitId) ? store.commitPatch(agentId, commitId) : null;
  return patch === null ? null : { patch };
}

/** The navigation tree: every project → tabs → agents by name, each with
 * its status. */
export function treeView(store: ConsoleStore): TreeProject[] {
  const open = store.openTurns();
  // Archived projects and closed tabs are hidden.
  return buildTree({
    projects: store.projects().filter((p) => p.archivedAt === null),
    tabs: store.allTabs().filter((t) => t.archivedAt === null),
    agents: store
      .agents()
      .filter((a) => a.state !== "closed")
      .map((a) => ({ id: a.id, tabId: a.tabId, name: a.name, status: agentStatus(a, currentTurn(open, a.id)) as TreeStatus, kind: a.kind })),
  });
}
