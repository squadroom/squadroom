import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { UPLOADS_DIR } from "./files.ts";
import { CONSOLE_BRANCH, CONSOLE_DIRS, fail, GitError } from "./git.ts";
import type { RunResult } from "./launcher.ts";

// The owner's mirror of a GitHub project: where the worker fetches from
// GitHub and pushes to it, and the checks before a push.
//
// Two sides that never mix:
// - Owner side (this file): one mirror per GitHub project in
//   `~/.squadroom/console/mirrors/<project>.git`, written only by the
//   worker. The GitHub token lives only here, passed per command as an
//   `http.extraheader` in the environment (never on a command line, never in
//   a file, never to the agent user). The mirror pushes only `console/*`.
// - Agent side (clone.ts): every agent's clone is its own repository,
//   owned by `agent`; all Git there runs through the launcher's sandbox
//   (no hooks, filters, fsmonitor or credential helpers, no network).
//   Commits cross between the two only as bundles: mirror →
//   /opt/console-shared, agent → its own .git.

/** The most a push's credential check reads (objects not yet on GitHub). */
export const SCAN_BYTES = 100 * 1024 * 1024;
export const SCAN_OBJECTS = 200_000;
export const CREDENTIAL_IN_BRANCH = "The branch contains a credential the Console handed to an agent, so it was not pushed. Remove it from the branch's history first.";
export const CONSOLE_FILES_IN_BRANCH = `The branch's commits add files under ${UPLOADS_DIR} (the owner's uploads) or .console-tmp, so it was not pushed. Remove them from the branch's history first.`;

/** GitHub's basic-auth header for a token, kept out of every command line. */
function authHeader(token: string) {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

/** Git as the owner in the mirror: no global or system configuration (no
 * credential helpers or hooks of the owner's), and the token only as an
 * extra header in this process's environment. */
function ownerSpawn(args: string[], token: string | null, cwd: string | undefined, stdin: "ignore" | "pipe") {
  const config: [string, string][] = [
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    // No background maintenance racing the next command (NO_AUTO_MAINTENANCE).
    ["maintenance.auto", "false"],
    ["credential.helper", ""],
    ["core.commitGraph", "false"],
    ["core.useReplaceRefs", "false"],
    ...(token ? ([["http.https://github.com/.extraheader", authHeader(token)]] as [string, string][]) : []),
  ];
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    LANG: "en_US.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    // Objects as they are stored: no replace refs and no grafts.
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null",
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return spawn("git", args, { cwd, env: env as NodeJS.ProcessEnv, stdio: [stdin, "pipe", "pipe"] });
}
function ownerGit(args: string[], token: string | null, cwd?: string, timeoutMs = 300_000, maxStdout = 64_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = ownerSpawn(args, token, cwd, "ignore");
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout!.on("data", (c: Buffer) => {
      if (stdout.length < maxStdout) stdout += c.toString("utf8");
      else truncated = true;
    });
    child.stderr!.on("data", (c: Buffer) => {
      if (stderr.length < 8_000) stderr += c.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: e.message, truncated, bytes: Buffer.alloc(0) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr: stderr.trim(), truncated, bytes: Buffer.from(stdout) });
    });
  });
}

/** Whether a file starts as a Git bundle does (version 2 or 3). */
function isBundle(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const head = Buffer.alloc(16);
    const n = readSync(fd, head, 0, 16, 0);
    return /^# v[23] git bundle\n$/.test(head.subarray(0, n).toString("latin1"));
  } finally {
    closeSync(fd);
  }
}

