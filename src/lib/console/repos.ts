import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync, rmSync, statfsSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  checkGitHub,
  Clone,
  commentOnPullRequest,
  CONSOLE_BRANCH,
  CONSOLE_FILES_IN_BRANCH,
  consoleBranch,
  findPullRequest,
  GitError,
  Mirror,
  openPullRequest,
  readPullRequest,
  readReviewThreadComments,
  replyToReviewThread,
  reviewThreadOwner,
  STORED_OBJECTS,
} from "./git.ts";
import { CODEX_REVIEW, pullRequestReviewText, pullRequestText, wantsReview } from "./pull-request.ts";
import { agentModel } from "./agents.ts";
import type { Launcher } from "./launcher.ts";
import { credentialValues, keyFor } from "./keys.ts";
import { inStep, type ConsolePaths } from "./permissions.ts";
import { Redactor, truncateBytes } from "./redact.ts";
import type { ConsoleStore } from "./store.ts";
import type { ConsoleAgent, ConsoleJob, ConsoleProject } from "./types.ts";
import { commitMessage } from "./team.ts";

// Projects, clones, per-turn commits, the changes view and Push branch.
// The worker calls these. Every Git command on an agent's repository runs
// as `agent` through the launcher, and the GitHub token is used only in the
// owner's mirror.

