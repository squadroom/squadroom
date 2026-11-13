import type { ConsoleAgent, ConsoleCommit, ConsoleJob } from "../types.ts";
import type { ConsoleStore } from "../store.ts";
import { job } from "./rows.ts";

type Author = { id: string; name: string };
const files = (v: unknown) => JSON.parse((v as string) || "[]") as string[];

// The Git side (worker): turns' commits and progress, reviewer refreshes,
// what a Code analysis folder was shown, diffs and push jobs.
/** GitHub's base branch as the worker last saw it, by project, and the
 * commit of it each agent was last told about: flags. */
const BASE_TIP = "base-tip:";
const BASE_TOLD = "base-told:";

export const git = {
  // ── The base branch on GitHub ───────────────────────────────
  /** GitHub's base branch is at this commit: seen by the worker's check,
   * or just fetched for an agent's folder or its team_pull. */
  setBaseTip(this: ConsoleStore, epoch: number, projectId: string, sha: string) {
    this.setFlag(BASE_TIP + projectId, sha, epoch);
  },
  /** The commit GitHub's base branch has moved to since this agent's branch
   * last took it in, or null: for an editing agent of a GitHub project,
   * whose changes are compared with an older commit of it. */
  baseMoved(this: ConsoleStore, agent: ConsoleAgent): string | null {
    if (agent.permission !== "edit" || this.project(agent.projectId)?.source !== "github") return null;
    const tip = this.flag(BASE_TIP + agent.projectId);
    const { branch, baseCommit } = this.agentBase(agent.id);
    return tip && branch && baseCommit && tip !== baseCommit ? tip : null;
  },
  /** That commit, when the agent has not been told of it yet. */
  baseNews(this: ConsoleStore, agent: ConsoleAgent): string | null {
    const tip = this.baseMoved(agent);
    return tip && this.flag(BASE_TOLD + agent.id) !== tip ? tip : null;
  },
  baseTold(this: ConsoleStore, epoch: number, agentId: string, sha: string) {
    this.setFlag(BASE_TOLD + agentId, sha, epoch);
  },

  setTurnCommit(this: ConsoleStore, epoch: number, turnId: number, which: "before" | "after", sha: string | null) {
    this.write(epoch, `UPDATE console_turns SET commit_${which} = ? WHERE id = ?`, sha, turnId);
  },
  /** Where an agent's folder was last known to keep to its tab's step: the commit after the turn of it that ran last (by when it
   * started, since Send next reorders turns) and began in the folder, or,
   * when that turn was never committed (stopped or crashed mid-turn, or
   * its commit failed), the commit it began from. Never `turnId` itself. */
  stepBaseline(this: ConsoleStore, agentId: string, turnId: number): string | null {
    const r = this.get(
      "SELECT COALESCE(commit_after, commit_before) AS sha FROM console_turns WHERE agent_id = ? AND id <> ? AND commit_before IS NOT NULL ORDER BY started_seq IS NULL, started_seq DESC, id DESC LIMIT 1",
      agentId,
      turnId,
    );
    return (r?.sha as string | null | undefined) ?? null;
  },
  /** Ended turns that were never checked for
   * progress (the worker stopped or crashed, or Git failed, before the
   * check), with where their agent's next turn began, if it has.
   * A turn of a project without a repository has no commit to start from. */
  progressUnchecked(this: ConsoleStore): { turnId: number; agentId: string; commitBefore: string | null; nextBefore: string | null }[] {
    return this.all(
      `SELECT t.id, t.agent_id, t.commit_before,
         (SELECT n.commit_before FROM console_turns n WHERE n.agent_id = t.agent_id AND n.id > t.id AND n.commit_before IS NOT NULL ORDER BY n.id LIMIT 1) AS next_before
       FROM console_turns t JOIN console_agents a ON a.id = t.agent_id JOIN console_projects p ON p.id = a.project_id
       WHERE t.progressed = 0 AND t.status NOT IN ('queued', 'running', 'waiting_for_owner')
         AND (p.source = 'none' OR (t.commit_before IS NOT NULL AND a.folder <> ''))
       ORDER BY t.id`,
    ).map((r) => ({
      turnId: r.id as number,
      agentId: r.agent_id as string,
      commitBefore: (r.commit_before as string | null) ?? null,
      nextBefore: (r.next_before as string | null) ?? null,
    }));
  },
  /** The turn's progress check: it moved its agent's branch, or not.
   * Progress counts from when it is seen, not from when its turn began. */
  markProgress(this: ConsoleStore, epoch: number, turnId: number, moved = true) {
    this.write(
      epoch,
      "UPDATE console_turns SET progressed = ?, progress_mark = CASE WHEN ? THEN (SELECT MAX(id) FROM console_turns) END WHERE id = ?",
      moved ? 1 : 2, moved ? 1 : 0, turnId,
    );
  },
  addCommit(this: ConsoleStore, epoch: number, c: { turnId: number; agentId: string; sha: string; stat: string; patch: string; files?: string[] }) {
    this.transaction(() => {
      this.run(
        "INSERT INTO console_commits (turn_id, agent_id, sha, stat, patch, files, progress_mark, created_at) VALUES (?, ?, ?, ?, ?, ?, (SELECT MAX(id) FROM console_turns), ?)",
        c.turnId, c.agentId, c.sha, c.stat, c.patch, JSON.stringify(c.files ?? []), this.now(),
      );
      // The reviewers' refreshes are owed from the moment the commit is
      // recorded: the same transaction, so a restart between the two
      // cannot lose them.
      this.insertRefreshes(c.agentId, c.sha);
    }, epoch);
  },
  /** The agent's latest 200 commits, without their patches (the Changes
   * dialog asks for one when it is opened: `commitPatch`). */
  commits(this: ConsoleStore, agentId: string): ConsoleCommit[] {
    return this.all("SELECT id, turn_id, agent_id, sha, stat, files, created_at FROM console_commits WHERE agent_id = ? ORDER BY id DESC LIMIT 200", agentId).map((r) => ({
      id: r.id as number,
      turnId: r.turn_id as number,
      agentId: r.agent_id as string,
      sha: r.sha as string,
      stat: r.stat as string,
      files: files(r.files),
      createdAt: r.created_at as number,
    }));
  },
  /** One of the agent's commits' patch, or null when it has no such commit. */
  commitPatch(this: ConsoleStore, agentId: string, id: number): string | null {
    return (this.get("SELECT patch FROM console_commits WHERE agent_id = ? AND id = ?", agentId, id)?.patch as string | undefined) ?? null;
  },
  /** A tab's commits from `fromTurn` on, oldest first, without their
   * patches: each one's turn, SHA and files (the run report). */
  tabCommits(this: ConsoleStore, tabId: string, fromTurn: number): { turnId: number; sha: string; files: string[] }[] {
    return this.all(
      "SELECT c.turn_id, c.sha, c.files FROM console_commits c JOIN console_agents a ON a.id = c.agent_id WHERE a.tab_id = ? AND c.turn_id >= ? ORDER BY c.id",
      tabId, fromTurn,
    ).map((r) => ({ turnId: r.turn_id as number, sha: r.sha as string, files: files(r.files) }));
  },
  setDiff(this: ConsoleStore, epoch: number, agentId: string, d: { base: string; head: string; stat: string; patch: string; files?: string[] }) {
    this.transaction(() => {
      this.run(
        "INSERT INTO console_diffs (agent_id, base, head, stat, patch, files, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET base = excluded.base, head = excluded.head, stat = excluded.stat, patch = excluded.patch, files = excluded.files, updated_at = excluded.updated_at",
        agentId, d.base, d.head, d.stat, d.patch, JSON.stringify(d.files ?? []), this.now(),
      );
      // A later commit cancels an approval for good: a branch reset back to
      // the approved commit does not bring it back. The same transaction, so
      // the diff never shows a head its stale approval still covers.
      this.run("UPDATE console_approvals SET cancelled_by = ? WHERE agent_id = ? AND sha <> ? AND cancelled_by IS NULL", d.head, agentId, d.head);
    }, epoch);
  },
  /** A finished turn's commit and diff are still being recorded: set before
   * the turn ends, cleared once they are. */
  setSettling(this: ConsoleStore, epoch: number, agentId: string, turnId: number | null) {
    this.write(epoch, "UPDATE console_agents SET settling = ? WHERE id = ?", turnId, agentId);
  },
  settlingAgents(this: ConsoleStore): string[] {
    return this.all("SELECT id FROM console_agents WHERE settling IS NOT NULL").map((r) => r.id as string);
  },
  diff(this: ConsoleStore, agentId: string): { base: string; head: string; stat: string; patch: string; files: string[]; updatedAt: number } | null {
    const r = this.get("SELECT * FROM console_diffs WHERE agent_id = ?", agentId);
    if (!r) return null;
    return { base: r.base as string, head: r.head as string, stat: r.stat as string, patch: r.patch as string, files: files(r.files), updatedAt: r.updated_at as number };
  },

  // ── Reviewer refreshes (durable) ─────────────
  /** Each Code analysis teammate of an editing author is owed its latest
   * commit before its next turn: one pending row per (reviewer, author),
   * the newest commit replacing an older one not yet applied. Every
   * insert or replacement takes the next `seq`: the order the refreshes
   * were queued in, which neither the row's id (kept on replacement) nor
   * the clock (which may tie) gives. */
  insertRefreshes(this: ConsoleStore, authorId: string, sha: string) {
    const author = this.agent(authorId);
    if (!author || author.permission !== "edit") return;
    const insert = this.db.prepare(
      "INSERT INTO console_refreshes (reviewer_id, author_id, sha, seq, created_at, applied_at) VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM console_refreshes), ?, NULL) ON CONFLICT(reviewer_id, author_id) DO UPDATE SET sha = excluded.sha, seq = excluded.seq, created_at = excluded.created_at, applied_at = NULL, applied_seq = NULL WHERE sha <> excluded.sha",
    );
    for (const r of this.agents(author.projectId))
      if (r.tabId === author.tabId && r.id !== author.id && r.permission === "look" && r.state === "ready" && r.folder) insert.run(r.id, author.id, sha, this.now());
  },
  /** A commit that was not recorded through addCommit (one the agent made
   * itself, a merge) is owed to the reviewers all the same. */
  queueRefresh(this: ConsoleStore, epoch: number, authorId: string, sha: string) {
    this.transaction(() => this.insertRefreshes(authorId, sha), epoch);
  },
  /** Refreshes still to apply, in the order queued; a reviewer's rows
   * together. */
  pendingRefreshes(this: ConsoleStore): { id: number; reviewerId: string; authorId: string; sha: string; seq: number; createdAt: number }[] {
    return this.all("SELECT * FROM console_refreshes WHERE applied_at IS NULL ORDER BY reviewer_id, seq, id").map((r) => ({
      id: r.id as number,
      reviewerId: r.reviewer_id as string,
      authorId: r.author_id as string,
      sha: r.sha as string,
      seq: r.seq as number,
      createdAt: r.created_at as number,
    }));
  },
  /** Reviewers owed a refresh (no turn of theirs starts meanwhile). */
  reviewersWithPendingRefresh(this: ConsoleStore): string[] {
    return this.all("SELECT DISTINCT reviewer_id FROM console_refreshes WHERE applied_at IS NULL").map((r) => r.reviewer_id as string);
  },
  /** Authors whose clones a pending refresh will read. */
  pendingRefreshAuthors(this: ConsoleStore): string[] {
    return this.all("SELECT DISTINCT author_id FROM console_refreshes WHERE applied_at IS NULL").map((r) => r.author_id as string);
  },
  /** The queue position (`seq`) of the reviewer's most recently queued
   * applied refresh (null: none yet): an older one applied later is not
   * checked out over it. */
  latestAppliedRefresh(this: ConsoleStore, reviewerId: string): number | null {
    return (this.get("SELECT MAX(seq) AS seq FROM console_refreshes WHERE reviewer_id = ? AND applied_at IS NOT NULL", reviewerId)?.seq as number | null) ?? null;
  },
  /** The refresh is in the reviewer's folder: told to the reviewer with its
   * next prompt (console_shown) and no longer pending, in one transaction.
   * A row replaced meanwhile (a newer commit) stays pending for that one. */
  refreshApplied(this: ConsoleStore, epoch: number, refreshId: number, reviewerId: string, author: Author, sha: string, current: boolean) {
    this.transaction(() => {
      this.addShown(epoch, reviewerId, author, sha, current);
      this.run("UPDATE console_refreshes SET applied_at = ?, applied_seq = (SELECT COALESCE(MAX(id), 0) FROM console_events) WHERE id = ? AND sha = ? AND applied_at IS NULL", this.now(), refreshId, sha);
    }, epoch);
  },
  /** A refresh that can no longer be applied (its reviewer or author is
   * gone) is dropped. */
  dropRefresh(this: ConsoleStore, epoch: number, refreshId: number) {
    this.write(epoch, "DELETE FROM console_refreshes WHERE id = ?", refreshId);
  },
  /** A teammate's commit a Code analysis agent's folder was given, not yet
   * told to it. The newest checked-out one is `current`. */
  addShown(this: ConsoleStore, epoch: number, agentId: string, author: Author, sha: string, current: boolean) {
    this.transaction(() => {
      if (current) this.run("UPDATE console_shown SET current = 0 WHERE agent_id = ?", agentId);
      this.run(
        "INSERT INTO console_shown (agent_id, author_id, author_name, sha, current, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id, author_id) DO UPDATE SET author_name = excluded.author_name, sha = excluded.sha, current = excluded.current, created_at = excluded.created_at",
        agentId, author.id, author.name, sha, current ? 1 : 0, this.now(),
      );
    }, epoch);
  },
  shown(this: ConsoleStore, agentId: string): { authorId: string; name: string; sha: string; current: boolean }[] {
    return this.all("SELECT * FROM console_shown WHERE agent_id = ? ORDER BY created_at, author_id", agentId).map((r) => ({
      authorId: r.author_id as string,
      name: r.author_name as string,
      sha: r.sha as string,
      current: r.current === 1,
    }));
  },
  /** Told: these entries (exactly these commits) are cleared. */
  clearShown(this: ConsoleStore, epoch: number, agentId: string, told: { authorId: string; sha: string }[]) {
    this.transaction(() => {
      for (const t of told) this.run("DELETE FROM console_shown WHERE agent_id = ? AND author_id = ? AND sha = ?", agentId, t.authorId, t.sha);
    }, epoch);
  },

  // ── The approve gate ───────────────────────────────
  /** When a reviewer reviewed an author's commit: the end of its first
   * finished turn that started after the commit reached its folder (a
   * refresh, which also tells it), in the events' order, never the
   * clock's. Null: not reviewed. */
  reviewedAt(this: ConsoleStore, reviewerId: string, authorId: string, sha: string): number | null {
    const r = this.get(
      "SELECT MIN(t.ended_at) AS at FROM console_refreshes f JOIN console_turns t ON t.agent_id = f.reviewer_id AND t.status = 'done' AND t.started_seq > f.applied_seq WHERE f.reviewer_id = ? AND f.author_id = ? AND f.sha = ? AND f.applied_at IS NOT NULL AND f.applied_seq IS NOT NULL",
      reviewerId, authorId, sha,
    );
    return (r?.at as number | null | undefined) ?? null;
  },
  /** The owner approves the agent's branch at `sha`, the head the owner
   * was shown: refused if the branch has moved, while the agent works, or
   * (with a reviewer) before that reviewer reviewed this very commit. */
  approve(this: ConsoleStore, agentId: string, sha: string, reviewerId: string | null) {
    this.transaction(() => {
      const agent = this.agent(agentId);
      if (!agent || agent.state !== "ready" || agent.permission !== "edit") throw new Error("Only an open editing agent's work can be approved.");
      if (this.diff(agentId)?.head !== sha) throw new Error("The branch has moved since you looked: open Changes again.");
      const busy = this.changing(agentId);
      if (busy) throw new Error(`${busy} Approve after that.`);
      let reviewedAt: number | null = null;
      if (reviewerId) {
        const reviewer = this.agent(reviewerId);
        if (!reviewer || reviewer.tabId !== agent.tabId || reviewer.permission !== "look" || reviewer.state === "closed")
          throw new Error("The reviewer must be a Code analysis agent open in the same tab.");
        reviewedAt = this.reviewedAt(reviewerId, agentId, sha);
        if (reviewedAt === null) throw new Error(`${reviewer.name} has not reviewed this commit yet: it reaches its folder before its next turn.`);
      }
      this.run(
        "INSERT INTO console_approvals (agent_id, sha, reviewer_id, reviewed_at, approved_at, cancelled_by) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(agent_id) DO UPDATE SET sha = excluded.sha, reviewer_id = excluded.reviewer_id, reviewed_at = excluded.reviewed_at, approved_at = excluded.approved_at, cancelled_by = NULL",
        agentId, sha, reviewerId, reviewedAt, this.now(),
      );
    });
  },
  /** Why the agent's branch may be changing now (a turn running, or a
   * finished turn's commit still being recorded), or null. */
  changing(this: ConsoleStore, agentId: string): string | null {
    const name = this.agent(agentId)?.name ?? "This agent";
    if (this.openTurns().some((t) => t.agentId === agentId && t.status !== "queued")) return `${name} is working.`;
    if (this.get("SELECT settling FROM console_agents WHERE id = ?", agentId)?.settling != null) return `${name}'s last turn is still being committed.`;
    return null;
  },
  /** The agent's approval, and whether it still holds: a later commit
   * (another branch head) cancels it. */
  approval(this: ConsoleStore, agentId: string): { sha: string; reviewerId: string | null; reviewedAt: number | null; approvedAt: number; cancelledBy: string | null; current: boolean } | null {
    const r = this.get("SELECT * FROM console_approvals WHERE agent_id = ?", agentId);
    if (!r) return null;
    const sha = r.sha as string;
    const cancelledBy = (r.cancelled_by as string | null) ?? null;
    return { sha, reviewerId: (r.reviewer_id as string | null) ?? null, reviewedAt: (r.reviewed_at as number | null) ?? null, approvedAt: r.approved_at as number, cancelledBy, current: !cancelledBy && this.diff(agentId)?.head === sha };
  },
  revokeApproval(this: ConsoleStore, agentId: string): boolean {
    return this.run("DELETE FROM console_approvals WHERE agent_id = ?", agentId) === 1;
  },

  // ── Pushes ──────────────────────────────────────────────────────────────
  /** Push branch or team_push: one queued push per agent at a time. A later
   * request's pull request text replaces a queued one's. The worker's
   * (team_push) passes its lease epoch. */
  queuePush(this: ConsoleStore, agentId: string, request: ConsoleJob["request"] = null, epoch?: number): ConsoleJob {
    return this.transaction(() => {
      const open = this.get("SELECT id, state FROM console_jobs WHERE agent_id = ? AND state IN ('queued', 'running')", agentId);
      if (open && request && open.state === "queued") this.run("UPDATE console_jobs SET request = ? WHERE id = ?", JSON.stringify(request), open.id as number);
      const id = open
        ? (open.id as number)
        : this.insert("INSERT INTO console_jobs (agent_id, kind, state, request, created_at) VALUES (?, 'push', 'queued', ?, ?)", agentId, request ? JSON.stringify(request) : null, this.now());
      return this.job(id)!;
    }, epoch);
  },
  /** Whether the owner asked this turn to open a pull request: its
   * team_push also asks Codex to review (the owner still approves the
   * text). */
  pushApproved(this: ConsoleStore, turnId: number): boolean {
    return !!this.get("SELECT push_approved FROM console_turns WHERE id = ?", turnId)?.push_approved;
  },
  /** The agent's latest report: the final message of its latest finished
   * turn (its text after its last tool call). */
  lastReport(this: ConsoleStore, agentId: string): string | null {
    const t = this.get("SELECT id FROM console_turns WHERE agent_id = ? AND status = 'done' ORDER BY id DESC LIMIT 1", agentId);
    if (!t) return null;
    const text = this.all(
      "SELECT body FROM console_events WHERE turn_id = ? AND kind = 'text' AND id > COALESCE((SELECT MAX(id) FROM console_events WHERE turn_id = ? AND kind IN ('tool', 'tool_result')), 0) ORDER BY id",
      t.id as number, t.id as number,
    )
      .map((r) => String((JSON.parse(r.body as string) as { text?: unknown }).text ?? ""))
      .join("");
    return text.trim() || null;
  },
  job(this: ConsoleStore, id: number): ConsoleJob | undefined {
    const r = this.get("SELECT * FROM console_jobs WHERE id = ?", id);
    return r && job(r);
  },
  latestJob(this: ConsoleStore, agentId: string): ConsoleJob | undefined {
    const r = this.get("SELECT * FROM console_jobs WHERE agent_id = ? ORDER BY id DESC LIMIT 1", agentId);
    return r && job(r);
  },
  /** Each agent's latest successful push: the commit it pushed (null when
   * none was recorded) and when it ended. */
  lastPushes(this: ConsoleStore, agentIds: string[]): Map<string, { head: string | null; at: number }> {
    const out = new Map<string, { head: string | null; at: number }>();
    if (!agentIds.length) return out;
    const rows = this.all(
      `SELECT j.agent_id, j.head, COALESCE(j.ended_at, j.created_at) AS at FROM console_jobs j WHERE j.state = 'done' AND j.agent_id IN (${agentIds.map(() => "?").join(",")}) AND j.id = (SELECT MAX(id) FROM console_jobs WHERE agent_id = j.agent_id AND state = 'done')`,
      ...agentIds,
    );
    for (const r of rows) out.set(r.agent_id as string, { head: (r.head as string | null) ?? null, at: r.at as number });
    return out;
  },
  /** Agents with a push waiting or running: no new turn starts first, so
   * the push carries exactly the work that was approved. */
  agentsWithJobs(this: ConsoleStore): string[] {
    return this.all("SELECT DISTINCT agent_id FROM console_jobs WHERE state IN ('queued', 'running')").map((r) => r.agent_id as string);
  },
  /** Claim the oldest queued job. */
  claimJob(this: ConsoleStore, epoch: number, skipAgents: string[] = []): ConsoleJob | undefined {
    const skip = skipAgents.length ? ` AND agent_id NOT IN (${skipAgents.map(() => "?").join(", ")})` : "";
    const [r] = this.claimRows(epoch, "console_jobs", "queued", 1, skip, ...skipAgents);
    return r && job(r);
  },
  finishJob(this: ConsoleStore, epoch: number, id: number, state: "done" | "failed", message: string, url: string | null = null, head: string | null = null) {
    this.write(epoch, "UPDATE console_jobs SET state = ?, message = ?, url = ?, head = ?, ended_at = ? WHERE id = ?", state, message, url, head, this.now(), id);
  },
};
