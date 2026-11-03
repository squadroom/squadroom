import { pushRequest, pushSummary } from "../pull-request.ts";
import { errorMessage as message } from "../session.ts";
import { TeamError } from "../team.ts";
import type { ConsoleWorker } from "../worker.ts";
import { REPLY_MAX } from "./shared.ts";
import { body, write, type TeamCall } from "./team.ts";

// The team tools on Git and GitHub: a teammate's work pulled into the
// agent's clone, and its pull request. One at a time per agent.

/** A thread id from team_pr. */
const THREAD = /^[A-Za-z0-9_=-]{4,100}$/;

/** One call at a time per agent (its clone, its approvals): a repeated call
 * waits, then returns the first one's recorded result. */
function once(w: ConsoleWorker, c: TeamCall, work: () => Promise<string>): Promise<string> {
  const agentId = c.me.id;
  const next = (w.pulls.get(agentId) ?? Promise.resolve())
    .catch(() => {})
    .then(() => {
      const done = w.store.toolCall(c.t.id, c.key);
      return done !== null ? done : work();
    });
  w.pulls.set(agentId, next);
  void next
    .finally(() => {
      if (w.pulls.get(agentId) === next) w.pulls.delete(agentId);
    })
    .catch(() => {});
  return next;
}
/** The call's result, recorded with its turn. */
function record(w: ConsoleWorker, c: TeamCall, tool: string, summary: string, result: string) {
  write(w, () => w.store.recordToolCall(c.epoch, { turnId: c.t.id, agentId: c.me.id, key: c.key, tool, summary, result }));
}