const TOKEN_KEY = "CONSOLE_GIT_TOKEN";
/** Git's empty tree: the base of a folder that had no first commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const COMMIT_PATCH_BYTES = 256 * 1024;
/** What Redactor.text leaves in place of a credential. */
const REDACTION_MARK = /\[redacted …/;
const BRANCH_PATCH_BYTES = 512 * 1024;
/** No new clone when free disk would fall below this. */
export const MIN_FREE_BYTES = 5 * 1024 ** 3;
/** Free bytes on the volume holding `path`, as an ordinary user sees them. */
export function freeBytes(path: string): number {
  const s = statfsSync(path);
  return s.bavail * s.bsize;
}
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
/** The largest bundle the worker copies out of an agent's folder. */
export const MAX_BUNDLE_BYTES = 4 * 1024 ** 3;

/**
 * Copy a file the agent user wrote (a bundle in its `.git`) to `to`, a new
 * file. The agent can swap the path for a link (to the owner's key file), a
 * FIFO (which would hang the worker) or a device, so the file is opened
 * without following a final link and without blocking, and must then be a
 * regular file owned by the agent user (`uid`), at most `max` bytes. It is
 * copied from that open file, never by name again.
 */
export function copyAgentFile(from: string, to: string, uid: number, max = MAX_BUNDLE_BYTES) {
  let src: number;
  try {
    src = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new GitError(`The agent's bundle could not be opened (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
  }
  let dest: number | null = null;
  try {
    const s = fstatSync(src);
    if (!s.isFile()) throw new GitError("The agent's bundle is not a regular file.");
    if (s.uid !== uid) throw new GitError("The agent's bundle does not belong to the agent user.");
    if (s.size > max) throw new GitError(`The agent's bundle is larger than ${gb(max)}.`);
    rmSync(to, { force: true });
    dest = openSync(to, "wx", 0o640);
    const buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    for (;;) {
      const n = readSync(src, buffer, 0, buffer.length, null);
      if (!n) break;
      total += n;
      if (total > max) throw new GitError(`The agent's bundle is larger than ${gb(max)}.`);
      writeSync(dest, buffer, 0, n);
    }
  } catch (error) {
    if (dest !== null) rmSync(to, { force: true });
    throw error;
  } finally {
    closeSync(src);
    if (dest !== null) closeSync(dest);
  }
  chmodSync(to, 0o640);
}

export interface ReposOptions {
  store: ConsoleStore;
  launcher: Launcher;
  paths: ConsolePaths;
  keysFile: string;
  /** `~/.squadroom/console/mirrors`. */
  mirrorsDir: string;
  redactor: Redactor;
  /** GitHub's API (tests use a fake). */
  fetch?: typeof fetch;
  /** The URL the mirror clones and pushes (tests use a local repository). */
  remoteUrl?: (repo: string) => string;
  /** GitHub's API base (tests use a fake behind `fetch`). */
  githubApi?: string;
  /** Free disk floor and how free space is read (tests change both). */
  minFreeBytes?: number;
  freeBytes?: (path: string) => number;
  /** Comment `@codex review` on pull requests (CONSOLE_CODEX_REVIEW; default off). */
  codexReview?: boolean;
}

export class Repos {
  private o: ReposOptions;
  /** One mirror operation at a time per project (Git locks its files). */
  private locks = new Map<string, Promise<unknown>>();
  constructor(options: ReposOptions) {
    this.o = options;
  }
  private serial<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.locks.set(projectId, next);
    void next.finally(() => {
      if (this.locks.get(projectId) === next) this.locks.delete(projectId);
    }).catch(() => {});
    return next;
  }
  /** The Git token for a project: its own override, or the global one. */
  private token(projectId: string): string {
    const token = keyFor(this.o.keysFile, TOKEN_KEY, projectId).value;
    this.o.redactor.add(token);
    return token;
  }
  private mirror(project: ConsoleProject): Mirror {
    return new Mirror(join(this.o.mirrorsDir, `${project.id}.git`), project.repo!, this.o.remoteUrl?.(project.repo!));
  }
  /** The branch head the Console last recorded (Changes shows it): the
   * kept diff's, or the base commit before there is one. */
  private recordedHead(agent: ConsoleAgent): string | null {
    return this.o.store.diff(agent.id)?.head ?? this.o.store.agentBase(agent.id).baseCommit;
  }
  /** The agent user's id: what every file copied out of its folders must
   * belong to. */
  private agentUid(): number {
    return statSync(this.o.paths.agentHome).uid;
  }
  clone(agent: Pick<ConsoleAgent, "folder">): Clone {
    return new Clone(this.o.launcher, agent.folder);
  }
  folderFor(agent: Pick<ConsoleAgent, "projectId" | "id">): string {
    return join(this.o.paths.agentHome, "work", agent.projectId, agent.id);
  }

  /** Refuse a clone that would leave less than the floor free. */
  private checkDisk(needed: number) {
    const floor = this.o.minFreeBytes ?? MIN_FREE_BYTES;
    const free = (this.o.freeBytes ?? freeBytes)(this.o.paths.agentHome);
    if (free - needed < floor)
      throw new GitError(`Not enough free disk for a new copy: ${gb(free)} free, and at least ${gb(floor)} must stay free.`);
  }
  /** Every value in the key file, so the push check knows each credential
   * the worker could hand out, even before an agent ran in this worker
   * (a key copied into a file in an earlier worker's life). */
  private knownCredentials() {
    try {
      for (const value of credentialValues(this.o.keysFile)) this.o.redactor.add(value);
    } catch {
      /* Not set up: nothing to look for (and no token to push with). */
    }
  }
  async commitsBetween(agent: ConsoleAgent, from: string | null, to: string) {
    return this.clone(agent).commitsBetween(from, to);
  }
  /** Every path that differs between two commits, uncapped. */
  async diffPaths(agent: ConsoleAgent, from: string, to: string): Promise<string[]> {
    return from ? this.clone(agent).diffPaths(from, to) : this.clone(agent).changedPaths(to);
  }
  /** A teammate's changes under a pattern, read from its clone (team_diff).
   * Only reads; the patch is redacted like every kept diff. */
  async diffUnder(agent: ConsoleAgent, from: string, to: string, pattern: string, maxBytes: number): Promise<string> {
    return this.o.redactor.text(await this.clone(agent).diffUnder(from, to, pattern, maxBytes));
  }
  /** Every path a commit changed, uncapped (the claim check). */
  async changedPaths(agent: ConsoleAgent, sha: string): Promise<string[]> {
    return this.clone(agent).changedPaths(sha);
  }
  /** Whether the owner's mirror of a GitHub project has a commit. */
  async mirrorHas(projectId: string, sha: string): Promise<boolean> {
    const project = this.o.store.project(projectId);
    return !!project?.repo && this.mirror(project).hasCommit(sha);
  }
  /** A project's own repository on the Mac (new-folder projects). */
  private projectRepo(project: ConsoleProject): string {
    return join(this.o.paths.agentHome, "projects", `${project.id}.git`);
  }

  /** A GitHub project before any clone: the base branch exists and its
   * ruleset names it exactly, and the mirror is up to date. */
  async prepare(project: ConsoleProject) {
    const token = this.token(project.id);
    await checkGitHub(project.repo!, project.baseBranch, token, this.o.fetch);
    await this.serial(project.id, () => this.mirror(project).update(token));
  }

  /**
   * A new agent's folder, always its own clone. An editing agent works on
   * its own `console/` branch; a Look only agent on the base, detached.
   * Returns the folder, branch and the commit its changes are compared
   * with.
   * - GitHub: checked on GitHub again, then filled from a bundle of
   *   the owner's mirror.
   * - New folder: the project's own bare repository in `~agent/projects`
   *   (one empty first commit, made by the first agent) stands in for
   *   GitHub, so every agent of the project shares its history.
   * - No files: an empty repository of its own.
   * The project's bundle in /opt/console-shared is made and read in turn.
   */
  async createFolder(agent: ConsoleAgent, project: ConsoleProject): Promise<{ folder: string; branch: string | null; base: string }> {
    const folder = this.folderFor(agent);
    const clone = new Clone(this.o.launcher, folder);
    const branch = agent.permission === "edit" && project.source !== "none" ? consoleBranch(agent.id, agent.name) : null;
    const bundle = join(this.o.paths.shared, `${project.id}.bundle`);
    if (project.source === "github") {
      const mirror = this.mirror(project);
      return this.serial(project.id, async () => {
        const token = this.token(project.id);
        await checkGitHub(project.repo!, project.baseBranch, token, this.o.fetch);
        await mirror.update(token);
        this.checkDisk(await mirror.size());
        await mirror.bundleBase(project.baseBranch, bundle);
        return { folder, branch, base: await clone.createFromBundle(bundle, project.baseBranch, branch) };
      });
    }
    this.checkDisk(0);
    if (project.source === "none") return { folder, branch: null, base: await clone.createEmpty(agent.name, agent.id) };
    return this.serial(project.id, async () => {
      const repo = this.projectRepo(project);
      const shared = new Clone(this.o.launcher, repo);
      if (!(await shared.head())) {
        // The first agent makes the first commit; the project's repository
        // takes it, so later agents start from the same history.
        const base = await clone.createEmpty(agent.name, agent.id);
        const seed = await clone.bundle("refs/heads/main", "console-seed.bundle");
        copyAgentFile(seed, bundle, this.agentUid());
        const init = await this.o.launcher.git(repo, ["init", "--quiet", "--bare", "-b", "main"], 4096);
        if (init.code !== 0 && !(await shared.head().catch(() => null)))
          throw new GitError(`Creating the project's repository failed: ${init.stderr || `exit ${init.code}`}`);
        const fetched = await this.o.launcher.git(repo, [...STORED_OBJECTS, "fetch", "--quiet", bundle, "refs/heads/main:refs/heads/main"], 4096);
        if (fetched.code !== 0) throw new GitError(`Filling the project's repository failed: ${fetched.stderr || `exit ${fetched.code}`}`);
        if (branch) await clone.checkoutNew(branch, "main");
        return { folder, branch, base };
      }
      const made = await this.o.launcher.git(repo, [...STORED_OBJECTS, "bundle", "create", "--quiet", join(repo, "console-base.bundle"), "refs/heads/main"], 4096);
      if (made.code !== 0) throw new GitError(`Bundling the project's repository failed: ${made.stderr || `exit ${made.code}`}`);
      copyAgentFile(join(repo, "console-base.bundle"), bundle, this.agentUid());
      return { folder, branch, base: await clone.createFromBundle(bundle, "main", branch) };
    });
  }

  /** The folder's commit before a turn. */
  async head(agent: ConsoleAgent): Promise<string | null> {
    return this.clone(agent).head();
  }

  /** After a turn: commit what it changed, and refresh the changes view.
   * In a tab with steps (`step`), what it changed outside the step's files
   * since the turn began is put back first and named in Needs you.
   * Returns the new commit, or null when nothing changed. */
  async afterTurn(
    agent: ConsoleAgent,
    project: ConsoleProject,
    turnId: number,
    prompt: string,
    epoch: number,
    summary: string | null = null,
    step: { files: string[]; since: string } | null = null,
  ): Promise<string | null> {
    if (step && project.source !== "none") await this.keepToStep(agent, epoch, step);
    return this.commit(agent, project, turnId, commitMessage({ request: prompt, summary, agentName: agent.name, agentId: agent.id, turnId }), epoch, "throw", step && project.source !== "none" ? step : null);
  }

  /**
   * A Look only reviewer sees a teammate's finished commit: the
   * commit crosses by bundle (the author's clone → the shared folder → the
   * reviewer's clone, as `agent`, hooks off) and is checked out detached.
   */
  async refreshReviewer(author: ConsoleAgent, reviewer: ConsoleAgent, sha: string, checkout = true) {
    const to = this.clone(reviewer);
    await this.fetchTeammate(author, reviewer, sha);
    if (checkout) await to.checkoutDetached(sha, true);
  }

  /** A teammate's commit into this agent's clone, by bundle (the author's
   * clone → the shared folder → this clone, as `agent`, hooks off), under
   * `refs/console/team/<author>`. */
  private async fetchTeammate(author: ConsoleAgent, into: ConsoleAgent, sha: string): Promise<string> {
    const to = this.clone(into);
    const ref = `refs/console/team/${author.id}`;
    if (!(await to.hasCommit(sha))) {
      const { branch, baseCommit } = this.o.store.agentBase(author.id);
      const source = branch ? `refs/heads/${branch}` : "HEAD";
      const since = baseCommit && (await to.hasCommit(baseCommit)) ? baseCommit : null;
      const made = await this.clone(author).bundleSince(source, since, `console-review-${into.id}.bundle`);
      const shared = join(this.o.paths.shared, `review-${into.id}-${randomBytes(6).toString("hex")}.bundle`);
      try {
        copyAgentFile(made, shared, this.agentUid());
        await to.fetchBundle(shared, source, ref);
      } finally {
        rmSync(shared, { force: true });
      }
    }
    // The ref names exactly this commit (the branch may have moved on).
    await to.setRef(ref, sha);
    return ref;
  }

  /**
   * team_pull: a teammate's latest committed work into this agent's
   * branch. The agent's own changes so far are committed first, so
   * the merge never mixes with uncommitted edits; the teammate's clone is
   * only read. A clean merge (or fast-forward) is committed here; with
   * conflicts the merge stays in progress for the agent to resolve.
   */
  async pull(
    me: ConsoleAgent,
    from: ConsoleAgent,
    project: ConsoleProject,
    turnId: number,
    epoch: number,
  ): Promise<{ state: "merged" | "current" | "conflicts"; sha: string | null; files: string[]; committed: string | null; before: string }> {
    const mine = this.clone(me);
    if (await mine.merging()) throw new GitError("A merge is already in progress here. Finish it (resolve the conflicts) or call team_pull_abort.");
    const theirs = await this.clone(from).head();
    if (!theirs) throw new GitError(`${from.name} has no commits yet.`);
    // Its sha goes back to the worker, which checks it like any turn's commit.
    const committed = await this.commit(me, project, turnId, `Console turn ${turnId}: work so far, before pulling from ${from.name}\n\nAgent: ${me.name} (${me.id})`, epoch);
    const before = (await mine.head()) ?? "";
    const ref = await this.fetchTeammate(from, me, theirs);
    const { branch } = this.o.store.agentBase(from.id);
    const message = `Merge ${from.name}'s work (${branch ?? theirs.slice(0, 8)}) into ${me.name}'s branch\n\nAgent: ${me.name} (${me.id})\nConsole-Turn: ${turnId}`;
    if (!(await mine.merge(ref, message, me.name, me.id))) return { state: "conflicts", sha: null, files: await mine.unmerged(), committed, before };
    const head = await mine.head();
    if (!head || head === before) return { state: "current", sha: head, files: [], committed, before };
    await this.record(me, turnId, head, epoch);
    return { state: "merged", sha: head, files: [], committed, before };
  }
  /** team_pull_abort: the branch goes back to how it was before the pull. */
  async abortPull(me: ConsoleAgent) {
    const mine = this.clone(me);
    if (!(await mine.merging())) throw new GitError("No merge is in progress.");
    await mine.abortMerge();
  }
  /** Before a turn: changes still uncommitted (an earlier commit failed, or
   * the worker restarted mid-turn) are committed on their own, so they are
   * never counted as this turn's; in a tab with steps, only those in the
   * step's files (`stepFiles`). */
  async beforeTurn(agent: ConsoleAgent, project: ConsoleProject, turnId: number, epoch: number, stepFiles: string[] | null = null): Promise<{ head: string | null; committed: string | null }> {
    // In a tab with steps, leftovers are checked from where the last turn
    // that reached the folder ended, or began if it was cut off before its
    // commit (a stop or crash mid-turn), not from a HEAD it may have moved.
    const since = stepFiles && project.source !== "none" ? (this.o.store.stepBaseline(agent.id, turnId) ?? (await this.head(agent))) : null;
    if (stepFiles && since) await this.keepToStep(agent, epoch, { files: stepFiles, since });
    // An unfinished merge is left for the agent to resolve in this turn.
    const committed = await this.commit(agent, project, turnId, `Console: changes not committed before turn ${turnId}`, epoch, "skip", stepFiles && since ? { files: stepFiles, since } : null);
    // A tab with steps: the turn starts from the commit just checked (or
    // the step's start), never from a HEAD a program the agent left running
    // may have moved since; the turn's own check puts such a commit back.
    if (stepFiles && since) return { head: committed ?? since, committed };
    // Otherwise commits made between turns (by such a program) are recorded
    // now, so Changes shows them and Push branch may send them.
    const head = await this.head(agent);
    if (head && agent.permission === "edit" && project.source !== "none" && head !== this.recordedHead(agent)) await this.refreshDiff(agent, epoch);
    return { head, committed };
  }
  /** Changes since `since` outside the step's files are put back, and
   * named in Needs you. */
  private async keepToStep(agent: ConsoleAgent, epoch: number, step: { files: string[]; since: string }) {
    const back = await this.clone(agent).keepOnly(step.since, this.o.store.agentBase(agent.id).branch, (p) => inStep(agent.folder, join(agent.folder, p), step.files));
    if (!back.length) return;
    const named = back.slice(0, 5).map((f) => (this.o.redactor.holdsSecret(f) ? "[a file whose name holds a credential]" : this.o.redactor.text(f)));
    this.o.store.addNotice(
      epoch,
      agent.id,
      `${agent.name} changed ${named.join(", ")}${back.length > 5 ? ` and ${back.length - 5} more` : ""} outside this step; the Console put ${back.length === 1 ? "it" : "them"} back. This step may change only: ${step.files.join(", ")}.`,
    );
  }
  private async commit(
    agent: ConsoleAgent,
    project: ConsoleProject,
    turnId: number,
    message: string,
    epoch: number,
    unresolved: "skip" | "throw" = "throw",
    step: { files: string[]; since: string } | null = null,
  ): Promise<string | null> {
    if (project.source === "none") return null;
    const clone = this.clone(agent);
    const only = step ? (p: string) => inStep(agent.folder, join(agent.folder, p), step.files) : undefined;
    const sha = await clone.commitTurn(this.o.redactor.text(message), agent.name, agent.id, { unresolved, conflicts: this.o.store.merging(agent.id)?.files, only, since: step?.since });
    // A finished merge (team_pull) is no longer waiting.
    if (sha && this.o.store.merging(agent.id) && !(await clone.merging())) this.o.store.setMerging(epoch, agent.id, null);
    if (!sha) return null;
    await this.record(agent, turnId, sha, epoch);
    return sha;
  }
  /** One commit in the changes view, and the branch's diff. */
  private async record(agent: ConsoleAgent, turnId: number, sha: string, epoch: number) {
    const clone = this.clone(agent);
    const shown = await clone.show(sha, COMMIT_PATCH_BYTES);
    this.o.store.addCommit(epoch, {
      turnId,
      agentId: agent.id,
      sha,
      stat: this.o.redactor.text(shown.stat),
      // A name holding a credential is left out (its content view too).
      files: shown.files.filter((f) => !this.o.redactor.holdsSecret(f)),
      patch: truncateBytes(this.o.redactor.text(shown.patch), COMMIT_PATCH_BYTES).text,
    });
    await this.refreshDiff(agent, epoch, sha);
  }

  /** The branch (or folder) against its base. */
  async refreshDiff(agent: ConsoleAgent, epoch: number, at: string | null = null) {
    const clone = this.clone(agent);
    // A commit the Console just made and checked is recorded by its id,
    // never by rereading HEAD, which a program the agent left running may
    // have moved meanwhile.
    const head = at ?? (await clone.head());
    if (!head) return;
    const base = this.o.store.agentBase(agent.id).baseCommit ?? EMPTY_TREE;
    const diff = await clone.diff(base, BRANCH_PATCH_BYTES, head);
    this.o.store.setDiff(epoch, agent.id, {
      base,
      head,
      stat: this.o.redactor.text(diff.stat),
      files: diff.files.filter((f) => !this.o.redactor.holdsSecret(f)),
      patch: truncateBytes(this.o.redactor.text(diff.patch), BRANCH_PATCH_BYTES).text,
    });
  }

  /** The agent's open pull request, or why there is none (team_pr). */
  private async agentPullRequest(agent: ConsoleAgent, project: ConsoleProject) {
    if (project.source !== "github") throw new GitError("Only a GitHub project's branches have pull requests.");
    const { branch } = this.o.store.agentBase(agent.id);
    if (!branch || agent.permission !== "edit") throw new GitError(`${agent.name} has no console/ branch of its own.`);
    const token = this.token(project.id);
    const pr = await findPullRequest(project.repo!, branch, project.baseBranch, token, this.o.fetch, this.o.githubApi);
    if (!pr) throw new GitError(`${branch} has no open pull request yet. Push it with team_push (the owner approves), which opens one.`);
    return { pr, token, branch };
  }
  /** team_pr: an agent's pull request, its review threads and
   * conversation, read with the owner's token in the worker and redacted.
   * Nothing is written. */
  async readAgentPullRequest(agent: ConsoleAgent, project: ConsoleProject, focus: { comment?: number; thread?: string } = {}): Promise<string> {
    const { pr, token } = await this.agentPullRequest(agent, project);
    const review = await readPullRequest(project.repo!, pr.number, token, this.o.fetch, this.o.githubApi);
    // One thread asked for: all of its replies, past the first 20.
    if (focus.thread) {
      const t = review.threads.find((x) => x.id === focus.thread);
      if (t?.moreComments) {
        const all = await readReviewThreadComments(t.id, token, this.o.fetch, this.o.githubApi);
        t.comments = all.comments;
        t.moreComments = all.more ? 1 : 0;
      }
    }
    const head = await this.clone(agent).head().catch(() => null);
    return this.o.redactor.text(pullRequestReviewText(review, head, undefined, focus));
  }
  /** team_pr_reply, before the owner is asked: the agent's pull request
   * has every commit its folder has (a reply describes what is on GitHub),
   * and the thread belongs to that pull request. */
  async checkReplyOnAgentPullRequest(agent: ConsoleAgent, project: ConsoleProject, threadId: string): Promise<number> {
    const { pr, token } = await this.agentPullRequest(agent, project);
    const review = await readPullRequest(project.repo!, pr.number, token, this.o.fetch, this.o.githubApi);
    const head = await this.clone(agent).head().catch(() => null);
    if (head && head !== review.headSha)
      throw new GitError(`Your folder has commits GitHub does not have yet (it is at ${head.slice(0, 8)}, the pull request at ${review.headSha.slice(0, 8)}). Push with team_push, then reply in your next turn once the push shows as done.`);
    const owner = await reviewThreadOwner(threadId, token, this.o.fetch, this.o.githubApi);
    if (owner !== `${project.repo!.toLowerCase()}#${pr.number}`) throw new GitError(`That thread is not on your pull request #${pr.number}.`);
    return pr.number;
  }
  /** team_pr_reply, once approved: the reply (and the resolve). */
  async replyOnAgentPullRequest(agent: ConsoleAgent, project: ConsoleProject, threadId: string, message: string, resolve: boolean): Promise<string> {
    const number = await this.checkReplyOnAgentPullRequest(agent, project, threadId);
    const token = this.token(project.id);
    const body = `${message}\n\n_— ${agent.name}, via Squadroom_`;
    if (this.o.redactor.holdsSecret(body) || REDACTION_MARK.test(body)) throw new GitError("The reply contains a credential, so it was not sent.");
    const { resolveError } = await replyToReviewThread(threadId, body, resolve, token, this.o.fetch, this.o.githubApi);
    if (resolveError) return `Replied on pull request #${number}, but the thread could not be resolved (${resolveError}). Do not reply again; the owner can resolve it on GitHub.`;
    return `Replied on pull request #${number}${resolve ? " and resolved the thread" : ""}.`;
  }

  /** Push branch: the agent's `console/` branch, from a bundle in its
   * own `.git`, through the mirror to GitHub. Returns the page where the
   * owner opens the pull request. */
  async push(job: ConsoleJob, agent: ConsoleAgent, project: ConsoleProject): Promise<{ message: string; url: string; head: string | null }> {
    if (project.source !== "github") throw new GitError("Only a GitHub project's agents push branches.");
    const { branch } = this.o.store.agentBase(agent.id);
    if (!branch || !CONSOLE_BRANCH.test(branch) || agent.permission !== "edit")
      throw new GitError("Only an editing agent's console/ branch is pushed.");
    const clone = this.clone(agent);
    if (await clone.dirty())
      throw new GitError("This agent's folder has changes that are not committed yet, so they would be missing from the push. Send it a message (its next turn commits them), then push.");
    // The commit pushed, resolved once (so archiving can tell later work
    // from pushed work). What is checked and what is pushed is exactly this
    // commit, whatever the agent's refs do meanwhile.
    const head = await clone.resolveBranch(branch);
    // Only the commit the Console recorded (and checked: steps, claims) at
    // the end of the agent's last turn is pushed. A commit made after it, by
    // a program the agent left running, waits for the next turn.
    if (head !== this.recordedHead(agent))
      throw new GitError(
        `${branch} has a commit the Console has not checked (made after the agent's last turn ended), so nothing was pushed. Send the agent a message: its next turn checks the branch. Then push again.`,
      );
    const token = this.token(project.id);
    // The base branch must still be protected by name before every push.
    await checkGitHub(project.repo!, project.baseBranch, token, this.o.fetch);
    // Nothing an agent was handed may leave the Mac: every object of the
    // branch that GitHub does not have yet (by the owner's mirror, never by
    // a ref the agent controls) is read raw, binary or not, for every known
    // credential. The key file's values are known even before an agent
    // ran in this worker.
    this.knownCredentials();
    // The bundle is the agent's file: copied safely into the owner's own
    // folder before the mirror reads it.
    mkdirSync(this.o.mirrorsDir, { recursive: true, mode: 0o700 });
    const bundle = join(this.o.mirrorsDir, `push-${project.id}-${randomBytes(6).toString("hex")}.bundle`);
    copyAgentFile(await clone.bundleBranch(branch), bundle, this.agentUid());
    await this.serial(project.id, async () => {
      const mirror = this.mirror(project);
      try {
        await mirror.stage(bundle, branch, head);
        // The owner's uploads never leave the Mac, even committed by the
        // agent itself.
        if (await mirror.addsConsoleFiles(head)) throw new GitError(CONSOLE_FILES_IN_BRANCH);
        await mirror.scanNew(head, (bytes) => this.o.redactor.holdsSecretBytes(bytes));
        await mirror.pushStaged(branch, head, token);
      } finally {
        await mirror.unstage(branch);
      }
    }).finally(() => rmSync(bundle, { force: true }));
    const compare = `https://github.com/${project.repo}/compare/${encodeURIComponent(project.baseBranch)}...${branch
      .split("/")
      .map(encodeURIComponent)
      .join("/")}?expand=1`;
    // The pull request: opened by the worker with the owner's token and
    // described by the agent (or its latest report). Then, when Codex
    // reviews are switched on, Codex is asked to review. A failure here
    // never undoes the push.
    try {
      const text = pullRequestText({
        request: job.request,
        agentName: agent.name,
        model: agentModel(agent.kind, agent.model)?.label ?? agent.model,
        branch,
        report: this.o.store.lastReport(agent.id),
        commits: await clone.subjects(project.baseBranch, branch).catch(() => []),
      });
      // Nothing an agent was handed may leave the Mac, in a description
      // either: a credential (even one already replaced by a redaction
      // marker, which keeps its last characters) sends no text at all.
      if ([text.title, text.body].some((s) => this.o.redactor.holdsSecret(s) || REDACTION_MARK.test(s)))
        throw new GitError("The description contains a credential the Console handed to an agent, so the pull request was not opened or updated.");
      const title = this.o.redactor.text(text.title);
      const body = this.o.redactor.text(text.body);
      // An open pull request takes the agent's new title and description;
      // the latest report never overwrites one already on GitHub.
      const update = { ...(job.request?.title ? { title } : {}), ...(job.request?.body ? { body } : {}) };
      const pr = await openPullRequest(project.repo!, { branch, base: project.baseBranch, title, body }, token, this.o.fetch, this.o.githubApi, update);
      let review = "";
      if (this.o.codexReview && wantsReview(job.request, pr.created))
        review = await commentOnPullRequest(project.repo!, pr.number, CODEX_REVIEW, token, this.o.fetch, this.o.githubApi).then(
          () => " Codex was asked to review it.",
          (error: unknown) => ` Codex could not be asked to review it: ${error instanceof Error ? error.message : String(error)}`,
        );
      const what = pr.created ? "Opened" : pr.updated ? "Updated the title and description of" : "Pushed to";
      return { message: `Pushed ${branch} (push ${job.id}). ${what} pull request #${pr.number}.${review}`, url: pr.url, head };
    } catch (error) {
      return {
        message: `Pushed ${branch} (push ${job.id}). The pull request was not opened: ${error instanceof Error ? error.message : String(error)} Open it from GitHub's page instead.`,
        url: compare,
        head,
      };
    }
  }
}
