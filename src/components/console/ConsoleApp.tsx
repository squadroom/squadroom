"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FreshCode from "@/components/shared/FreshCode";
import { BUILT_IN_ROLES, type RoleDef } from "@/lib/console/roles";
import { gridShape } from "@/lib/console/transcript";
import { focusTarget, readCollapsed, toggle, writeCollapsed, type TreeProject } from "@/lib/console/tree";
import type { ConsoleProject } from "@/lib/console/types";
import { keepIfSame, needCount, pauseBanner, readAppearance, settingsFromHash, settingsHash, type Appearance, type SettingsSection } from "@/lib/console/ui";
import { pickProject, pickTab } from "@/lib/console/view-state";
import type { ProjectView, WorkerView, templatesView } from "@/lib/console/views";
import AgentWindow from "./AgentWindow";
import { useRenewHeldUploads } from "./useComposer";
import { useDialogFocus } from "./useDialogFocus";
import { api, recall, remember, useCodeConfirm, usePolled, type Run } from "./api";
import ChangesView from "./ChangesView";
import CleanupDialog from "./CleanupDialog";
import ConsoleModals, { type Modal } from "./ConsoleModals";
import FilePanel from "./FilePanel";
import Icon from "./Icon";
import KeysDialog from "./KeysDialog";
import { MenuButton } from "./Menu";
import { addMenu, projectMenu, tabMenu, type MenuContext } from "./menus";
import OverviewDialog from "./OverviewDialog";
import LogsDialog from "./LogsDialog";
import NavTree, { ArchivedList } from "./NavTree";
import NeedsTray, { NO_NEEDS, type Needs } from "./NeedsTray";
import RolesDialog from "./RolesDialog";
import SettingsView, { AppearancePanel, NotificationsPanel, TemplatesPanel } from "./SettingsView";
import TabStrip from "./TabStrip";
import TopBar from "./TopBar";
import TeamTimeline from "./TeamTimeline";
import { useEvents, useTree } from "./useEvents";
import { useNotifications } from "./useNotifications";
import styles from "./console.module.css";

// The Squadroom Console: projects, tabs, a grid of agent windows, the
// New agent dialog, live transcripts, and a composer with Send and Stop.
// Everything is a button, a menu or a text box. The phone gets the same
// page in one column. This file is the page shell; each part is its own file:
// the top bar, the tab strip, the menus, the dialogs and the Settings page
// among them.

const COLLAPSED_KEY = "console-tree-collapsed";
/** The sidebar folded away on this device. */
const SIDEBAR_KEY = "console-sidebar";
const APPEARANCE_KEY = "console-appearance";
/** The project and tab this device last had open, shown again on reload. */
const PROJECT_KEY = "console-project";
const TAB_KEY = "console-tab";

