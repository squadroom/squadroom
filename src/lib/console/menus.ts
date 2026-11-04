import type { Run } from "../../components/console/api.ts";
import type { Modal } from "../../components/console/ConsoleModals.tsx";
import type { MenuItem } from "../../components/console/Menu.tsx";
import { SPEND_PAUSE, type ConsoleProject } from "./types.ts";
import { money, projectPlace } from "./ui.ts";
import type { ProjectView, templatesView } from "./views.ts";

// The page's menus: a tab's, the project's and Add, each item once. Built
// from what the page shows; each opens a dialog, starts a rename or runs a
// command. Pure (the page's types only), so they are tested.

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
  return [
    { label: "Rename", hint: "Or double-click the tab", onSelect: () => renameTab(t.id) },
    { label: "Spend limit…", hint: `${money(t.spend.usd)} of ${money(t.spend.limitUsd)} spent on API keys`, onSelect: () => open({ kind: "spend", tabId: t.id }) },
    ...(t.steps ? [{ label: "Steps…", hint: `Step ${t.steps.index + 1} of ${t.steps.steps.length}`, onSelect: () => open({ kind: "steps", tabId: t.id }) }] : []),
    t.paused
      ? t.pauseReason?.startsWith(SPEND_PAUSE)
        ? { label: "Reset spend", hint: "Count its spend from zero again (needs a fresh code)", onSelect: () => void run({ action: "resetSpend", tabId: t.id }) }
        : { label: "Resume tab", onSelect: () => void run({ action: "resume", scope: "tab", id: t.id }) }
      : { label: "Pause tab…", onSelect: () => open({ kind: "pause", scope: "tab", id: t.id, name: t.name }) },
    { label: "Run report…", hint: "The tab's run as one document", onSelect: () => open({ kind: "report", tabId: t.id }) },
    { label: "Save as template…", hint: "Its agents, roles and routes, for a new tab", onSelect: () => open({ kind: "template", tabId: t.id }) },
    ...(view?.closedTabs.length
      ? [{ label: "Closed tabs…", hint: `${view.closedTabs.length} closed`, onSelect: () => open({ kind: "closed", projectId: view.project.id }) }]
      : []),
    {
      label: "Close tab…",
      danger: true,
      disabled: view?.tabs.length === 1,
      hint: view?.tabs.length === 1 ? "A project keeps one open tab" : undefined,
      onSelect: () => open({ kind: "archive", scope: "tab", id: t.id }),
    },
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
        icon: p.id === project.id ? ("check" as const) : ("blank" as const),
        // Where its agents work: fixed for the project.
        hint: p.id === project.id ? `Open now · ${projectPlace(p)}` : undefined,
        onSelect: () => selectProject(p.id),
      })),
    { label: "New project…", icon: "plus", onSelect: () => open({ kind: "project" }) },
    { label: "Rename", separated: true, onSelect: () => renameProject(project.id) },
    project.paused
      ? { label: "Resume project", onSelect: () => void run({ action: "resume", scope: "project", id: project.id }) }
      : { label: "Pause project…", onSelect: () => open({ kind: "pause", scope: "project", id: project.id, name: project.name }) },
    {
      label: "Network…",
      hint: `ACP agents ${project.acpNetwork ? "may use" : "may not use"} the network; project-wide rules`,
      onSelect: () => open({ kind: "network", projectId: project.id }),
    },
    // Image tools make paid calls, so turning them on needs a fresh code;
    // agents see the change at their next session.
    {
      label: project.imageTools ? "Turn image tools off" : "Turn image tools on",
      hint: `${project.imageTools ? "On" : "Off"}: Claude Code at Code edit makes images with the Krea key, charged to the tab. Reaches agents at their next session`,
      icon: project.imageTools ? ("check" as const) : ("blank" as const),
      onSelect: () => void run({ action: "setImageTools", projectId: project.id, on: !project.imageTools }),
    },
    {
      label: "Closed tabs…",
      hint: view?.closedTabs.length ? `${view.closedTabs.length} closed` : "None",
      disabled: !view?.closedTabs.length,
      onSelect: () => open({ kind: "closed", projectId: project.id }),
    },
    ...(project.source === "github" && project.repo
      ? [{ label: "Open on GitHub", hint: project.repo, icon: "external" as const, onSelect: () => void window.open(`https://github.com/${project.repo}`, "_blank", "noopener,noreferrer") }]
      : []),
    ...(project.source !== "none"
      ? [{ label: "Folders…", hint: "Where each agent's copy is on this Mac", icon: "folder" as const, onSelect: () => open({ kind: "folders", projectId: project.id }) }]
      : []),
    { label: "Archive project…", hint: "Closes its agents; Restore brings it back", danger: true, onSelect: () => open({ kind: "archive", scope: "project", id: project.id }) },
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
