import { agentKind, agentModel } from "./agents.ts";
import type { ConsoleStore, TabTurn } from "./store.ts";
import type { TemplateStep } from "./templates.ts";
import { usd } from "./spend.ts";
import { PERMISSION_LABELS } from "./types.ts";

// The run report and Markdown export: a tab's run as one Markdown
// document, from what the store already holds (redacted as stored). No
// model is called.

export interface ReportData {
  project: string;
  tab: string;
  generatedAt: number;
  steps: { steps: TemplateStep[]; index: number } | null;
  agents: { name: string; ai: string; access: string; approval: string | null }[];
  turns: (TabTurn & { commits: { sha: string; files: string[] }[] })[];
}

/** The most turns a report holds. */
const TURNS_MAX = 2000;
const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const count = (turns: TabTurn[], status: string) => turns.filter((t) => t.status === status).length;
/** Text set apart as a quotation, so its own headings stay inside it
 * (every line ending counts, a bare carriage return too). */
const quote = (text: string) =>
  text
    .trim()
    .split(/\r\n|\r|\n/)
    .map((l) => `> ${l}`)
    .join("\n");
/** A stored name on one line, unable to open a table cell or code (names
 * are only trimmed when they are saved); a file name or commit as code. */
const inline = (text: string) => text.replace(/\s+/g, " ").replace(/[|`]/g, (c) => `\\${c}`).trim();
const code = (text: string) => `\`${text.replace(/\s+/g, " ").replace(/`/g, "'")}\``;

/** The report as Markdown (pure). */
export function runReport(d: ReportData): string {
  const spend = d.turns.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
  const first = d.turns[0]?.createdAt;
  const last = d.turns.reduce((m, t) => Math.max(m, t.endedAt ?? t.createdAt), 0);
  const out = [
    `# ${inline(d.project)} › ${inline(d.tab)}: run report`,
    "",
    `Made ${when(d.generatedAt)} from the Console's stored record; no model was asked.`,
    "",
    "## Summary",
    "",
    `- Turns: ${d.turns.length} (${count(d.turns, "done")} done, ${count(d.turns, "failed")} failed, ${count(d.turns, "interrupted")} interrupted, ${count(d.turns, "stopped")} stopped)`,
    `- API-key spend: ${usd(spend)}`,
    ...(first ? [`- From ${when(first)} to ${when(last)}`] : []),
    ...(d.steps ? [`- Step ${d.steps.index + 1} of ${d.steps.steps.length}: ${inline(d.steps.steps[d.steps.index]?.name ?? "")}`] : []),
    "",
    "## Agents",
    "",
    "| Agent | AI | Access | Approval |",
    "|---|---|---|---|",
    ...d.agents.map((a) => `| ${inline(a.name)} | ${inline(a.ai)} | ${a.access} | ${a.approval ?? ""} |`),
    "",
    "## Conversation",
  ];
  for (const t of d.turns) {
    const asker = t.trigger === "owner" ? "The owner" : "Its teammates";
    const name = inline(t.agentName);
    out.push("", `### ${when(t.createdAt)} · ${name} · turn ${t.id} · ${t.status}${t.costUsd ? ` · ${usd(t.costUsd)}` : ""}`, "", `${asker}:`, "", quote(t.prompt));
    if (t.finalText) out.push("", `${name}:`, "", quote(t.finalText));
    if (t.reason && t.status !== "done") out.push("", "Ended:", "", quote(t.reason));
    for (const c of t.commits) out.push("", `Commit ${code(c.sha.slice(0, 12))}${c.files.length ? `: ${c.files.map(code).join(", ")}` : ""}`);
  }
  if (d.turns.length >= TURNS_MAX) out.push("", "_Only the latest 2,000 turns are included._");
  return `${out.join("\n")}\n`;
}

/** The report's data for a tab, or null for no such tab. */
export function reportData(store: ConsoleStore, tabId: string, now: number): ReportData | null {
  const tab = store.tab(tabId);
  if (!tab) return null;
  const agents = store.agents(tab.projectId).filter((a) => a.tabId === tab.id);
  const turns = store.tabTurns(tab.id, TURNS_MAX);
  // Every commit of the reported turns, oldest first (a team_pull records
  // more than one), without their patches.
  const commits = new Map<number, { sha: string; files: string[] }[]>();
  for (const c of turns.length ? store.tabCommits(tab.id, turns[0].id) : []) commits.set(c.turnId, [...(commits.get(c.turnId) ?? []), { sha: c.sha, files: c.files }]);
  return {
    project: store.project(tab.projectId)?.name ?? "",
    tab: tab.name,
    generatedAt: now,
    steps: store.tabSteps(tab.id),
    agents: agents.map((a) => {
      const approval = a.permission === "edit" ? store.approval(a.id) : null;
      return {
        name: a.state === "closed" ? `${a.name} (closed)` : a.name,
        ai: `${agentKind(a.kind)?.label ?? a.kind}, ${agentModel(a.kind, a.model)?.label ?? a.model}`,
        access: PERMISSION_LABELS[a.permission],
        approval: approval ? `\`${approval.sha.slice(0, 12)}\` ${approval.current ? "approved" : "approval cancelled by a later commit"}` : null,
      };
    }),
    turns: turns.map((t) => ({ ...t, commits: commits.get(t.id) ?? [] })),
  };
}