export const teamGit = {
  async teamPull(this: ConsoleWorker, c: TeamCall): Promise<string> {
    const { me, t, epoch } = c;
    const project = this.store.project(me.projectId);
    if (me.permission !== "edit" || !project || project.source === "none") throw new TeamError("Only an agent that edits its folder can pull a teammate's work.");
    // A tab with steps: a merge could change files outside the step.
    if (this.store.tabSteps(me.tabId)) throw new TeamError("In a tab with steps, teammates do not pull each other's work: a merge could change files outside the current step.");
    const from = this.teammate(c.team, me, c.args.from);
    if (from.state !== "ready" || !from.folder) throw new TeamError(`${from.name} has no folder to pull from.`);
    // A Look only agent shows other agents' commits, not work of its own.
    if (from.permission !== "edit" || !this.store.agentBase(from.id).branch) throw new TeamError(`${from.name} does not edit code on a branch of its own, so there is nothing of its own to pull.`);
    return once(this, c, async () => {
      // Room for its record before the clone is changed.
      write(this, () => this.store.ensurePayloadRoom(t.id, 16_384));
      let result: string;
      try {
        const pulled = await this.repos.pull(me, from, project, t.id, epoch);
        // The agent's own work, committed before the merge, is checked
        // like any turn's commit.
        if (pulled.committed) {
          this.queueRefresh(me, pulled.committed);
          void this.checkClaims(me, pulled.committed);
        }
        if (pulled.state === "conflicts" && pulled.files.some((f) => this.redactor.holdsSecret(f))) {
          // Its conflict list would have to be stored: abandoned instead.
          await this.repos.abortPull(me);
          throw new TeamError("The merge conflicts in a file whose name holds a credential, so it was abandoned; your branch is as it was. Rename that file first.");
        }
        if (pulled.state === "conflicts") {
          // The merge state keeps every conflicted path (the commit's
          // marker check needs them all); only the message is bounded,
          // so its record fits what was reserved for it.
          const listed = pulled.files.slice(0, 100);
          write(this, () => this.store.setMerging(epoch, me.id, { from: from.id, fromName: from.name, files: pulled.files }));
          result = `The merge of ${from.name}'s work has conflicts in: ${listed.join(", ")}${pulled.files.length > listed.length ? ` and ${pulled.files.length - listed.length} more (git status lists them)` : ""}. Edit those files to resolve the conflict markers (<<<<<<<, =======, >>>>>>>), then end your turn: the Console commits the merge. Or call team_pull_abort to go back.`;
        } else {
          if (pulled.state === "merged" && pulled.sha) {
            this.queueRefresh(me, pulled.sha);
            this.mergeSources.set(pulled.sha, from.id);
            this.claimChecked.add(pulled.sha);
            // What the pull brought in, against claims other than the
            // source's own (pulling a claimant's work is the point).
            void this.repos
              .diffPaths(me, pulled.before, pulled.sha)
              .then((files) => this.claimNotices(me, files, from.id))
              .catch((error: unknown) => this.log(`claim check after a pull failed: ${message(error)}`));
          }
          result = pulled.state === "merged" ? `Merged ${from.name}'s work into your branch (commit ${pulled.sha!.slice(0, 8)}).` : `Your branch already has all of ${from.name}'s committed work.`;
        }
      } catch (error) {
        if (error instanceof TeamError) throw error;
        throw new TeamError(`The pull did not work: ${this.redactor.text(message(error))}`);
      }
      record(this, c, "team_pull", `team_pull from ${from.name}`, result);
      return result;
    });
  },

  teamPullAbort(this: ConsoleWorker, c: TeamCall): Promise<string> {
    return once(this, c, async () => {
      // Room for its record before the clone is reset.
      write(this, () => this.store.ensurePayloadRoom(c.t.id, 1_024));
      try {
        await this.repos.abortPull(c.me);
      } catch (error) {
        throw new TeamError(this.redactor.text(message(error)));
      }
      write(this, () => this.store.setMerging(c.epoch, c.me.id, null));
      const result = "The merge was abandoned; your branch is as it was before the pull.";
      record(this, c, "team_pull_abort", "team_pull_abort", result);
      return result;
    });
  },

  async teamPr(this: ConsoleWorker, { me, args }: TeamCall): Promise<string> {
    const project = this.store.project(me.projectId);
    if (project?.source !== "github") throw new TeamError("Only a GitHub project's agents have pull requests.");
    if (me.permission !== "edit") throw new TeamError("A Code analysis agent has no branch, so no pull request of its own.");
    if (args.comment !== undefined && !(Number.isSafeInteger(args.comment) && (args.comment as number) >= 1))
      throw new TeamError("comment must be a comment's number from team_pr.");
    if (args.thread !== undefined && (typeof args.thread !== "string" || !THREAD.test(args.thread)))
      throw new TeamError("thread must be a thread id from team_pr.");
    const focus = {
      ...(args.comment !== undefined ? { comment: args.comment as number } : {}),
      ...(typeof args.thread === "string" ? { thread: args.thread } : {}),
    };
    try {
      return await this.repos.readAgentPullRequest(me, project, focus);
    } catch (error) {
      throw new TeamError(this.redactor.text(message(error)));
    }
  },

  async teamPrReply(this: ConsoleWorker, c: TeamCall): Promise<string> {
    const { me, t, args, epoch, key } = c;
    const project = this.store.project(me.projectId);
    if (project?.source !== "github") throw new TeamError("Only a GitHub project's agents have pull requests.");
    if (me.permission !== "edit") throw new TeamError("A Code analysis agent has no pull request of its own.");
    const thread = typeof args.thread === "string" ? args.thread.trim() : "";
    if (!THREAD.test(thread)) throw new TeamError("thread must be a thread id from team_pr.");
    if (args.resolve !== undefined && typeof args.resolve !== "boolean") throw new TeamError("resolve must be true or false.");
    if (typeof args.message === "string" && this.redactor.holdsSecret(args.message))
      throw new TeamError("The message contains a credential the Console handed to you. Remove it and try again.");
    const text = body(this, args);
    if (text.length > REPLY_MAX) throw new TeamError(`A reply is at most ${REPLY_MAX} characters.`);
    const resolve = args.resolve === true;
    // A push queued in this turn runs after it ends: the fix is not on
    // GitHub yet, so the reply waits for the next turn.
    const job = this.store.latestJob(me.id);
    if (job && (job.state === "queued" || job.state === "running"))
      throw new TeamError("Your push is queued and runs after this turn ends, so the fix is not on GitHub yet. Reply in your next turn, once the push shows as done.");
    return once(this, c, async () => {
      // Checked before the owner is asked, so nothing they approve fails
      // for a reason known in advance.
      try {
        await this.repos.checkReplyOnAgentPullRequest(me, project, thread);
      } catch (error) {
        throw new TeamError(this.redactor.text(message(error)));
      }
      // A reply is public on GitHub: the owner approves it (or "Always
      // for this agent").
      const answer = await this.permit(c.rt, "team_pr_reply", { thread, message: text.slice(0, 2_000), resolve }, {
        behavior: "ask",
        reason: "Replying on GitHub needs the owner's approval.",
        ruleKey: "tool:team_pr_reply",
        // The whole reply, as it will be posted (bounded by REPLY_MAX).
        summary: `Reply on its pull request${resolve ? " and resolve the thread" : ""}:\n\n${text}`,
      });
      if (!answer.allow) {
        const refused = `Not sent: ${answer.reason}`;
        record(this, c, "team_pr_reply", "team_pr_reply", refused);
        throw new TeamError(refused);
      }
      // Journaled before GitHub is asked: a crash after the reply but
      // before its result leaves a record that it may be there. Room for
      // its final result is checked first.
      write(this, () => this.store.ensurePayloadRoom(t.id, 1_024));
      write(this, () =>
        this.store.journalToolCall(epoch, {
          turnId: t.id,
          agentId: me.id,
          key,
          tool: "team_pr_reply",
          summary: `team_pr_reply on thread ${thread}`,
          result: `A reply to thread ${thread} may have been posted; check team_pr before replying again.`,
        }),
      );
      let result: string;
      try {
        result = await this.repos.replyOnAgentPullRequest(me, project, thread, text, resolve);
      } catch (error) {
        const failed = this.redactor.text(message(error));
        write(this, () => this.store.settleToolCall(epoch, t.id, key, `The reply may not have been posted (${failed.slice(0, 300)}); check team_pr before replying again.`));
        throw new TeamError(failed);
      }
      write(this, () => this.store.settleToolCall(epoch, t.id, key, result));
      return result;
    });
  },

  teamPush(this: ConsoleWorker, c: TeamCall): Promise<string> {
    const { me, t, args } = c;
    const project = this.store.project(me.projectId);
    if (project?.source !== "github") throw new TeamError("Only a GitHub project's agents push branches; this project's work stays on the Mac.");
    if (me.permission !== "edit") throw new TeamError("A Code analysis agent has no branch to push.");
    // One approval at a time per agent: a repeated call waits, then
    // returns the first one's recorded result.
    return once(this, c, async () => {
      const branch = this.store.agentBase(me.id).branch ?? "its branch";
      const parsed = pushRequest(args, "agent");
      if ("error" in parsed) throw new TeamError(parsed.error);
      // Checked before redaction, which would hide it.
      if ([parsed.title, parsed.body].some((s) => s && this.redactor.holdsSecret(s)))
        throw new TeamError("The title or description contains a credential the Console handed to you. Remove it and call team_push again.");
      // The owner's "Open pull request" also asks Codex, even when the
      // pull request already exists.
      const ownerAsked = this.store.pushApproved(t.id);
      const request = ownerAsked ? { ...parsed, review: true } : parsed;
      // The owner approves each push in Needs you, or "Always for this
      // agent", seeing the title and description the agent wrote: they are
      // posted from the owner's account. A turn the owner started with
      // "Open pull request" asks too, since its text was not written yet.
      const answer = await this.permit(c.rt, "team_push", { branch, title: request.title ?? null, body: request.body ?? null }, {
        behavior: "ask",
        reason: ownerAsked ? "You asked for this pull request; its title and description need your approval." : "Pushing to GitHub needs the owner's approval.",
        ruleKey: "tool:team_push",
        summary: pushSummary(branch, request),
      });
      if (!answer.allow) {
        // Recorded, so the same call again in this turn does not ask again.
        const refused = `Not pushed: ${answer.reason}`;
        record(this, c, "team_push", `team_push ${branch}`, refused);
        throw new TeamError(refused);
      }
      // Room for its record first: the push must never be queued and
      // then fail to be recorded.
      write(this, () => this.store.ensurePayloadRoom(t.id, 2_048));
      const job = write(this, () =>
        this.store.queuePush(me.id, {
          ...request,
          ...(request.title ? { title: this.redactor.text(request.title) } : {}),
          ...(request.body ? { body: this.redactor.text(request.body) } : {}),
        }, c.epoch),
      );
      const result = `Approved. ${branch} is pushed after this turn ends and its changes are committed (push ${job.id}), then its pull request is opened or updated; the result shows in your window.`;
      record(this, c, "team_push", `team_push ${branch}`, result);
      return result;
    });
  },
};
