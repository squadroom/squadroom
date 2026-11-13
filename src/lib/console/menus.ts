import type { Run } from "../../components/console/api.ts";
import type { Modal } from "../../components/console/ConsoleModals.tsx";
import type { MenuItem } from "../../components/console/Menu.tsx";
import { AGENT_KINDS, networkAutoKind } from "./agents.ts";
import type { ConsoleCommand } from "./commands.ts";
import { SPEND_PAUSE, type ConsoleProject } from "./types.ts";
import { money, plural, projectPlace, turnLimitsHint } from "./ui.ts";
import type { AgentView, ProjectView, templatesView } from "./views.ts";

// The page's menus: a tab's, an agent window's and its model chip's, the
// project's and Add, each item once. Built from what the page shows. A row
// is one line: an icon, a name, and its current value or an on/off switch
// at the right; what it does is in its hover text. Groups have a line
// between them. Pure (the page's types only), so they are tested.

export interface MenuContext {
  view: ProjectView | null;
  projects: ConsoleProject[];
  templates: ReturnType<typeof templatesView>;
  activeTab: string | null;
  withFiles: boolean;
  open: (modal: Modal) => void;
  run: Run;
  renameTab: (id: string) => void;
  renameProject: (id: string) => void;
  selectProject: (id: string) => void;
}

/** A tab's menu: everything a tab offers, each once. */
export function tabMenu(t: ProjectView["tabs"][number], { view, open, run, renameTab }: MenuContext): MenuItem[] {
  // Its agents that have the Network setting, switched together.
  const network = (view?.agents ?? []).filter((a) => a.tabId === t.id && networkAutoKind(a.kind));
  const auto = network.filter((a) => a.networkAuto).length;
  const all = auto === network.length;
  const only = view?.tabs.length === 1;
  return [
    { label: "Rename", icon: "rename", title: "Or double-click the tab", onSelect: () => renameTab(t.id) },
    t.paused
      ? t.pauseReason?.startsWith(SPEND_PAUSE)
        ? { label: "Reset spend", icon: "play", title: "Counts its spend from zero again (needs a fresh code)", onSelect: () => void run({ action: "resetSpend", tabId: t.id }) }
        : { label: "Resume tab", icon: "play", onSelect: () => void run({ action: "resume", scope: "tab", id: t.id }) }
      : { label: "Pause tab…", icon: "pause", onSelect: () => open({ kind: "pause", scope: "tab", id: t.id, name: t.name }) },
    {
      label: "Spend limit…",
      icon: "spend",
      value: t.spend.limitUsd === null ? money(t.spend.usd) : `${money(t.spend.usd)} of ${money(t.spend.limitUsd)}`,
      title: t.spend.limitUsd === null ? "Spent on API keys; no limit set" : "Spent on API keys, of its limit",
      separated: true,
      onSelect: () => open({ kind: "spend", tabId: t.id }),
    },
    { label: "Turn limits…", icon: "clock", value: turnLimitsHint(t).replace(" per message", "").replace(", ", " · "), title: `${turnLimitsHint(t)}`, onSelect: () => open({ kind: "turns", tabId: t.id }) },
    ...(t.steps ? [{ label: "Steps…", icon: "steps" as const, value: `${t.steps.index + 1} of ${t.steps.steps.length}`, onSelect: () => open({ kind: "steps", tabId: t.id }) }] : []),
    ...(network.length
      ? [
          {
            label: "Network auto",
            icon: "globe" as const,
            // Some on, some not: the switch is off and says how many.
            value: all || !auto ? undefined : `${auto} of ${network.length}`,
            checked: all,
            title: all
              ? "On for all its agents. Off: each website waits for you in Needs you again"
              : "On: all its agents reach any website without asking (needs a fresh code)",
            onSelect: () => void run({ action: "setNetwork", tabId: t.id, auto: !all }),
          },
        ]
      : []),
    { label: "Run report…", icon: "report", title: "The tab's run as one document", separated: true, onSelect: () => open({ kind: "report", tabId: t.id }) },
    { label: "Save as template…", icon: "templates", title: "Its agents, roles and routes, for a new tab", onSelect: () => open({ kind: "template", tabId: t.id }) },
    ...(view?.closedTabs.length
      ? [{ label: "Closed tabs…", icon: "archive" as const, value: String(view.closedTabs.length), onSelect: () => open({ kind: "closed", projectId: view.project.id }) }]
      : []),
    {
      label: "Close tab…",
      icon: "close",
      danger: true,
      separated: true,
      disabled: only,
      title: only ? "A project keeps one open tab" : undefined,
      onSelect: () => open({ kind: "archive", scope: "tab", id: t.id }),
    },
  ];
}

