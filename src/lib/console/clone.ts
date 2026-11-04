import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONSOLE_BRANCH, CONSOLE_DIRS, fail, GitError } from "./git.ts";
import type { Launcher, RunResult } from "./launcher.ts";

// The agent's clone, run as `agent` through the launcher: every agent's
// clone is its own repository, owned by `agent`, and all Git there runs in
// the launcher's sandbox (no hooks, filters, fsmonitor or credential
// helpers, no network). It never mixes with the owner's mirror
// (mirror.ts): commits cross between the two only as bundles.

/** `-z` output: NUL-separated names. At most 500 are kept. */
const nulList = (out: string) => out.split("\0").filter(Boolean).slice(0, 500);
const EXCLUDE = [".", ...CONSOLE_DIRS.map((d) => `:(exclude)${d}`)];

/**
 * Before every Git command on an agent's repository: objects are read as
 * they are stored. The agent can write `refs/replace/*` and a commit-graph
 * file, either of which makes a commit seem to hold another tree, so a
 * file outside a step could look unchanged and the Changes view could hide
 * it. (Grafts, the third way, only ever change parents; the launcher drops
 * them with GIT_GRAFT_FILE.) Index flags that hide a change from status are
 * cleared where it matters (`reveal`).
 */
export const STORED_OBJECTS = ["--no-replace-objects", "-c", "core.useReplaceRefs=false", "-c", "core.commitGraph=false"];

const author = (name: string, agentId: string) => [
  "-c",
  `user.name=${name.replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 60) || "Console agent"}`,
  "-c",
  `user.email=${agentId}@console.local`,
];

