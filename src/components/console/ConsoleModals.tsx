"use client";

import type { RoleDef } from "@/lib/console/roles";
import type { Proposal } from "@/lib/console/team-setup";
import type { ProjectView, WorkerView, templatesView } from "@/lib/console/views";
import type { Run } from "./api";
import NewAgent from "./NewAgent";
import { NewProject, NewTab } from "./NewProject";
import ReportDialog from "./ReportDialog";
import SearchDialog from "./SearchDialog";
import { ArchiveDialog, ClosedTabsDialog, FoldersDialog, NetworkDialog, PauseDialog, SaveTemplateDialog, SpendLimitDialog, StepsDialog, TurnLimitsDialog } from "./Settings";
import TeamSetupDialog from "./TeamSetupDialog";

// The Console page's dialogs: which one is open, and each one's props.

/** The page's dialogs, at most one open at a time. Changes, the
 * file panel and Needs you are not among them: they open beside a dialog. */
export type Modal =
  | { kind: "project" | "agent" | "team" }
  /** A tab an agent proposed, opened from Needs you to change its team
   * before creating it. */
  | { kind: "proposal"; noticeId: number; proposal: Proposal }
  /** New tab: empty (+), or with a template chosen first (Add, or Use in
   * Settings › Templates). */
  | { kind: "newTab"; template?: string }
  /** Search, with its words. */
  | { kind: "search"; words: string }
  /** A tab's run report, from its menu. */
  | { kind: "report"; tabId: string }
  /** Pause: which scope the owner is pausing. */
  | { kind: "pause"; scope: "tab" | "project" | "all"; id: string | null; name: string }
  /** The project's small dialogs, from its menu. */
  | { kind: "network" | "closed" | "folders"; projectId: string }
  /** A tab's small dialogs, from its menu. */
  | { kind: "spend" | "turns" | "steps" | "template"; tabId: string }
  /** Archive a project or close a tab: the confirmation shown. */
  | { kind: "archive"; scope: "project" | "tab"; id: string };

export default function ConsoleModals({
  modal,
  setModal,
  view,
  worker,
  roles,
  templates,
  activeTab,
  takenNames,
  run,
  runAndList,
  loadProjects,
  onProjectCreated,
  onTabCreated,
  canShow,
  openAgent,
}: {
  modal: Modal | null;
  setModal: (modal: Modal | null) => void;
  view: ProjectView | null;
  worker: WorkerView | null;
  roles: RoleDef[];
  templates: ReturnType<typeof templatesView>;
  activeTab: string | null;
  /** The current tab's agents' names. */
  takenNames: string[];
  run: Run;
  runAndList: Run;
  loadProjects: () => Promise<void>;
  onProjectCreated: (id: string) => void;
  onTabCreated: (id: string) => void;
  canShow: (agentId: string) => boolean;
  openAgent: (agentId: string) => boolean;
}) {
  const close = () => setModal(null);
  const m = modal;
  // A tab's dialog, while its tab is open.
  const tab = m && (m.kind === "spend" || m.kind === "turns" || m.kind === "steps" || m.kind === "template") ? view?.tabs.find((x) => x.id === m.tabId) : undefined;
  return (
    <>
      {m?.kind === "project" && (
        <NewProject
          onClose={close}
          onCreate={async (fields) => {
            const data = (await run({ action: "createProject", ...fields })) as { project: { id: string } } | null;
            if (!data) return;
            close();
            await loadProjects();
            onProjectCreated(data.project.id);
          }}
        />
      )}
      {m?.kind === "newTab" && view && (
        <NewTab
          templates={templates}
          template={m.template}
          onClose={close}
          onCreate={async (name, templateId) => {
            const data = (await run({ action: "createTab", projectId: view.project.id, name, templateId })) as { tab: { id: string } } | null;
            if (!data) return;
            close();
            onTabCreated(data.tab.id);
          }}
        />
      )}
      {m?.kind === "agent" && activeTab && (
        <NewAgent
          roles={roles}
          talkOnly={view?.project.source === "none"}
          codexOff={worker?.codexOff ?? null}
          onClose={close}
          onCreate={async (fields) => {
            if (await run({ action: "createAgent", tabId: activeTab, ...fields })) close();
          }}
        />
      )}
      {m?.kind === "search" && (
        <SearchDialog
          words={m.words}
          onClose={close}
          canShow={canShow}
          onShow={(agentId) => {
            if (openAgent(agentId)) close();
          }}
        />
      )}
      {m?.kind === "report" && <ReportDialog tabId={m.tabId} onClose={close} />}
      {m?.kind === "proposal" && (
        <TeamSetupDialog
          codexOff={worker?.codexOff ?? null}
          takenNames={[]}
          roles={roles}
          proposed={m.proposal}
          onClose={close}
          onCreate={async (setup) => {
            if (await runAndList({ action: "decideProposal", noticeId: m.noticeId, decision: "create", setup })) close();
          }}
        />
      )}
      {m?.kind === "team" && activeTab && view && (
        <TeamSetupDialog
          codexOff={worker?.codexOff ?? null}
          takenNames={takenNames}
          roles={roles}
          onClose={close}
          onCreate={async (setup) => {
            if (await run({ action: "createTeam", tabId: activeTab, setup })) close();
          }}
        />
      )}
      {/* Only over the project that opened it: choosing another project
          (from the sidebar behind it) hides it rather than retargeting it. */}
      {m && (m.kind === "network" || m.kind === "closed" || m.kind === "folders") && m.projectId === view?.project.id && (
        <>
          {m.kind === "network" && <NetworkDialog project={view.project} run={runAndList} onClose={close} />}
          {m.kind === "closed" && <ClosedTabsDialog closedTabs={view.closedTabs} run={runAndList} onClose={close} />}
          {m.kind === "folders" && <FoldersDialog view={view} onClose={close} />}
        </>
      )}
      {tab && m?.kind === "spend" && <SpendLimitDialog tab={tab} run={run} onClose={close} />}
      {tab && m?.kind === "turns" && <TurnLimitsDialog key={`${tab.turnLimit}/${tab.timeLimitMin}`} tab={tab} run={run} onClose={close} />}
      {tab?.steps && m?.kind === "steps" && <StepsDialog tab={tab} run={run} onClose={close} />}
      {tab && m?.kind === "template" && <SaveTemplateDialog tab={tab} run={runAndList} onClose={close} />}
      {m?.kind === "archive" && (
        <ArchiveDialog
          key={`${m.scope}:${m.id}`}
          scope={m.scope}
          id={m.id}
          onClose={close}
          onConfirm={async () => {
            if (!(await run({ action: "archive", scope: m.scope, id: m.id }))) return;
            // Also closes a tab's or the project's dialog (one modal at a time).
            close();
            await loadProjects();
          }}
        />
      )}
      {m?.kind === "pause" && <PauseDialog scope={m.scope} id={m.id} name={m.name} run={run} onClose={close} />}
    </>
  );
}
