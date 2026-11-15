import { MergeUncertainError } from "../git.ts";
import { mergeAskText, mergedLine, mergedNote, mergeFailure, mergeUncertain, notMergedLine, notMergedNote, notMergedNotice } from "../merge.ts";
import { errorMessage as message } from "../session.ts";
import { TeamError } from "../team.ts";
import type { ConsoleJob } from "../types.ts";
import type { ConsoleWorker } from "../worker.ts";
import { once } from "./team-git.ts";
import { write, type TeamCall } from "./team.ts";

// team_merge: an editing agent of a GitHub project asks for a
// Console pull request of its project to be merged; the owner approves it
// in Needs you; the worker then asks GitHub to squash-merge it, at the
// commit the owner saw. The worker itself never pushes to the base branch.

/** The most of a refused merge's own text that any message carries. */
const MERGE_FAILURE_CHARS = 500;

export const merging = {
  /** The tool: checked first, so the owner is asked only for a merge that
   * could go through now, then put in Needs you. It does not wait: the
   * request outlasts the turn. */
  teamMerge(this: ConsoleWorker, c: TeamCall): Promise<string> {
    const { me, t, args, epoch, key } = c;
    const project = this.store.project(me.projectId);
    if (project?.source !== "github") throw new TeamError("Only a GitHub project's pull requests are merged; this project's work stays on the Mac.");
    if (me.permission !== "edit") throw new TeamError("A Code analysis agent cannot ask for a merge; a Code edit agent of the project can.");
    const number = args.pull_request;
    if (number !== undefined && number !== null && !(Number.isSafeInteger(number) && (number as number) >= 1))
      throw new TeamError("pull_request must be a pull request's number (leave it out for your own).");
    return once(this, c, async () => {
      let ask;
      try {
        ask = await this.repos.checkMerge(me, project, (number as number | null | undefined) ?? null);
      } catch (error) {
        throw new TeamError(this.redactor.text(message(error)));
      }
      // A push still to run (asked for in this turn, say) would change the
      // pull request after the owner looked.
      const push = this.store.latestJob(ask.authorId);
      if (push && (push.state === "queued" || push.state === "running"))
        throw new TeamError(
          `A push of ${ask.branch} is queued${ask.authorId === me.id ? " and runs after this turn ends" : ""}, so pull request #${ask.number} is about to change. Ask again in your next turn, once the push shows as done and its checks have passed.`,
        );
      const text = this.redactor.text(mergeAskText(ask, ask.authorId === me.id));
      return write(this, () => this.store.askMerge(epoch, { turnId: t.id, agentId: me.id, projectId: me.projectId, key, text, merge: ask }));
    });
  },

  /** One approved merge: checked again, merged, and told to everyone it
   * concerns. A refusal merges nothing; nothing is tried again by itself. */
  runMerge(this: ConsoleWorker, job: ConsoleJob, epoch: number): Promise<unknown> {
    const ask = job.merge!;
    const asker = this.store.agent(job.agentId);
    const project = asker ? this.store.project(asker.projectId) : undefined;
    // Everyone who asked for it, and the agent whose branch it is.
    const askers = [...new Set([job.agentId, ...(ask.alsoAsked ?? [])])];
    const windows = [...new Set([...askers, ask.authorId])];
    return (async () => {
      if (!asker || !project) throw new Error("The agent that asked for this merge no longer exists.");
      return this.repos.merge(ask, project);
    })()
      .then((commit) =>
        this.safe(() =>
          this.store.finishMerge(epoch, job.id, {
            merged: commit,
            message: mergedLine(ask, commit),
            url: ask.url,
            windows,
            news: windows.map((id) => ({
              agentId: id,
              text: mergedNote(ask, commit, id === ask.authorId, id === ask.authorId && !askers.includes(id) ? (asker?.name ?? "a teammate") : null),
            })),
            notice: null,
          }),
        ),
      )
      .catch((error: unknown) =>
        this.safe(() => {
          const reason = mergeFailure(this.redactor.shorten(this.redactor.text(message(error)), MERGE_FAILURE_CHARS));
          // Not known either way: nobody is told that nothing was merged.
          const uncertain = error instanceof MergeUncertainError ? mergeUncertain(ask.number, reason) : null;
          this.store.finishMerge(epoch, job.id, {
            merged: null,
            message: uncertain ?? notMergedLine(ask.number, reason),
            url: ask.url,
            windows,
            news: askers.map((agentId) => ({ agentId, text: uncertain ?? notMergedNote(ask.number, reason) })),
            notice: uncertain ?? notMergedNotice(ask.number, reason),
          });
        }),
      );
  },
};