export class Clone {
  readonly folder: string;
  private launcher: Launcher;
  constructor(launcher: Launcher, folder: string) {
    this.launcher = launcher;
    this.folder = folder;
  }
  /** Git in this clone, objects as stored (`init` is the launcher's own
   * action, recognised by its first argument, and has none to read). */
  private run(args: string[], maxStdout: number): Promise<RunResult> {
    return this.launcher.git(this.folder, args[0] === "init" ? args : [...STORED_OBJECTS, ...args], maxStdout);
  }
  private async git(args: string[], what: string, maxStdout = 1024 * 1024): Promise<RunResult> {
    const r = await this.run(args, maxStdout);
    if (r.code !== 0) throw fail(what, r);
    return r;
  }
  /** Git whose whole output a check depends on: cut short is an error,
   * never a shorter list. */
  private async gitAll(args: string[], what: string, maxStdout: number): Promise<RunResult> {
    const r = await this.git(args, what, maxStdout);
    if (r.truncated) throw new GitError(`${what} failed: too much output to check.`);
    return r;
  }
  /** Index entries the agent marked skip-worktree or assume-unchanged
   * (which hide a change from status) are unmarked, so every check sees
   * the files as they are. */
  private async reveal() {
    const r = await this.git(["ls-files", "-z", "-v"], "Reading the index", 64 * 1024 * 1024);
    if (r.truncated) throw new GitError("The folder's index is too large to check.");
    // `-v` tags: "S" skip-worktree, lower case assume-unchanged.
    const hidden = r.stdout
      .split("\0")
      .filter((e) => e.length > 2 && (e[0] === "S" || (e[0] >= "a" && e[0] <= "z")))
      .map((e) => e.slice(2));
    // One flag per command: update-index applies only the last one given.
    for (const flag of ["--no-skip-worktree", "--no-assume-unchanged"])
      for (let i = 0; i < hidden.length; i += 100) await this.git(["update-index", flag, "--", ...hidden.slice(i, i + 100)], "Clearing hidden index entries");
  }
  /** A new empty project's folder: a repository with one empty commit on
   * `main`, so every turn's changes have something to be compared with. */
  async createEmpty(name: string, agentId: string): Promise<string> {
    await this.git(["init", "--quiet", "-b", "main"], "Creating the agent folder");
    await this.git([...author(name, agentId), "commit", "--quiet", "--allow-empty", "--no-verify", "-m", "Start"], "The first commit");
    return (await this.head())!;
  }
  /** A GitHub project's clone, filled from the mirror's bundle. An editing
   * agent works on its own `console/` branch; a Look only agent on the base
   * branch, detached. */
  async createFromBundle(bundle: string, base: string, branch: string | null): Promise<string> {
    // Git refuses to fetch into the branch HEAD names, so the empty
    // repository starts on a placeholder that never gets a commit.
    await this.git(["init", "--quiet", "-b", "console-unborn"], "Creating the agent's clone");
    await this.git(["fetch", "--quiet", bundle, `refs/heads/${base}:refs/heads/${base}`], "Filling the clone");
    if (branch) await this.git(["checkout", "--quiet", "-b", branch, base], "Creating the agent's branch");
    else await this.git(["checkout", "--quiet", "--detach", base], "Checking out the base branch");
    return (await this.head())!;
  }
  async head(): Promise<string | null> {
    const r = await this.run(["rev-parse", "--verify", "--quiet", "HEAD"], 4096);
    return r.code === 0 && /^[0-9a-f]{40,64}$/.test(r.stdout.trim()) ? r.stdout.trim() : null;
  }
  /** Commit whatever the turn changed (its own temporary folder aside);
   * null when nothing changed. Run by the worker because Codex's sandbox
   * keeps `.git` read-only. */
  async commitTurn(
    message: string,
    name: string,
    agentId: string,
    options: { unresolved?: "skip" | "throw"; conflicts?: string[]; only?: (path: string) => boolean; since?: string } = {},
  ): Promise<string | null> {
    // A merge from team_pull is committed only once no conflict marker is
    // left in its conflicted files: every file the pull reported,
    // even one the agent has staged since, and any still unmerged. A tab
    // with steps has no team_pull, so there a merge state is ignored.
    const merging = !options.only && (await this.merging());
    if (merging) {
      const marked = await this.markers([...new Set([...(options.conflicts ?? []), ...(await this.unmerged())])]);
      if (marked.length) {
        if (options.unresolved === "skip") return null;
        throw new GitError(`The merge is not finished: conflict markers remain in ${marked.slice(0, 10).join(", ")}. Resolve them, or call team_pull_abort.`);
      }
    }
    const status = await this.git(["status", "--porcelain", "--untracked-files=all", "--", ...EXCLUDE], "Reading the changes", 64 * 1024);
    if (!status.stdout.trim() && !merging) return null;
    if (options.only) {
      // A tab with steps: a merge the step check forgot (`merge --quit`)
      // leaves its conflicted paths unmerged in the index; an allowed one
      // still holding conflict markers is refused as an unfinished merge is.
      const marked = await this.markers((await this.unmerged()).filter(options.only));
      if (marked.length) {
        if (options.unresolved === "skip") return null;
        throw new GitError(`Conflict markers remain in ${marked.slice(0, 10).join(", ")}. Resolve them, and the Console commits the turn's changes.`);
      }
      // The index goes back to HEAD and only the paths the step allows are
      // staged, so nothing else is ever committed (nor a merge's parent).
      await this.git(["merge", "--quit"], "Clearing an unfinished merge");
      await this.git(["reset", "--quiet"], "Clearing the index");
      const paths = (await this.changes()).map((c) => c.path).filter(options.only);
      if (!paths.length) return null;
      for (let i = 0; i < paths.length; i += 100) await this.git(["add", "--all", "--", ...paths.slice(i, i + 100).map((p) => `:(literal)${p}`)], "Adding the changes");
    } else await this.git(["add", "--all", "--", "."], "Adding the changes");
    // The excluded folders' index entries go back to the last commit (an
    // exclude pathspec would make `add` fail on them where the repository
    // ignores them): what
    // the agent staged there is unstaged (the files stay on disk), and
    // files the repository already tracks there are kept, never deleted.
    await this.git(["reset", "--quiet", "--", ...CONSOLE_DIRS], "Clearing the index");
    await this.git([...author(name, agentId), "commit", "--quiet", "--no-verify", "-m", message], "Committing the turn");
    const sha = await this.head();
    // A tab with steps: the commit is checked against where the step's
    // check began, tree to tree, before anything records or pushes it. One
    // that carries a file outside the step is undone (its files stay on
    // disk, to be put back by the next check) and refused. So is a merge
    // commit (a merge the agent opened again after the check).
    if (options.only && sha && (await this.run(["rev-parse", "--verify", "--quiet", `${sha}^2`], 4096)).code === 0) {
      await this.git(["reset", "--quiet", "--soft", `${sha}^1`], "Undoing the commit");
      await this.git(["merge", "--quit"], "Clearing an unfinished merge");
      throw new GitError("The commit would have merged another commit, which a tab with steps never does, so it was undone.");
    }
    if (options.only && options.since && sha) {
      const outside = (await this.diffPaths(options.since, sha)).filter((p) => !options.only!(p));
      if (outside.length) {
        await this.git(["reset", "--quiet", "--soft", options.since], "Undoing the commit");
        throw new GitError(`The commit would have changed ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ` and ${outside.length - 5} more` : ""} outside this step, so it was undone.`);
      }
    }
    return sha;
  }
  /** Every path that differs from HEAD, in the index or on disk (the
   * excluded folders aside), with its two-letter status. */
  private async changes(): Promise<{ code: string; path: string }[]> {
    const status = await this.gitAll(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", ...EXCLUDE], "Reading the changes", 16 * 1024 * 1024);
    return status.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => ({ code: entry.slice(0, 2), path: entry.slice(3) }));
  }
  /** A tab with steps: every path changed since `since` (where
   * the turn began) that `allowed` refuses is put back as it was there,
   * whichever way it was written (a tool that never asked, a command).
   * The agent's own branch (`branch`, the one pushed) is moved back to
   * `since` and checked out again without touching the files, so commits
   * the agent made, on it or on a branch it switched to, are checked as
   * changes too. Putting a file back (a `.gitignore`) can show others, so
   * the changes are read again until none is outside. Returns the paths
   * put back; commitTurn with `only` then stages allowed paths alone. */
  async keepOnly(since: string, branch: string | null, allowed: (path: string) => boolean): Promise<string[]> {
    // A merge, cherry-pick or revert the agent left open would make the
    // Console's commit carry its commit as a parent: forgotten, its files
    // kept as changes (a tab with steps has no team_pull merge to finish).
    for (const op of ["merge", "cherry-pick", "revert"]) await this.git([op, "--quit"], "Clearing an unfinished Git operation");
    await this.reveal();
    if (branch) {
      await this.git(["update-ref", `refs/heads/${branch}`, since], "Undoing the agent's own commits");
      await this.git(["symbolic-ref", "HEAD", `refs/heads/${branch}`], "Returning to the agent's branch");
    } else if ((await this.head()) !== since) await this.git(["reset", "--quiet", "--soft", since], "Undoing the agent's own commits");
    const back = new Set<string>();
    for (let round = 0; round < 5; round++) {
      const outside = (await this.changes()).map((c) => c.path).filter((p) => !allowed(p));
      if (!outside.length) break;
      for (let i = 0; i < outside.length; i += 100) await this.putBack(since, outside.slice(i, i + 100));
      for (const p of outside) back.add(p);
    }
    return [...back];
  }
  /** Paths as they were in `since`: restored where it has them, removed
   * (from the index and the disk) where it does not. */
  private async putBack(since: string, paths: string[]) {
    const literal = (list: string[]) => list.map((p) => `:(literal)${p}`);
    const known = new Set((await this.gitAll(["ls-tree", "-r", "-z", "--name-only", since, "--", ...literal(paths)], "Reading the step's start", 16 * 1024 * 1024)).stdout.split("\0").filter(Boolean));
    const there = paths.filter((p) => known.has(p));
    const added = paths.filter((p) => !known.has(p));
    if (there.length) await this.git(["restore", `--source=${since}`, "--staged", "--worktree", "--", ...literal(there)], "Putting back files outside the step");
    if (added.length) {
      await this.git(["rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--", ...literal(added)], "Putting back files outside the step");
      await this.git(["clean", "-f", "-q", "-x", "--", ...literal(added)], "Putting back files outside the step");
    }
  }
  /** One commit's summary and patch, for the changes view. */
  async show(sha: string, maxBytes: number): Promise<{ stat: string; patch: string; files: string[] }> {
    const stat = await this.git(["show", "--no-color", "--stat", "--format=", sha], "Reading the commit", 64 * 1024);
    // `--text`: every file as text, whatever attributes the agent wrote
    // (`-diff` would show a change as "Binary files differ").
    const patch = await this.git(["show", "--no-color", "--text", "--no-ext-diff", "--no-textconv", "--format=", "--patch", sha], "Reading the commit", maxBytes);
    const names = await this.git(["show", "--no-renames", "--name-only", "-z", "--format=", sha], "Reading the commit", 256 * 1024);
    return { stat: stat.stdout.trim(), patch: patch.truncated ? `${patch.stdout}\n… truncated` : patch.stdout, files: nulList(names.stdout) };
  }
  /** The commits after `from` up to `to` (all of `to`'s when null), newest
   * first, each with its parents. */
  async commitsBetween(from: string | null, to: string): Promise<{ sha: string; parents: string[] }[]> {
    const r = await this.git(["rev-list", "--parents", "--max-count=1000", from ? `${from}..${to}` : to], "Listing commits", 1024 * 1024);
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, ...parents] = l.trim().split(" ");
        return { sha, parents };
      });
  }
  /** Every path that differs between two commits (uncapped). */
  async diffPaths(from: string, to: string): Promise<string[]> {
    const r = await this.gitAll(["diff", "--no-renames", "--name-only", "-z", from, to], "Comparing commits", 16 * 1024 * 1024);
    return r.stdout.split("\0").filter(Boolean);
  }
  /** Every path a commit changed (uncapped, for the claim check). */
  async changedPaths(sha: string): Promise<string[]> {
    const r = await this.gitAll(["show", "--no-renames", "--name-only", "-z", "--format=", sha], "Reading the commit", 16 * 1024 * 1024);
    return r.stdout.split("\0").filter(Boolean);
  }
  /** The branch (at `head`, the commit recorded with it) against its
   * base, for the changes view. */
  async diff(base: string, maxBytes: number, head = "HEAD"): Promise<{ stat: string; patch: string; files: string[] }> {
    const stat = await this.git(["diff", "--no-color", "--stat", base, head], "Comparing with the base", 64 * 1024);
    const patch = await this.git(["diff", "--no-color", "--text", "--no-ext-diff", "--no-textconv", base, head], "Comparing with the base", maxBytes);
    // Exact, untruncated names (the stat abbreviates long paths and renames).
    const names = await this.git(["diff", "--no-renames", "--name-only", "-z", "--diff-filter=d", base, head], "Comparing with the base", 256 * 1024);
    return { stat: stat.stdout.trim(), patch: patch.truncated ? `${patch.stdout}\n… truncated` : patch.stdout, files: nulList(names.stdout) };
  }
  /** Two commits' differences under one claim-style pattern (team_diff,
   * for files past the kept patch's bound): a glob, matched ignoring case. */
  async diffUnder(from: string, to: string, pattern: string, maxBytes: number): Promise<string> {
    const r = await this.git(
      ["diff", "--no-color", "--text", "--no-ext-diff", "--no-textconv", from, to, "--", `:(glob,icase)${pattern}`, ...(pattern.includes("*") ? [] : [`:(glob,icase)${pattern}/**`])],
      "Comparing commits",
      maxBytes,
    );
    return r.truncated ? `${r.stdout}\n… truncated` : r.stdout;
  }
  /** A ref as a bundle inside this clone's own `.git`. */
  async bundle(ref: string, name: string): Promise<string> {
    const path = join(this.folder, ".git", name);
    await this.git(["bundle", "create", "--quiet", path, ref], "Bundling the folder");
    return path;
  }
  /** `ref`'s commits after `since` (all of them when null), as a bundle in
   * this clone's own `.git`. */
  async bundleSince(ref: string, since: string | null, name: string): Promise<string> {
    const path = join(this.folder, ".git", name);
    await this.git(["bundle", "create", "--quiet", path, ref, ...(since ? [`^${since}`] : [])], "Bundling the commit");
    return path;
  }
  async hasCommit(sha: string): Promise<boolean> {
    if (!/^[0-9a-f]{40,64}$/.test(sha)) return false;
    return (await this.run(["cat-file", "-e", `${sha}^{commit}`], 4096)).code === 0;
  }
  /** Fetch a bundle's ref into a ref of this clone. */
  async fetchBundle(bundle: string, ref: string, into: string) {
    await this.git(["fetch", "--quiet", bundle, `+${ref}:${into}`], "Fetching the commit");
  }
  /** A merge (from team_pull) is in progress: Git's own MERGE_HEAD file is
   * there (not a branch or tag of that name). */
  async merging(): Promise<boolean> {
    const r = await this.run(["rev-parse", "--git-path", "MERGE_HEAD"], 4096);
    return r.code === 0 && !!r.stdout.trim() && existsSync(resolve(this.folder, r.stdout.trim()));
  }
  /** Files the merge left unmerged in the index. */
  async unmerged(): Promise<string[]> {
    // Uncapped: every conflicted file is checked for markers.
    const r = await this.gitAll(["diff", "--name-only", "-z", "--diff-filter=U"], "Reading the conflicts", 16 * 1024 * 1024);
    return [...new Set(r.stdout.split("\0").filter(Boolean))];
  }
  /** Which of these files still hold a conflict marker (read as `agent`). */
  async markers(files: string[]): Promise<string[]> {
    if (!files.length) return [];
    const r = await this.launcher.runIn(
      this.folder,
      "/usr/bin/grep",
      // Any marker length (a repository's conflict-marker-size), 7 or more.
      ["-l", "-s", "-E", "^(<{7,}( |$)|={7,}$|>{7,}( |$))", "--", ...files.map((f) => `./${f}`)],
      256 * 1024,
    );
    if (r.truncated) throw new GitError("Reading the conflict markers failed: too much output to check.");
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .map((f) => f.replace(/^\.\//, ""));
  }
  /** Merge a fetched ref into the current branch (a fast-forward when it
   * can). False when it stopped with conflicts. */
  async merge(ref: string, message: string, name: string, agentId: string): Promise<boolean> {
    const r = await this.run([...author(name, agentId), "merge", "--no-edit", "--no-verify", "-m", message, ref], 64 * 1024);
    if (r.code === 0) return true;
    if (await this.merging()) return false;
    throw fail("Merging", r);
  }
  async abortMerge() {
    await this.git(["merge", "--abort"], "Abandoning the merge");
  }
  async setRef(ref: string, sha: string) {
    await this.git(["update-ref", ref, sha], "Recording the commit");
  }
  /** `force`: a Look only reviewer's folder is a mirror of its teammates'
   * commits, so a file of its own in the way of the checkout is
   * overwritten rather than failing the refresh. */
  async checkoutDetached(sha: string, force = false) {
    await this.git(["checkout", "--quiet", "--detach", ...(force ? ["--force"] : []), sha], "Checking out the commit");
  }
  async checkoutNew(branch: string, from: string) {
    await this.git(["checkout", "--quiet", "-b", branch, from], "Creating the agent's branch");
  }
  /** Changes in the folder that are not committed (its temporary folder
   * aside). */
  async dirty(): Promise<boolean> {
    await this.reveal();
    const status = await this.git(["status", "--porcelain", "--untracked-files=all", "--", ...EXCLUDE], "Reading the changes", 64 * 1024);
    return !!status.stdout.trim();
  }
  /** The branch's commit subjects since the base, newest first. */
  async subjects(base: string, branch: string): Promise<string[]> {
    const r = await this.git(["log", "--no-color", "--format=%s", "--max-count=200", `${base}..${branch}`], "Reading the branch", 256 * 1024);
    return r.stdout.split("\n").filter(Boolean);
  }
  /** The commit a branch names right now, so a push can check and send
   * exactly that one. */
  async resolveBranch(branch: string): Promise<string> {
    const r = await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], "Reading the branch", 4096);
    const sha = r.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new GitError(`${branch} has no commit.`);
    return sha;
  }
  /** The agent's branch as a bundle inside its own `.git`, which the owner
   * can read through the `agent` group. */
  async bundleBranch(branch: string): Promise<string> {
    if (!CONSOLE_BRANCH.test(branch)) throw new GitError(`Only console/ branches are pushed, not ${branch}.`);
    const path = join(this.folder, ".git", "console-push.bundle");
    await this.git(["bundle", "create", "--quiet", path, `refs/heads/${branch}`], "Bundling the agent's branch");
    return path;
  }
}