/** What an agent window's menu needs from the window. */
export interface AgentMenuContext {
  otherCodexRunning: number;
  /** A turn is running, queued or waiting for the owner. */
  busy: boolean;
  /** A turn is running or waiting for the owner (a queued one is not). */
  turning: boolean;
  run: Run;
  /** A command sent once the owner confirms it. */
  confirmed: (question: string, body: ConsoleCommand) => () => void;
  freshWithSummary: () => void;
  onChanges: () => void;
  onFiles: () => void;
  onRename: () => void;
}

/** An agent window's menu: what it made, its settings, its
 * conversation, then stopping and closing it. Its model is the chip in its
 * header (`modelMenu`). */
export function agentMenu(
  agent: AgentView,
  { otherCodexRunning, busy, turning, run, confirmed, freshWithSummary, onChanges, onFiles, onRename }: AgentMenuContext,
): MenuItem[] {
  return [
    { label: "Changes", icon: "changes", title: "Its commits and changed files", onSelect: onChanges },
    { label: "Files", icon: "folder", title: "Read its documents and other files", disabled: !agent.folder, onSelect: onFiles },
    { label: "Rename", icon: "rename", title: "Or double-click its name", separated: true, onSelect: onRename },
    ...(agent.kind === "claude-code" || agent.askFirst
      ? [
          {
            label: "Ask me first",
            icon: "shield" as const,
            checked: agent.askFirst,
            title: "On: its changes, commands and web access wait for you in Needs you",
            onSelect: () => void run({ action: "setAskFirst", agentId: agent.id, on: !agent.askFirst }),
          },
        ]
      : []),
    {
      label: "Forget its Always rules",
      icon: "undo",
      title: "Requests you allowed with Always are asked again",
      onSelect: confirmed(`Forget every "Always for this agent" rule of ${agent.name}? It will ask again.`, { action: "forgetRules", agentId: agent.id }),
    },
    {
      label: "Start fresh",
      icon: "fresh",
      title: "A new conversation; its folder and branch stay",
      separated: true,
      // A queued message may start fresh; a running turn may not.
      disabled: turning,
      onSelect: confirmed(`Start ${agent.name} fresh? Its next message begins a new conversation; its folder and branch stay as they are.`, {
        action: "fresh",
        agentId: agent.id,
      }),
    },
    {
      label: "Fresh session with summary",
      icon: "summary",
      title: "Costs one turn: it writes a summary, then starts a new conversation with it",
      disabled: turning || agent.summaryWaiting,
      onSelect: freshWithSummary,
    },
    // Stopping shows only while there is a turn to stop.
    ...(busy
      ? [
          { label: "Stop", icon: "stop" as const, title: "Ends its turn", separated: true, onSelect: () => void run({ action: "stop", agentId: agent.id }) },
          {
            label: "Force stop",
            icon: "forceStop" as const,
            title: otherCodexRunning > 0 ? `Ends the turn at once. Also stops ${plural(otherCodexRunning, "other Codex window")}` : "Ends the turn at once",
            danger: true,
            onSelect: confirmed(
              `Force stop ${agent.name}?${
                otherCodexRunning > 0
                  ? ` Codex windows share one server, so this also stops ${plural(otherCodexRunning, "other running Codex window")}; their messages go to Needs you for a Re-send.`
                  : ""
              }`,
              { action: "stop", agentId: agent.id, force: true },
            ),
          },
        ]
      : []),
    {
      label: "Close",
      icon: "close",
      title: "Its folder stays on the Mac",
      danger: true,
      separated: !busy,
      onSelect: confirmed(`Close ${agent.name}? Its folder stays on the Mac.`, { action: "close", agentId: agent.id }),
    },
  ];
}

const capital = (s: string) => (s === "xhigh" ? "Extra high" : s[0].toUpperCase() + s.slice(1));

/** An agent's model and thinking level, from the chip in its window's
 * header: its kind stays, it keeps its conversation, and a choice is saved
 * at once and closes the menu. A new model starts at its default thinking
 * level. */