export default function ConsoleApp() {
  const [projects, setProjects] = useState<ConsoleProject[]>([]);
  const [worker, setWorker] = useState<WorkerView | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [view, setView] = useState<ProjectView | null>(null);
  const [tabId, setTabId] = useState<string | null>(null);
  const [maximized, setMaximized] = useState<string | null>(null);
  // Composers outlive their windows; their held files are renewed here.
  useRenewHeldUploads();
  /** The one dialog open. */
  const [modal, setModal] = useState<Modal | null>(null);
  /** Needs you's panel: open beside the windows. */
  const [needsOpen, setNeedsOpen] = useState(false);
  /** The Settings page: null when closed, "" for its cards, or a
   * section. It follows the address (#settings/keys), so Back works. */
  const [settings, setSettings] = useState<SettingsSection | "" | null>(null);
  useEffect(() => {
    const follow = () => setSettings(settingsFromHash(location.hash));
    const first = setTimeout(follow, 0);
    window.addEventListener("hashchange", follow);
    return () => {
      clearTimeout(first);
      window.removeEventListener("hashchange", follow);
    };
  }, []);
  const goSettings = (section: SettingsSection | "" | null) => {
    if (section === null) {
      if (location.hash) history.pushState(null, "", location.pathname + location.search);
      setSettings(null);
    } else location.hash = settingsHash(section);
  };
  /** A command that needs a fresh e-mail code: the dialog's
   * answer, while it is shown. */
  const codeAsk = useCodeConfirm();
  /** The role library. */
  const [roles, setRoles] = useState<RoleDef[]>(BUILT_IN_ROLES);
  const [templates, setTemplates] = useState<ReturnType<typeof templatesView>>([]);
  /** The project's menu: its name renamed in place, and the
   * tree's ⋯ asking for the menu (counted to repeat). */
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [projectMenuFor, setProjectMenuFor] = useState<{ id: string; n: number } | null>(null);
  const projectMenuAsks = useRef(0);
  /** The tab renamed in place. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [needs, setNeeds] = useState<Needs>(NO_NEEDS);
  const [needsLoaded, setNeedsLoaded] = useState(false);
  const notify = useNotifications(needs, needsLoaded);
  const [changesFor, setChangesFor] = useState<string | null>(null);
  /** The file panel. */
  const [file, setFile] = useState<{ agentId: string; path: string; n: number; helperId?: number } | null>(null);
  // Stable, so a window's file links stay memoized across polls.
  const openFile = useCallback((agentId: string, path: string) => setFile((f) => ({ agentId, path, n: (f?.n ?? 0) + 1 })), []);
  /** A helper's transcript, read by its id only. */
  const openHelper = (agentId: string, helperId: number, name: string) => setFile((f) => ({ agentId, path: name, helperId, n: (f?.n ?? 0) + 1 }));
  const [error, setError] = useState<string | null>(null);
  const [initialTree, setInitialTree] = useState<TreeProject[] | null>(null);
  const tree = useTree(initialTree);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState(false);
  /** The desktop sidebar folded away, remembered per device. */
  const [sidebarHidden, setSidebarHidden] = useState(false);
  /** Light, dark or the system's, remembered per device. */
  const [appearance, setAppearance] = useState<Appearance>("system");
  const [focus, setFocus] = useState<{ agentId: string; n: number } | null>(null);
  // What this device remembers: collapsed rows, the folded sidebar, the tab.
  useEffect(() => {
    const first = setTimeout(() => {
      setCollapsed(readCollapsed(recall(COLLAPSED_KEY)));
      setSidebarHidden(recall(SIDEBAR_KEY) === "hidden");
      setAppearance(readAppearance(recall(APPEARANCE_KEY)));
      setTabId((current) => current ?? recall(TAB_KEY));
    }, 0);
    return () => clearTimeout(first);
  }, []);
  const changeCollapsed = (next: Set<string>) => {
    setCollapsed(next);
    remember(COLLAPSED_KEY, writeCollapsed(next));
  };
  const foldSidebar = (hidden: boolean) => {
    setSidebarHidden(hidden);
    remember(SIDEBAR_KEY, hidden ? "hidden" : null);
  };

  // Polls can overlap: only the latest answer is applied, so Needs you
  // (and its notifications) never step back to an older one.
  const projectsAsked = useRef(0);
  /** The versions of the views this page has. */
  const listVersion = useRef<string | null>(null);
  const projectVersion = useRef<{ projectId: string; version: string | null } | null>(null);
  const loadProjects = useCallback(async () => {
    const asked = ++projectsAsked.current;
    try {
      const data = await api(undefined, listVersion.current ? `?version=${listVersion.current}` : "");
      if (asked !== projectsAsked.current) return;
      setWorker((w) => keepIfSame(w, data.worker));
      // Unchanged since the last answer: nothing to render.
      if (data.unchanged) return;
      listVersion.current = data.version ?? null;
      setProjects(data.projects);
      setNeeds(data.needs ?? NO_NEEDS);
      setNeedsLoaded(true);
      if (Array.isArray(data.roles)) setRoles(data.roles);
      if (Array.isArray(data.templates)) setTemplates(data.templates);
      if (data.tree) setInitialTree(data.tree);
      setProjectId((current) =>
        pickProject(
          // An archived project is never picked.
          data.projects.filter((p: ConsoleProject) => p.archivedAt === null).map((p: ConsoleProject) => p.id),
          current,
          recall(PROJECT_KEY),
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  // The selection now, so a slow answer for a project left meanwhile is dropped.
  const selected = useRef(projectId);
  useEffect(() => {
    selected.current = projectId;
  }, [projectId]);
  const loadProject = useCallback(async () => {
    if (!projectId) return setView(null);
    try {
      const known = projectVersion.current?.projectId === projectId ? projectVersion.current.version : null;
      const data = await api(undefined, `?project=${encodeURIComponent(projectId)}${known ? `&version=${known}` : ""}`);
      if (selected.current !== projectId) return;
      if (data.unchanged) return setWorker((w) => keepIfSame(w, data.worker));
      if (data.project?.id !== projectId) return;
      projectVersion.current = { projectId, version: data.version ?? null };
      setView({ project: data.project, tabs: data.tabs, closedTabs: data.closedTabs ?? [], agents: data.agents, codexRunning: data.codexRunning ?? 0 });
      setWorker((w) => keepIfSame(w, data.worker));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  // Polling (the live stream also asks for a refresh whenever a turn
  // changes state).
  usePolled(loadProjects, 5_000);
  usePolled(loadProject, 4_000);
  useEffect(() => {
    // Never forgotten while nothing is chosen yet: the first render (no
    // project) used to erase it before the list loaded.
    if (projectId) remember(PROJECT_KEY, projectId);
  }, [projectId]);

  const events = useEvents(projectId, loadProject);
  // The chosen tab while it exists in this project, otherwise the first.
  const activeTab = view ? pickTab(view.tabs.map((t) => t.id), tabId) : null;
  // Remembered only once the shown view is the chosen project's: while
  // another project loads, the old view would fall back to its first tab.
  const viewProject = view?.project.id ?? null;
  useEffect(() => {
    if (activeTab && viewProject === projectId) remember(TAB_KEY, activeTab);
  }, [activeTab, viewProject, projectId]);
  const agents = useMemo(() => (view?.agents ?? []).filter((a) => a.tabId === activeTab), [view, activeTab]);
  // A maximized window that is gone (closed, another tab) shows them all again.
  const shown = maximized && agents.some((a) => a.id === maximized) ? agents.filter((a) => a.id === maximized) : agents;

  /** Show an agent (Needs you's, Search's and the Overview's Show): open its
   * project and tab, scroll to its window, highlight it and put the cursor
   * in its composer. False when it has no window to show. */
  const canShow = (agentId: string) => !!tree && focusTarget(tree, agentId, collapsed) !== null;
  const openAgent = (agentId: string): boolean => {
    const target = tree && focusTarget(tree, agentId, collapsed);
    if (!target) return false;
    changeCollapsed(target.collapsed);
    setProjectId(target.projectId);
    setTabId(target.tabId);
    setMaximized((m) => (m && m !== agentId ? null : m));
    setFocus((f) => ({ agentId, n: (f?.n ?? 0) + 1 }));
    setDrawer(false);
    goSettings(null);
    return true;
  };
  const openTab = (projectId: string, tab: string) => {
    setProjectId(projectId);
    setTabId(tab);
    setMaximized(null);
    setDrawer(false);
    goSettings(null);
  };
  const selectProject = (id: string) => {
    setProjectId(id);
    setMaximized(null);
    goSettings(null);
  };
  // The focus happens once its window is on the page (after a project or
  // tab change has loaded).
  const focused = useRef(0);
  useEffect(() => {
    if (!focus || focused.current === focus.n) return;
    const el = document.querySelector<HTMLElement>(`[data-agent-window="${focus.agentId}"]`);
    if (!el) return;
    focused.current = focus.n;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.classList.add(styles.focused);
    setTimeout(() => el.classList.remove(styles.focused), 1600);
    el.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
  }, [focus, view, activeTab]);

  /** ⋯ on a project's row: the project, with its menu open. */
  const openProjectMenu = (id: string) => {
    setDrawer(false);
    goSettings(null);
    if (id !== projectId) {
      setProjectId(id);
      setMaximized(null);
    }
    // Counted across clears, so each ask is new to the menu button.
    setProjectMenuFor({ id, n: ++projectMenuAsks.current });
  };

  const run: Run = async (body) => {
    try {
      const data = await api(body);
      setError(null);
      await loadProject();
      return data;
    } catch (e) {
      if ((e as Error).name !== "Cancelled") setError((e as Error).message);
      return null;
    }
  };
  /** A command that changes the project list, Needs you or the roles. */
  const runAndList: Run = async (body) => {
    const data = await run(body);
    await loadProjects();
    return data;
  };
  const restoreProject = async (id: string) => {
    if (!(await run({ action: "restore", scope: "project", id }))) return;
    await loadProjects();
    setProjectId(id);
  };

  const logo = (
    <strong className={styles.logo}>
      <span aria-hidden="true">
        <Icon name="console" size={12} />
      </span>
      Squadroom
    </strong>
  );
  // The sidebar's contents, also shown in the phone's drawer.
  const navigation = (
    <>
      <button
        className={styles.newProject}
        onClick={() => {
          setDrawer(false);
          setModal({ kind: "project" });
        }}
      >
        <Icon name="plus" size={14} /> New project
      </button>
      <p className={styles.navLabel}>Projects</p>
      <NavTree
        tree={tree}
        collapsed={collapsed}
        projectId={projectId}
        tabId={activeTab}
        agentId={focus?.agentId ?? null}
        onToggle={(key) => changeCollapsed(toggle(collapsed, key))}
        onProject={(id) => {
          selectProject(id);
          setDrawer(false);
        }}
        onTab={openTab}
        onAgent={openAgent}
        onProjectMenu={openProjectMenu}
      />
      <ArchivedList projects={projects} run={restoreProject} />
    </>
  );
  const tab = view?.tabs.find((t) => t.id === activeTab);
  const banner = view && pauseBanner(worker?.pausedAll, view.project, tab);
  const withFiles = view?.project.source !== "none";
  const menus: MenuContext = {
    view,
    projects,
    templates,
    activeTab,
    withFiles,
    open: setModal,
    run,
    renameTab: setRenaming,
    renameProject: setRenamingProject,
    selectProject,
  };
  // Each Settings section's screen, by its address (#settings/keys).
  const settingsSection = {
    "": null,
    overview: <OverviewDialog onShow={(agentId) => void openAgent(agentId)} run={run} />,
    keys: <KeysDialog run={run} />,
    roles: <RolesDialog roles={roles} run={runAndList} />,
    templates: (
      <TemplatesPanel
        templates={templates}
        onUse={view && withFiles ? (id) => (goSettings(null), setModal({ kind: "newTab", template: id })) : null}
        run={runAndList}
      />
    ),
    notifications: (
      <NotificationsPanel
        state={notify.state}
        toggle={notify.toggle}
        needsMail={worker?.needsMail ?? null}
        setNeedsMail={(on) => void runAndList({ action: "setNeedsMail", on })}
      />
    ),
    appearance: (
      <AppearancePanel
        value={appearance}
        onChange={(next) => {
          setAppearance(next);
          remember(APPEARANCE_KEY, next === "system" ? null : next);
        }}
      />
    ),
    logs: <LogsDialog />,
    cleanup: <CleanupDialog />,
  }[settings ?? ""];

  return (
    <div className={styles.console} data-appearance={appearance === "system" ? undefined : appearance}>
      <aside className={styles.sidebar} hidden={sidebarHidden}>
        <div className={styles.brand}>
          {logo}
          <span className={styles.brandEnd}>
            <button className={styles.iconButton} onClick={() => foldSidebar(true)} aria-label="Hide the sidebar" title="Hide the sidebar">
              <Icon name="sidebar" />
            </button>
          </span>
        </div>
        {navigation}
      </aside>
      {drawer && (
        <Drawer onClose={() => setDrawer(false)}>
          <div className={styles.brand}>
            {logo}
            <button className={styles.iconButton} onClick={() => setDrawer(false)} aria-label="Close" title="Close (Esc)">
              <Icon name="close" />
            </button>
          </div>
          {navigation}
        </Drawer>
      )}

      <main className={styles.main}>
        <TopBar
          project={
            view && {
              name: view.project.name,
              signal: projectMenuFor?.id === view.project.id ? projectMenuFor.n : 0,
              renaming: renamingProject === view.project.id,
            }
          }
          projectItems={() => (view ? projectMenu(view.project, menus) : [])}
          onProjectMenuOpened={() => setProjectMenuFor(null)}
          onProjectRenamed={(name) => {
            setRenamingProject(null);
            if (name && view) void runAndList({ action: "rename", target: "project", id: view.project.id, name });
          }}
          onDrawer={() => setDrawer(true)}
          onShowSidebar={sidebarHidden ? () => foldSidebar(false) : null}
          needs={needCount(needs)}
          needsOpen={needsOpen}
          onNeeds={() => setNeedsOpen((open) => !open)}
          worker={worker}
          run={run}
          onSearch={(words) => setModal({ kind: "search", words })}
          settingsOpen={settings !== null}
          onSettings={() =>
            // Wide screens open the first section beside the list, as ChatGPT
            // and Claude do; the phone opens the list.
            goSettings(settings !== null ? null : matchMedia("(min-width: 761px)").matches ? "overview" : "")
          }
        />
        {worker?.claudePausedUntil && (
          <p className={styles.notice}>
            The Claude account reached its usage limit; its queued turns wait until{" "}
            {new Date(worker.claudePausedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
          </p>
        )}

        {error && (
          <div className={styles.error} role="alert">
            <span>{error}</span>
            <button className={styles.iconButton} onClick={() => setError(null)} aria-label="Dismiss" title="Dismiss">
              <Icon name="close" />
            </button>
          </div>
        )}

        {settings !== null && (
          <SettingsView section={settings} onClose={() => goSettings(null)}>
            {settingsSection}
          </SettingsView>
        )}
        {settings === null && !view && (
          <div className={styles.empty}>
            <span className={styles.emptyIcon} aria-hidden="true">
              <Icon name="console" size={20} />
            </span>
            <h2>{projects.some((p) => p.archivedAt !== null) ? "No open project" : "Start with a project"}</h2>
            <p>
              {projects.some((p) => p.archivedAt !== null)
                ? "Archived projects are listed in the sidebar, each with Restore."
                : "A project is where agents work: a GitHub repository, a new folder, or just conversation. It holds tabs, and each tab holds agent windows."}
            </p>
            <button className={styles.primary} onClick={() => setModal({ kind: "project" })}>
              Create a project
            </button>
          </div>
        )}
        {/* Hidden, not removed, under Settings: the windows keep their
            drafts, uploads and scroll position. */}
        {view && (
          <div className={styles.projectView} hidden={settings !== null}>
            {view.project.source === "github" && (
              <p className={view.project.state === "error" ? styles.errorBanner : styles.repoLine}>
                {view.project.repo} · base {view.project.baseBranch}
                {view.project.state === "preparing" && " · checking the repository and its base branch…"}
                {view.project.state === "error" && ` · ${view.project.error}`}
              </p>
            )}
            <TabStrip
              tabs={view.tabs}
              active={activeTab}
              onSelect={(id) => {
                setTabId(id);
                setMaximized(null);
              }}
              onNewTab={() => setModal({ kind: "newTab" })}
              menuItems={(t) => tabMenu(t, menus)}
              renaming={renaming}
              onRenameStart={setRenaming}
              onRenamed={(id, name) => {
                setRenaming(null);
                if (name) void run({ action: "rename", target: "tab", id, name });
              }}
            >
              <MenuButton className={`${styles.primary} ${styles.addButton}`} label="Add" items={addMenu({ activeTab, withFiles, templates, open: setModal })}>
                <Icon name="plus" size={14} />
                Add
                <Icon name="chevron" size={14} />
              </MenuButton>
            </TabStrip>
            {banner && (
              <p className={styles.notice}>
                <Icon name="pause" size={14} />
                <span>
                  Paused: {banner.text} {banner.spend ? "Queued messages and turns wait." : "Queued messages and turns wait for Resume."}
                </span>
                <button
                  onClick={() => void run(banner.body)}
                  title={banner.spend ? "Count this tab's spend from zero again (needs a fresh code)" : undefined}
                >
                  {banner.button}
                </button>
              </p>
            )}
            {tab && (
              <TeamTimeline
                tab={tab}
                members={agents.filter((a) => a.state !== "closed" && a.state !== "error").map((a) => ({ id: a.id, name: a.name }))}
                run={run}
              />
            )}
            {agents.length === 0 ? (
              <div className={styles.empty}>
                <span className={styles.emptyIcon} aria-hidden="true">
                  <Icon name="agent" size={20} />
                </span>
                <h2>This tab has no agents yet</h2>
                <p>
                  An agent is one AI assistant, such as Claude Code or Codex, working in its own window: you send it messages and watch it work. A team is an
                  Orchestrator with members it hands work to. Use <b>Add</b> at the top right, or start here.
                </p>
                <div className={styles.emptyButtons}>
                  <button onClick={() => setModal({ kind: "agent" })} disabled={!activeTab}>
                    Add an agent
                  </button>
                  {view.project.source !== "none" && (
                    <button onClick={() => setModal({ kind: "team" })} disabled={!activeTab}>
                      Set up a team
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className={`${styles.grid} ${styles[gridShape(shown.length)]}`}>
                {shown.map((a) => (
                  <AgentWindow
                    key={a.id}
                    agent={a}
                    // Codex windows share one App Server (worker-wide, every
                    // project), which Force stop ends: the other running Codex
                    // windows are counted in the confirmation.
                    otherCodexRunning={
                      // Only a running or waiting turn reaches the server: a
                      // queued message is withdrawn without touching it.
                      a.kind === "codex" && (a.status === "working" || a.status === "needs_you") ? Math.max(0, view.codexRunning - 1) : 0
                    }
                    events={events.get(a.id) ?? []}
                    maximized={maximized === a.id}
                    onMaximize={() => setMaximized(maximized === a.id ? null : a.id)}
                    onChanges={() => setChangesFor(a.id)}
                    onOpenFile={openFile}
                    onOpenHelper={(helperId, name) => openHelper(a.id, helperId, name)}
                    run={run}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {needsOpen && (
        <NeedsTray
          needs={needs}
          projects={projects}
          onClose={() => setNeedsOpen(false)}
          canShow={canShow}
          onShow={(agentId) => {
            // Beside the windows it stays open; the phone has room for one.
            if (openAgent(agentId) && matchMedia("(max-width: 760px)").matches) setNeedsOpen(false);
          }}
          run={runAndList}
        />
      )}
      <ConsoleModals
        modal={modal}
        setModal={setModal}
        view={view}
        worker={worker}
        roles={roles}
        templates={templates}
        activeTab={activeTab}
        takenNames={agents.map((a) => a.name)}
        run={run}
        runAndList={runAndList}
        loadProjects={loadProjects}
        onProjectCreated={setProjectId}
        onTabCreated={setTabId}
        canShow={canShow}
        openAgent={openAgent}
      />
      {changesFor && (
        <ChangesView agentId={changesFor} onClose={() => setChangesFor(null)} run={run} onOpenFile={(path) => openFile(changesFor, path)} />
      )}
      {file && (
        <FilePanel
          key={file.n}
          agentId={file.agentId}
          path={file.path}
          helperId={file.helperId}
          folder={view?.agents.find((a) => a.id === file.agentId)?.folder ?? ""}
          onOpen={(path) => openFile(file.agentId, path)}
          onClose={() => setFile(null)}
        />
      )}
      {/* Last, on a layer of its own above every dialog, tray and panel: the
          confirmation a weighty command asks for. A new code is e-mailed as
          it opens, so the newest one is the one to type. */}
      {codeAsk && (
        <div className={`${styles.overlay} ${styles.codeOverlay}`}>
          <FreshCode
            className={styles.dialog}
            sendOnOpen
            title="Confirm with a code"
            text="This action needs a code from your e-mail. One code covers such actions on this device for 8 hours. A new code is on its way to your address."
            done={codeAsk.done}
          />
        </div>
      )}
    </div>
  );
}

/** The phone's drawer of projects and agents: a dialog, so focus moves in,
 * stays inside and comes back, and Escape closes it. */
function Drawer({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const { box, onKeyDown } = useDialogFocus(onClose);
  return (
    <div className={styles.drawerOverlay} onClick={onClose} onKeyDown={onKeyDown}>
      <div ref={box} tabIndex={-1} className={styles.drawer} role="dialog" aria-modal="true" aria-label="Projects and agents" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
