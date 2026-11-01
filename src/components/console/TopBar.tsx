import { useState } from "react";
import type { WorkerView } from "@/lib/console/views";
import { workerStatus } from "@/lib/console/ui";
import type { Run } from "./api";
import Icon from "./Icon";
import InlineRename from "./InlineRename";
import { MenuButton, type MenuItem } from "./Menu";
import styles from "./console.module.css";

// The top bar: the project and its settings, search, Needs you (only when
// something waits), the status control and Settings. Each looks like what it
// is; nothing else lives here.

export default function TopBar({
  project,
  projectItems,
  onProjectMenuOpened,
  onProjectRenamed,
  onDrawer,
  onShowSidebar,
  needs,
  needsOpen,
  onNeeds,
  worker,
  run,
  onSearch,
  settingsOpen,
  onSettings,
}: {
  /** The open project and its menu; renamed in place. */
  project: { name: string; signal: number; renaming: boolean } | null;
  projectItems: () => MenuItem[];
  onProjectMenuOpened: () => void;
  onProjectRenamed: (name: string | null) => void;
  onDrawer: () => void;
  /** Brings back the sidebar folded away on a wide screen. */
  onShowSidebar: (() => void) | null;
  needs: number;
  needsOpen: boolean;
  onNeeds: () => void;
  worker: WorkerView | null;
  run: Run;
  onSearch: (words: string) => void;
  settingsOpen: boolean;
  onSettings: () => void;
}) {
  const [words, setWords] = useState("");
  const status = workerStatus(worker);
  const paused = worker?.pausedAll != null;
  const items: MenuItem[] = paused
    ? [{ label: "Resume all", hint: "Queued messages and turns start again", onSelect: () => void run({ action: "resume", scope: "all" }) }]
    : [
        { label: "Pause after current turns", hint: "Running turns finish, then nothing new starts", onSelect: () => void run({ action: "pause", scope: "all", mode: "after" }) },
        { label: "Stop now", hint: "Running turns stop; their messages wait in Needs you", danger: true, onSelect: () => void run({ action: "pause", scope: "all", mode: "now" }) },
      ];
  const note = [
    !worker?.online && "The Console worker is not running: start it with npm run console:worker.",
    paused && `${worker!.pausedAll || "Everything is paused."} Queued messages and turns wait for Resume.`,
    worker?.online && worker.running > 0 && `${worker.running} running · restarting the Console worker interrupts ${worker.running === 1 ? "it" : "them"}.`,
    worker?.online && !paused && !worker.running && "Agents take their turns as messages arrive.",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <header className={styles.topbar}>
      {onShowSidebar && (
        <button className={`${styles.iconButton} ${styles.wideScreenOnly}`} onClick={onShowSidebar} aria-label="Show the sidebar" title="Show the sidebar">
          <Icon name="sidebar" />
        </button>
      )}
      <button className={`${styles.iconButton} ${styles.phoneOnly}`} onClick={onDrawer} aria-label="Projects and agents" title="Projects and agents">
        <Icon name="menu" />
      </button>
      {project?.renaming ? (
        <InlineRename name={project.name} label={`New name for the project ${project.name}`} onDone={onProjectRenamed} />
      ) : project ? (
        <MenuButton
          className={styles.projectButton}
          label={`Project ${project.name}`}
          title="Switch project, rename, pause, network, folders, archive"
          items={projectItems()}
          start
          openSignal={project.signal}
          onSignalled={onProjectMenuOpened}
        >
          <span>{project.name}</span>
          <Icon name="chevron" size={14} />
        </MenuButton>
      ) : (
        <strong className={styles.projectButton}>Squadroom</strong>
      )}
      <form
        role="search"
        className={styles.search}
        onSubmit={(e) => {
          e.preventDefault();
          onSearch(words.trim());
        }}
      >
        <Icon name="search" size={14} />
        <input type="search" aria-label="Search conversations" placeholder="Search conversations" value={words} onChange={(e) => setWords(e.target.value)} />
      </form>
      <span className={styles.topbarEnd}>
        <button className={`${styles.iconButton} ${styles.phoneOnly} ${styles.searchIcon}`} aria-label="Search conversations" title="Search conversations" onClick={() => onSearch("")}>
          <Icon name="search" />
        </button>
        {needs > 0 && (
          <button className={styles.needsPill} onClick={onNeeds} aria-expanded={needsOpen} title="Questions, approvals and pauses waiting for you">
            <span className={styles.needsDot} aria-hidden="true" />
            {needs} <span className={styles.wideOnly}>{needs === 1 ? "needs you" : "need you"}</span>
            <span className={styles.srOnly}>{needs === 1 ? " item needs you" : " items need you"}</span>
          </button>
        )}
        {status && (
          <MenuButton className={`${styles.status} ${styles[`status_${status.tone}`]}`} label={`Status: ${status.label}`} title={status.label} note={note} items={items}>
            <span className={styles.statusDot} aria-hidden="true" />
            <span className={styles.wideOnly}>{status.label}</span>
            <Icon name="chevron" size={14} />
          </MenuButton>
        )}
        <button className={styles.iconButton} aria-label="Settings" title="Settings" aria-current={settingsOpen ? "page" : undefined} onClick={onSettings}>
          <Icon name="gear" />
        </button>
      </span>
    </header>
  );
}