export function modelMenu(agent: AgentView, run: Run): MenuItem[] {
  const models = AGENT_KINDS.find((k) => k.kind === agent.kind)?.models ?? [];
  const efforts = models.find((m) => m.id === agent.model)?.efforts ?? [];
  const effort = agent.effort ?? "default";
  // The current choice does nothing: its model keeps its thinking level.
  const set = (model: string, level: string) => () => {
    if (model !== agent.model || level !== effort) void run({ action: "setAi", agentId: agent.id, model, effort: level });
  };
  return [
    ...models.map((m, i) => ({
      label: m.label,
      heading: i ? undefined : "Model",
      selected: m.id === agent.model,
      onSelect: set(m.id, m.id === agent.model ? effort : "default"),
    })),
    ...(efforts.length
      ? ["default", ...efforts].map((e, i) => ({ label: capital(e), heading: i ? undefined : "Thinking", selected: e === effort, onSelect: set(agent.model, e) }))
      : []),
  ];
}

/** The project's menu: switching projects and the project's settings, each once. */
export function projectMenu(project: ConsoleProject, { view, projects, open, run, renameProject, selectProject }: MenuContext): MenuItem[] {
  return [
    // Switching, as many web apps' top-left menu does.
    ...projects
      .filter((p) => p.archivedAt === null)
      .map((p) => ({
        label: p.name,
        selected: p.id === project.id,
        // Where its agents work: fixed for the project.
        title: projectPlace(p),
        onSelect: () => selectProject(p.id),
      })),
    { label: "New project…", icon: "plus", onSelect: () => open({ kind: "project" }) },
    { label: "Rename", icon: "rename", separated: true, onSelect: () => renameProject(project.id) },
    project.paused
      ? { label: "Resume project", icon: "play", onSelect: () => void run({ action: "resume", scope: "project", id: project.id }) }
      : { label: "Pause project…", icon: "pause", onSelect: () => open({ kind: "pause", scope: "project", id: project.id, name: project.name }) },
    {
      label: "Network…",
      icon: "globe",
      title: `ACP agents ${project.acpNetwork ? "may use" : "may not use"} the network; project-wide rules`,
      separated: true,
      onSelect: () => open({ kind: "network", projectId: project.id }),
    },
    // Image tools make paid calls, so turning them on needs a fresh code;
    // agents see the change at their next session.
    {
      label: "Image tools",
      icon: "image",
      checked: project.imageTools,
      title: "On: Claude Code at Code edit makes images with the Krea key, charged to the tab (needs a fresh code). Reaches agents at their next session",
      onSelect: () => void run({ action: "setImageTools", projectId: project.id, on: !project.imageTools }),
    },
    ...(project.source !== "none"
      ? [{ label: "Folders…", icon: "folder" as const, title: "Where each agent's copy is on this Mac", separated: true, onSelect: () => open({ kind: "folders", projectId: project.id }) }]
      : []),
    ...(project.source === "github" && project.repo
      ? [{ label: "Open on GitHub", icon: "external" as const, title: project.repo, onSelect: () => void window.open(`https://github.com/${project.repo}`, "_blank", "noopener,noreferrer") }]
      : []),
    {
      label: "Closed tabs…",
      icon: "archive",
      value: view?.closedTabs.length ? String(view.closedTabs.length) : undefined,
      separated: project.source === "none",
      disabled: !view?.closedTabs.length,
      onSelect: () => open({ kind: "closed", projectId: project.id }),
    },
    { label: "Archive project…", icon: "close", title: "Closes its agents; Restore brings it back", danger: true, separated: true, onSelect: () => open({ kind: "archive", scope: "project", id: project.id }) },
  ];
}

/** Add: the one primary action, for the current tab. */
export function addMenu({ activeTab, withFiles, templates, open }: Pick<MenuContext, "activeTab" | "withFiles" | "templates" | "open">): MenuItem[] {
  const needsFiles = "Needs a project with files";
  return [
    { label: "Agent", hint: "One AI assistant in its own window", icon: "agent", disabled: !activeTab, onSelect: () => open({ kind: "agent" }) },
    {
      label: "Team",
      hint: withFiles ? "An Orchestrator and the members it hands work to" : needsFiles,
      icon: "roles",
      disabled: !activeTab || !withFiles,
      onSelect: () => open({ kind: "team" }),
    },
    {
      label: "From a template",
      hint: withFiles ? "A new tab set up from Document review or a saved team" : needsFiles,
      icon: "templates",
      disabled: !withFiles || !templates.length,
      onSelect: () => open({ kind: "newTab", template: templates[0].id }),
    },
  ];
}
