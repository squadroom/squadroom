import { useMemo } from "react";
import { STATUS_TEXT, projectKey, tabKey, visibleRows, type TreeProject, type TreeRow } from "@/lib/console/tree";
import type { ConsoleProject } from "@/lib/console/types";
import KindBadge from "./KindBadge";
import styles from "./console.module.css";

/** The navigation tree: every project → its tabs → the agents in each tab,
 * by name, with a status dot and kind badge, one click to any of them.
 * Projects and tabs collapse; a project's ⋯ opens its menu (a tab's menu is
 * on the tab strip). The open project and tab are highlighted, and the agent
 * last shown in that tab with them. */
export default function NavTree({
  tree,
  collapsed,
  projectId,
  tabId,
  agentId,
  onToggle,
  onProject,
  onTab,
  onAgent,
  onProjectMenu,
}: {
  tree: TreeProject[] | null;
  collapsed: Set<string>;
  projectId: string | null;
  tabId: string | null;
  /** The agent last shown (clicked here, or Show elsewhere). */
  agentId: string | null;
  onToggle: (key: string) => void;
  onProject: (id: string) => void;
  onTab: (projectId: string, tabId: string) => void;
  onAgent: (agentId: string) => void;
  onProjectMenu: (id: string) => void;
}) {
  const rows: TreeRow[] = useMemo(() => (tree ? visibleRows(tree, collapsed) : []), [tree, collapsed]);
  if (!tree) return <p className={styles.hint}>Loading…</p>;
  if (!tree.length) return <p className={styles.hint}>No projects yet.</p>;
  return (
    <nav aria-label="Projects, tabs and agents">
      <ul className={styles.tree} role="tree">
        {rows.map((row) => {
          const indent = { paddingLeft: `${row.depth * 14}px` };
          if (row.kind === "agent") {
            const selected = row.id === agentId && row.tabId === tabId && row.projectId === projectId;
            return (
              <li key={row.key} role="treeitem" aria-level={3} aria-selected={selected} style={indent}>
                <button className={selected ? `${styles.treeAgent} ${styles.treeOn}` : styles.treeAgent} onClick={() => onAgent(row.id)} title={`${row.name}: ${STATUS_TEXT[row.status]}`}>
                  <span className={`${styles.dot} ${styles[`dot_${row.status}`] ?? ""}`} aria-hidden="true" />
                  {row.agentKind && <KindBadge kind={row.agentKind} small />}
                  <span className={styles.treeName}>{row.name}</span>
                  <span className={styles.srOnly}>{STATUS_TEXT[row.status]}</span>
                </button>
              </li>
            );
          }
          const key = row.kind === "project" ? projectKey(row.id) : tabKey(row.id);
          const active = row.kind === "project" ? row.id === projectId : row.id === tabId && row.projectId === projectId;
          return (
            <li key={row.key} role="treeitem" aria-level={row.depth + 1} aria-expanded={row.expanded} aria-selected={active} style={indent}>
              <span className={styles.treeRow}>
                <button
                  className={styles.treeToggle}
                  onClick={() => onToggle(key)}
                  aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.name}`}
                  aria-expanded={row.expanded}
                >
                  {row.expanded ? "▾" : "▸"}
                </button>
                <button
                  className={`${row.kind === "project" ? styles.treeProject : styles.treeTab} ${active ? styles.treeOn : ""}`}
                  onClick={() => (row.kind === "project" ? onProject(row.id) : onTab(row.projectId, row.id))}
                >
                  {row.kind === "project" && <span className={`${styles.dot} ${styles[`dot_${row.status}`] ?? ""}`} aria-hidden="true" />}
                  <span className={styles.treeName}>{row.name}</span>
                  {row.paused && <span className={styles.chip}>Paused</span>}
                  {!row.expanded && row.count > 0 && <span className={styles.chip}>{row.count}</span>}
                </button>
                {row.kind === "project" && (
                  <button className={styles.treeToggle} aria-label={`${row.name}: project menu`} title="Switch, rename, pause, network, folders, archive" onClick={() => onProjectMenu(row.id)}>
                    ⋯
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Archived projects, at the foot of the tree, each with Restore. */
export function ArchivedList({ projects, run }: { projects: ConsoleProject[]; run: (id: string) => Promise<void> }) {
  const archived = projects.filter((p) => p.archivedAt !== null);
  if (!archived.length) return null;
  return (
    <details className={styles.archived}>
      <summary>Archived ({archived.length})</summary>
      <ul>
        {archived.map((p) => (
          <li key={p.id}>
            <span className={styles.treeName}>{p.name}</span>
            <button onClick={() => void run(p.id)} title="Bring the project back. Its agents stay closed; add new ones.">
              Restore
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
