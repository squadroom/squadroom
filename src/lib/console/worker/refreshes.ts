import { errorMessage as message } from "../session.ts";
import { claimCovers } from "../claims.ts";
import type { ConsoleAgent } from "../types.ts";
import type { ConsoleWorker } from "../worker.ts";

// After a commit: reviewers shown it, its files checked against other
// agents' claims, and progress for the circle detector.

/** A reviewer refresh that failed is tried again after this, and holds
 * the reviewer's turns for this many attempts. */
const REFRESH_RETRY_MS = 30_000;
const REFRESH_ATTEMPTS = 3;

export const refreshes = {
  /** Before any delivery after a restart: a turn whose after-turn check
   * never ran (the worker stopped or crashed first) still counts as
   * progress when its agent's branch has moved since it began, for
   * example by the agent's own git commit. */
  async recoverProgress(this: ConsoleWorker, epoch: number): Promise<void> {
    for (const t of this.store.progressUnchecked()) {
      const agent = this.store.agent(t.agentId);
      const project = agent ? this.store.project(agent.projectId) : null;
      if (!agent || !project) continue;
      if (project.source === "none") {
        this.safe(() => this.store.markProgress(epoch, t.turnId, false));
        continue;
      }
      // Where the branch was when the agent's next turn began, or now
      // (Git in the agent's folder: only while this worker still leads).
      if (!t.nextBefore) this.leading(epoch);
      const end = t.nextBefore ?? (await this.repos.head(agent).catch(() => null));
      // Recorded either way, as after a turn, so it is never checked again;
      // a closed agent's folder may be gone, so it is not tried again.
      if (end) this.safe(() => this.store.markProgress(epoch, t.turnId, end !== t.commitBefore));
      else if (agent.state === "closed") this.safe(() => this.store.markProgress(epoch, t.turnId, false));
    }
  },

  /** After a turn commits: changed files inside another agent's claim are
   * flagged in Needs you (Codex cannot be stopped mid-turn, and commands
   * can write without asking). */
  async checkClaims(this: ConsoleWorker, agent: ConsoleAgent, sha: string): Promise<void> {
    if (this.claimChecked.has(sha)) return;
    this.claimChecked.add(sha);
    const claims = this.store.claims(agent.tabId).filter((c) => c.agentId !== agent.id);
    if (!claims.length) return;
    // Every changed path, not the changes view's bounded list.
    const files = await this.repos.changedPaths(agent, sha).catch((error: unknown) => {
      this.log(`claim check for ${sha.slice(0, 8)} failed: ${message(error)}`);
      return [] as string[];
    });
    this.claimNotices(agent, files);
  },
  /** Each commit from `from` (excluded) to `to`, once: a merge by what it
   * brought onto its first parent (its source's claims excepted), any other
   * commit by what it changed; a merge of the base branch by what differs
   * from both sides (the agent's own edits while resolving it). */
  async checkRange(this: ConsoleWorker, agent: ConsoleAgent, from: string | null, to: string): Promise<void> {
    if (this.claimChecked.size > 10_000) this.claimChecked.clear();
    const commits = await this.repos.commitsBetween(agent, from, to).catch(() => [] as Awaited<ReturnType<typeof this.repos.commitsBetween>>);
    for (const c of commits) {
      if (this.claimChecked.has(c.sha)) continue;
      this.claimChecked.add(c.sha);
      if (!this.store.claims(agent.tabId).some((x) => x.agentId !== agent.id)) continue;
      const files = await (c.parents.length > 1 && !c.ofBase ? this.repos.diffPaths(agent, c.parents[0], c.sha) : this.repos.changedPaths(agent, c.sha)).catch(() => [] as string[]);
      this.claimNotices(agent, files, this.mergeSources.get(c.sha) ?? null);
    }
  },
  /** Notices for changed paths inside other agents' claims (except one
   * agent's, when given). */
  claimNotices(this: ConsoleWorker, agent: ConsoleAgent, files: string[], except: string | null = null): void {
    const claims = this.store.claims(agent.tabId).filter((c) => c.agentId !== agent.id && c.agentId !== except);
    for (const claim of claims) {
      // A name holding a credential is never stored, even in a notice.
      const hit = files.filter((f) => claimCovers(claim.pattern, f)).map((f) => (this.redactor.holdsSecret(f) ? "[a file whose name holds a credential]" : this.redactor.text(f)));
      if (hit.length)
        this.safe(() =>
          this.store.addNotice(
            this.epoch!,
            agent.id,
            `${agent.name} changed ${hit.slice(0, 5).join(", ")}${hit.length > 5 ? ` and ${hit.length - 5} more` : ""}, which ${claim.agentName} has claimed (${claim.pattern}${claim.note ? `: ${claim.note}` : ""}).`,
          ),
        );
    }
  },

  /** After a teammate's turn commits, each Code analysis agent of its tab is
   * shown that commit before its next turn. The obligation is a store row:
   * a commit recorded by addCommit writes its rows in the same
   * transaction; commits made otherwise (the agent's own, a merge) are
   * queued here. A restart loses nothing. */
  queueRefresh(this: ConsoleWorker, author: ConsoleAgent, sha: string): void {
    if (author.permission !== "edit") return;
    this.safe(() => this.store.queueRefresh(this.epoch!, author.id, sha));
  },
  /** Reviewers whose turns wait for a refresh: one owed, unless it has
   * failed REFRESH_ATTEMPTS times in a row (then the turn runs and is told). */
  refreshOwed(this: ConsoleWorker): string[] {
    return this.store.reviewersWithPendingRefresh().filter((id) => (this.refreshFailures.get(id) ?? 0) < REFRESH_ATTEMPTS);
  },
  /** What a Code analysis agent is told about commits still owed to it that
   * could not be shown (the kept diff is still readable with team_diff). */
  owedNote(this: ConsoleWorker, reviewerId: string): string {
    const owed = this.store.pendingRefreshes().filter((r) => r.reviewerId === reviewerId);
    if (!owed.length) return "";
    const lines = owed.map((r) => `- ${this.store.agent(r.authorId)?.name ?? r.authorId}'s commit ${r.sha.slice(0, 12)}`);
    return `These teammates' commits could not be checked out in your folder (the Console keeps trying); read their changes with team_diff instead:\n${lines.join("\n")}\n\n`;
  },
  /** Apply the refreshes owed: for each idle reviewer, every author's
   * latest commit is fetched (each under its own ref) and the most recent
   * is checked out; each is recorded as applied with its announcement in
   * one transaction. One that fails stays owed (the reviewer's next turn
   * waits), is noted in its window, and is tried again after a pause. */
  runRefreshes(this: ConsoleWorker): void {
    const epoch = this.epoch!;
    const byReviewer = new Map<string, { id: number; authorId: string; sha: string; seq: number }[]>();
    for (const r of this.store.pendingRefreshes()) byReviewer.set(r.reviewerId, [...(byReviewer.get(r.reviewerId) ?? []), r]);
    for (const [id, pending] of byReviewer) {
      const rt = this.runtimes.get(id);
      if (this.refreshing.has(id) || rt?.turn || rt?.busy) continue;
      if ((this.refreshRetryAt.get(id) ?? 0) > this.now()) continue;
      const reviewer = this.store.agent(id);
      if (!reviewer || reviewer.state === "closed" || !reviewer.folder) {
        // Nothing to show it to any more.
        for (const r of pending) this.safe(() => this.store.dropRefresh(epoch, r.id));
        continue;
      }
      if (reviewer.state !== "ready") continue;
      // A closed author's folder stays (the cleanup leaves it alone while
      // a refresh is owed), so its commit is still shown.
      const commits = pending.flatMap((r) => {
        const author = this.store.agent(r.authorId);
        if (!author || !author.folder) {
          this.safe(() => this.store.dropRefresh(epoch, r.id));
          return [];
        }
        return [{ id: r.id, author, sha: r.sha, seq: r.seq }];
      });
      if (!commits.length) continue;
      // The most recent commit is checked out, unless a newer one was
      // applied earlier (an older one being tried again after a failure
      // must not replace it).
      const applied = this.store.latestAppliedRefresh(id);
      const newer = (c: { seq: number }) => applied === null || c.seq > applied;
      this.refreshing.add(id);
      for (const c of commits) this.refreshAuthors.add(c.author.id);
      void (async () => {
        let failed = false;
        for (const c of commits) {
          const current = c === commits.at(-1) && newer(c);
          try {
            await this.repos.refreshReviewer(c.author, reviewer, c.sha, current);
          } catch (error) {
            failed = true;
            const text = this.redactor.text(
              `${c.author.name}'s commit ${c.sha.slice(0, 8)} could not be shown here: ${message(error)}. It will be tried again before this agent's next turn.`,
            );
            this.log(text);
            this.safe(() => this.store.addAgentEvent(epoch, id, "note", { text }));
            continue;
          }
          this.safe(() => this.store.refreshApplied(epoch, c.id, id, c.author, c.sha, current));
          const text = current
            ? `Now showing ${c.author.name}'s commit ${c.sha.slice(0, 8)}.`
            : `${c.author.name}'s commit ${c.sha.slice(0, 8)} is at refs/console/team/${c.author.id}.`;
          this.safe(() => this.store.addAgentEvent(epoch, id, "note", { text }));
        }
        if (failed) {
          this.refreshRetryAt.set(id, this.now() + REFRESH_RETRY_MS);
          this.refreshFailures.set(id, (this.refreshFailures.get(id) ?? 0) + 1);
        } else {
          this.refreshRetryAt.delete(id);
          this.refreshFailures.delete(id);
        }
      })().finally(() => {
        this.refreshing.delete(id);
        for (const c of commits) this.refreshAuthors.delete(c.author.id);
      });
    }
  },
};
