// team_project: where every tab's agents and their branches
// stand, as text an agent reads and relays. Pure: the worker gathers the
// store's records and what GitHub answered, already redacted.

/** An agent's branch as GitHub has it; `null` when GitHub could not be read. */
export type AgentOnGitHub = {
  /** GitHub's commit of the branch; null when it has no such branch. */
  head: string | null;
  /** Commits in the agent's folder that GitHub lacks; null when not known. */
  unpushed: number | null;
  pr: { number: number; url: string; state: string; draft: boolean; mergeable: string } | null;
  /** The pull request's checks in one line; null when they could not be read. */
  checks?: string | null;
} | null;

export interface ProjectAgent {
  name: string;
  you: boolean;
  /** Its AI, access level and status, as the Console words them. */
  kind: string;
  access: string;
  status: string;
  /** An editing agent's branch, and its commit as of its last finished turn. */
  branch: string | null;
  head: string | null;
  /** GitHub projects, an agent with a branch: its latest push, if any, and
   * its branch on GitHub. */
  push?: { state: "queued" | "running" | "done" | "failed"; at: number; reason?: string } | null;
  github?: AgentOnGitHub;
}

export interface ProjectStatus {
  name: string;
  /** `owner/name` for a GitHub project, with its base branch's commit on
   * GitHub as the Console last saw it. */
  repo: string | null;
  baseBranch: string;
  baseTip: string | null;
  /** Why GitHub could not be read at all, when it could not. */
  githubError: string | null;
  tabs: { name: string; yours: boolean; paused: boolean; agents: ProjectAgent[] }[];
  now: number;
}

const short = (sha: string) => sha.slice(0, 8);
const ago = (ms: number) => {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / 1440)} days ago`;
};

function pushText(a: ProjectAgent, now: number): string {
  const p = a.push;
  if (!p) return "Never pushed.";
  if (p.state === "queued" || p.state === "running") return "A push is waiting to run.";
  return `Last push (${ago(now - p.at)}): ${p.state === "done" ? "pushed." : `failed: ${p.reason || "no reason was recorded."}`}`;
}

function githubText(a: ProjectAgent, base: string): string {
  const g = a.github;
  if (!g) return "Its branch on GitHub could not be read.";
  const branch =
    g.head === null
      ? "GitHub does not have this branch."
      : g.head === a.head
        ? `GitHub has it at ${short(g.head)}, the same commit.`
        : g.unpushed
          ? `GitHub has it at ${short(g.head)}: ${g.unpushed} commit${g.unpushed === 1 ? "" : "s"} not pushed yet.`
          : `GitHub has it at ${short(g.head)}, not the folder's commit.`;
  if (!g.pr) return `${branch} No pull request.`;
  const open = g.pr.state === "OPEN";
  const notes = [
    g.pr.state.toLowerCase(),
    ...(g.pr.draft ? ["draft"] : []),
    ...(open && g.pr.mergeable === "CONFLICTING" ? [`conflicts with ${base}`] : open && g.pr.mergeable === "MERGEABLE" ? ["no conflicts"] : []),
  ];
  const checks = open ? ` — ${g.checks ?? "checks: could not be read"}.` : "";
  return `${branch} Pull request #${g.pr.number} (${notes.join(", ")}): ${g.pr.url}${checks}`;
}

/** What team_project answers: every open tab of the project, each open
 * agent in one or two lines, then the base branch. */
export function teamProjectText(p: ProjectStatus): string {
  const lines = [
    p.repo
      ? `Project "${p.name}": GitHub ${p.repo}, base branch ${p.baseBranch}.${p.githubError ? ` GitHub could not be read now (${p.githubError}); what follows is what the Console has recorded.` : ""}`
      : `Project "${p.name}": its files stay on this Mac (no GitHub, so no pushes or pull requests).`,
  ];
  for (const tab of p.tabs) {
    lines.push("", `Tab "${tab.name}"${[tab.yours ? " (your tab)" : "", tab.paused ? " (paused)" : ""].join("")}`);
    if (!tab.agents.length) lines.push("- no open agents");
    for (const a of tab.agents) {
      const branch = a.branch ? `branch ${a.branch}${a.head ? ` at ${short(a.head)}` : ""}` : "no branch of its own";
      lines.push(`- ${a.name}${a.you ? " (you)" : ""}: ${a.kind}, ${a.access}, ${a.status}; ${branch}.`);
      if (p.repo && a.branch) lines.push(`  ${pushText(a, p.now)} ${p.githubError ? "" : githubText(a, p.baseBranch)}`.trimEnd());
    }
  }
  if (p.repo) lines.push("", p.baseTip ? `${p.baseBranch} on GitHub: ${short(p.baseTip)}, as the Console last saw it.` : `${p.baseBranch} on GitHub: not seen by the Console yet.`);
  return lines.join("\n");
}