export class Mirror {
  readonly dir: string;
  readonly repo: string;
  private url: string;
  constructor(dir: string, repo: string, url = `https://github.com/${repo}.git`) {
    this.dir = dir;
    this.repo = repo;
    this.url = url;
  }
  /** Clone the mirror the first time, then bring it up to date. */
  async update(token: string) {
    if (!existsSync(join(this.dir, "HEAD"))) {
      mkdirSync(dirname(this.dir), { recursive: true, mode: 0o700 });
      rmSync(this.dir, { recursive: true, force: true });
      const r = await ownerGit(["clone", "--mirror", "--quiet", this.url, this.dir], token);
      if (r.code !== 0) throw fail(`Cloning ${this.repo}`, r, token);
      return;
    }
    const r = await ownerGit(["fetch", "--prune", "--quiet", this.url, "+refs/heads/*:refs/heads/*"], token, this.dir);
    if (r.code !== 0) throw fail(`Fetching ${this.repo}`, r, token);
  }
  /** The mirror's size, the most a new clone of it needs. */
  async size(): Promise<number> {
    const r = await ownerGit(["count-objects", "-v"], null, this.dir);
    if (r.code !== 0) return 0;
    const kib = (key: string) => Number(new RegExp(`^${key}: (\\d+)$`, "m").exec(r.stdout)?.[1] ?? 0);
    return (kib("size") + kib("size-pack")) * 1024;
  }
  /** The base branch as a bundle the agent user can read. */
  async bundleBase(base: string, path: string) {
    rmSync(path, { force: true });
    const r = await ownerGit(["bundle", "create", "--quiet", path, `refs/heads/${base}`], null, this.dir);
    if (r.code !== 0) throw fail("Bundling the base branch", r);
    chmodSync(path, 0o640);
  }
  /** GitHub has this commit, as far as the mirror knows: it is reachable
   * from a branch (the mirror's branches change only by fetching from
   * GitHub or by a push that succeeded), not merely stored. */
  async hasCommit(sha: string): Promise<boolean> {
    if (!/^[0-9a-f]{40,64}$/.test(sha) || !existsSync(join(this.dir, "HEAD"))) return false;
    const r = await ownerGit(["for-each-ref", "--count=1", "--format=%(refname)", "--contains", sha, "refs/heads/"], null, this.dir);
    return r.code === 0 && !!r.stdout.trim();
  }
  /** The agent's branch from its bundle, under a waiting ref of the mirror
   * (the mirror's branches only ever show what GitHub holds; the cleanup
   * relies on it). Returns the commit staged; with `sha`, it must be that
   * commit: the bundle and the ref are the agent's, so what was checked is
   * bound here, on the owner's side, to what is pushed. */
  async stage(bundle: string, branch: string, sha: string | null = null): Promise<string> {
    if (!CONSOLE_BRANCH.test(branch)) throw new GitError(`Only console/ branches are pushed, not ${branch}.`);
    // A bundle, never a file Git would read another way (a `gitdir:` file
    // makes a fetch read that repository), holding the branch alone.
    if (!isBundle(bundle)) throw new GitError("The agent's bundle is not a Git bundle, so nothing was pushed.");
    const heads = await ownerGit(["bundle", "list-heads", bundle], null, this.dir);
    const listed = heads.stdout.split("\n").filter(Boolean);
    if (heads.code !== 0 || heads.truncated || listed.length !== 1 || listed[0].split(" ")[1] !== `refs/heads/${branch}`)
      throw new GitError("The agent's bundle does not hold its branch alone, so nothing was pushed.");
    const incoming = `refs/console/incoming/${branch}`;
    // No tags: nothing of the agent's may join what counts as GitHub's.
    const r = await ownerGit(["fetch", "--quiet", "--no-tags", bundle, `+refs/heads/${branch}:${incoming}`], null, this.dir);
    if (r.code !== 0) throw fail("Reading the agent's branch", r);
    const at = await ownerGit(["rev-parse", "--verify", "--quiet", `${incoming}^{commit}`], null, this.dir);
    const staged = at.stdout.trim();
    if (at.code !== 0 || !/^[0-9a-f]{40,64}$/.test(staged)) throw fail("Reading the agent's branch", at);
    if (sha && staged !== sha) throw new GitError("The branch moved while it was being pushed, so nothing was pushed. Push again.");
    return staged;
  }
  /**
   * The credential check before a push: every object reachable from `sha`
   * that the mirror's branches (fetched from GitHub, or pushed there) do not
   * reach is read whole and given to `holds`. That is commits with their
   * messages, trees with their names, and blobs as raw bytes, whatever a
   * patch would show of them. The
   * baseline is the mirror's, never a ref in the agent's clone. Too much to
   * read, or an object that cannot be read, is an error, never a pass.
   */
  async scanNew(sha: string, holds: (bytes: Buffer) => boolean, bounds = { bytes: SCAN_BYTES, objects: SCAN_OBJECTS }) {
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new GitError("Not a commit.");
    const tooLarge = new GitError("The branch is too large to check for credentials before a push.");
    const list = await ownerGit(["rev-list", "--objects", sha, "--not", "--branches"], null, this.dir, 300_000, 32 * 1024 * 1024);
    if (list.code !== 0) throw fail("Listing the branch's objects", list);
    if (list.truncated) throw tooLarge;
    const ids = list.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ")[0]);
    if (ids.length > bounds.objects) throw tooLarge;
    if (ids.some((id) => !/^[0-9a-f]{40,64}$/.test(id))) throw new GitError("Listing the branch's objects failed.");
    if (!ids.length) return;
    await new Promise<void>((resolve, reject) => {
      const child = ownerSpawn(["cat-file", "--batch"], null, this.dir, "pipe");
      let stderr = "";
      // Between objects: the bytes not yet read as a header. Inside an
      // object: its chunks, joined once when it is complete (never copied
      // chunk by chunk, so a large blob costs its size, not its square).
      let pending: Buffer = Buffer.alloc(0);
      let parts: Buffer[] = [];
      let have = 0;
      let want: number | null = null;
      let seen = 0;
      let total = 0;
      let done = false;
      const end = (error: Error | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) child.kill("SIGKILL");
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => end(tooLarge), 600_000);
      const read = () => {
        for (;;) {
          if (want === null) {
            const nl = pending.indexOf(10);
            if (nl < 0) return;
            const header = pending.subarray(0, nl).toString("utf8");
            const rest = pending.subarray(nl + 1);
            pending = Buffer.alloc(0);
            const [, type, size] = header.split(" ");
            if (!type || type === "missing" || type === "ambiguous" || !/^\d+$/.test(size ?? ""))
              return end(new GitError("Reading the branch's objects failed: an object could not be read."));
            want = Number(size);
            total += want;
            if (total > bounds.bytes) return end(tooLarge);
            parts = rest.length ? [rest] : [];
            have = rest.length;
          }
          // The object's bytes and the newline after them.
          if (have < want + 1) return;
          const joined = parts.length === 1 ? parts[0] : Buffer.concat(parts, have);
          const content = joined.subarray(0, want);
          pending = joined.subarray(want + 1);
          parts = [];
          have = 0;
          want = null;
          seen++;
          if (holds(content)) return end(new GitError(CREDENTIAL_IN_BRANCH));
        }
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        if (done) return;
        if (want === null) pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        else {
          parts.push(chunk);
          have += chunk.length;
        }
        read();
      });
      child.stderr!.on("data", (c: Buffer) => {
        if (stderr.length < 8_000) stderr += c.toString("utf8");
      });
      child.on("error", (e) => end(new GitError(`Reading the branch's objects failed: ${e.message}`)));
      child.on("close", (code) => {
        if (done) return;
        if (code !== 0 || seen !== ids.length || pending.length)
          return end(new GitError(`Reading the branch's objects failed: ${stderr.trim().slice(0, 400) || `${seen} of ${ids.length} read`}`));
        end(null);
      });
      child.stdin!.on("error", () => {});
      child.stdin!.end(`${ids.join("\n")}\n`);
    });
  }
  /** Whether a commit GitHub does not have yet (by the mirror's branches)
   * adds or changes a file in the folders never pushed: the owner's
   * uploads and a Codex thread's temporary files, which an agent's own
   * `git add -f` could commit. */
  async addsConsoleFiles(sha: string): Promise<boolean> {
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new GitError("Not a commit.");
    const r = await ownerGit(
      ["log", "-m", "--no-renames", "--diff-filter=d", "--name-only", "-z", "--format=", sha, "--not", "--branches", "--", ...CONSOLE_DIRS],
      null,
      this.dir,
      300_000,
      4096,
    );
    if (r.code !== 0) throw fail("Reading the branch's files", r);
    return r.truncated || !!r.stdout.replace(/\0/g, "").trim();
  }
  /** Push the staged commit, by its exact id, as the branch. */
  async pushStaged(branch: string, sha: string, token: string) {
    if (!CONSOLE_BRANCH.test(branch)) throw new GitError(`Only console/ branches are pushed, not ${branch}.`);
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new GitError("Not a commit.");
    const ref = `refs/heads/${branch}`;
    let r = await ownerGit(["push", "--quiet", this.url, `+${sha}:${ref}`], token, this.dir);
    if (r.code !== 0) throw fail(`Pushing ${branch}`, r, token);
    r = await ownerGit(["update-ref", ref, sha], null, this.dir);
    if (r.code !== 0) throw fail("Recording the push", r);
  }
  /** Drop the waiting ref (always, after a push or its failure). */
  async unstage(branch: string) {
    await ownerGit(["update-ref", "-d", `refs/console/incoming/${branch}`], null, this.dir);
  }
}
