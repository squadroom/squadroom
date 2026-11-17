import type { ConsoleWorker } from "../worker.ts";
import { PUSH_FAILURE_CHARS, pushFailedNote } from "../push-failure.ts";
import { errorMessage as message } from "../session.ts";
import { wakePrompt } from "../store/news.ts";

/** How often GitHub is asked about the checks being waited for. */
export const CHECKS_POLL_MS = 60_000;
/** No check started on a pushed commit by then: there are none to wait for. */
export const CHECKS_NONE_MS = 10 * 60_000;
/** Checks still running by then are no longer waited for. */
export const CHECKS_GIVE_UP_MS = 60 * 60_000;

export { wakePrompt } from "../store/news.ts";

const short = (sha: string) => sha.slice(0, 8);

// News wakes an idle agent: a merge it asked for or of its own pull
// request, its push, and GitHub's checks on it are told to it as they
// happen, not only when someone next sends it a message.
export const newsWake = {
  /** An agent with news and nothing else to do gets the Console's message.
   * It waits while the agent works, has mail or a push queued (that turn or
   * push tells it first), is paused or held, or while GitHub's checks on
   * its latest push still run (their result comes with the rest). */
  wakeForNews(this: ConsoleWorker): void {
    const epoch = this.epoch!;
    const waiting = new Set([
      ...this.store.agentsWithMail(),
      ...this.store.agentsWithJobs(),
      ...this.store.checksWatches().map((w) => w.agentId),
      ...this.store.openTurns().map((t) => t.agentId),
    ]);
    for (const agent of this.store.agents()) {
      if (agent.state !== "ready" || waiting.has(agent.id)) continue;
      const lines = this.store.news(agent.id);
      const failed = this.store.failedPush(agent.id, true);
      if (!lines.length && !failed) continue;
      const rt = this.runtimes.get(agent.id);
      if (rt?.turn || rt?.busy || this.store.tab(agent.tabId)?.archivedAt !== null || this.store.pausedFor(agent) || this.store.heldBy(agent)) continue;
      const all = failed ? [...lines, pushFailedNote(this.redactor.shorten(failed.text, PUSH_FAILURE_CHARS))] : lines;
      this.safe(() => this.store.wake(epoch, agent.id, wakePrompt(all)));
    }
  },
  /** Once a minute (from the worker's start), GitHub's checks on each
   * pushed commit waited for: when they have all finished (or none
   * started, or they ran too long), the agent is told. One look at a time; a failed read is tried again. */
  pollChecks(this: ConsoleWorker): void {
    if (this.checksPolling || this.now() - this.checksPolledAt < (this.options.checksPollMs ?? CHECKS_POLL_MS)) return;
    const watches = this.store.checksWatches();
    if (!watches.length) return;
    this.checksPolling = true;
    this.checksPolledAt = this.now();
    const epoch = this.epoch!;
    void Promise.all(
      watches.map(async (w) => {
        const end = (line: string | null) => this.safe(() => this.store.endChecksWatch(epoch, w.agentId, w.sha, line));
        const agent = this.store.agent(w.agentId);
        const project = agent ? this.store.project(agent.projectId) : undefined;
        if (!agent || agent.state === "closed" || agent.state === "error" || project?.source !== "github") return end(null);
        const age = this.now() - w.since;
        const pr = `your pull request #${w.number} (commit ${short(w.sha)})`;
        try {
          const c = await this.repos.commitChecks(project, w.sha);
          if (c.finished) {
            const tail = c.failed ? " team_checks shows them, and team_checks(job: n) the end of a failed job's log." : "";
            return end(`GitHub's checks on ${pr} have finished (${c.summary.replace(/^checks: /, "")}).${tail}`);
          }
          if (!c.started && age > CHECKS_NONE_MS) return end(`No GitHub checks started on ${pr} within ${CHECKS_NONE_MS / 60_000} minutes, so there are none to wait for.`);
          if (age > CHECKS_GIVE_UP_MS) return end(`GitHub's checks on ${pr} are still running after ${CHECKS_GIVE_UP_MS / 60_000} minutes (${c.summary.replace(/^checks: /, "")}). team_checks shows where they stand; the Console stopped waiting for them.`);
        } catch (error) {
          if (age > CHECKS_GIVE_UP_MS) return end(`The Console could not read GitHub's checks on ${pr} (${this.redactor.shorten(message(error), 200)}). team_checks reads them.`);
        }
      }),
    ).finally(() => {
      this.checksPolling = false;
    });
  },
};
