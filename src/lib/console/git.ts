import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { UPLOADS_DIR } from "./files.ts";
import type { Launcher, RunResult } from "./launcher.ts";

// Git for the Console, and its GitHub client: the checks a repository must
// pass, pull requests and their review threads (the worker only, with the
// owner's token).
//
// Two sides that never mix:
// - Owner side: one mirror per GitHub project in
//   `~/.squadroom/console/mirrors/<project>.git`, written only by the
//   worker. The GitHub token lives only here, passed per command as an
//   `http.extraheader` in the environment (never on a command line, never in
//   a file, never to the agent user). The mirror pushes only `console/*`.
// - Agent side: every agent's clone is its own repository, owned by `agent`;
//   all Git there runs through the launcher's sandbox (no hooks, filters,
//   fsmonitor or credential helpers, no network). Commits cross between the
//   two only as bundles: mirror → /opt/console-shared, agent → its own .git.

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/** `owner/name` from a GitHub URL or slug; null when it is not one. */
export function parseRepo(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const text = input.trim().replace(/\/$/, "").replace(/\.git$/, "");
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(text);
  if (!match || match[2] === "." || match[2] === "..") return null;
  return `${match[1]}/${match[2]}`;
}
/** A branch name Git and the Console both accept for a base branch. */
export function validBranch(name: unknown): name is string {
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    !name.endsWith(".")
  );
}
/** The only branches the worker ever pushes. */
export const CONSOLE_BRANCH = /^console\/[a-z0-9][a-z0-9-]{0,80}$/;
/** The most a push's credential check reads (objects not yet on GitHub). */
export const SCAN_BYTES = 100 * 1024 * 1024;
export const SCAN_OBJECTS = 200_000;
export const CREDENTIAL_IN_BRANCH = "The branch contains a credential the Console handed to an agent, so it was not pushed. Remove it from the branch's history first.";
export const CONSOLE_FILES_IN_BRANCH = `The branch's commits add files under ${UPLOADS_DIR} (the owner's uploads) or .console-tmp, so it was not pushed. Remove them from the branch's history first.`;
/** An editing agent's branch: by id, so renaming changes nothing. */
export function consoleBranch(agentId: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return `console/${agentId}${slug ? `-${slug}` : ""}`;
}
/** `-z` output: NUL-separated names. At most 500 are kept. */
const nulList = (out: string) => out.split("\0").filter(Boolean).slice(0, 500);
/** Where a turn's temporary files go inside a Codex clone. */
export const CLONE_TMP = ".console-tmp";
/** Never committed or pushed: a Codex thread's temporary folder and the
 * owner's uploads. */
const CONSOLE_DIRS = [CLONE_TMP, UPLOADS_DIR];
const EXCLUDE = [".", ...CONSOLE_DIRS.map((d) => `:(exclude)${d}`)];

/** GitHub's basic-auth header for a token, kept out of every command line. */
function authHeader(token: string) {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

// ── GitHub checks ───────────────────────────────────────────────────

const GITHUB_API = "https://api.github.com";
/** The owner's GitHub token, and the `fetch` and API address its calls
 * use (tests pass their own). */
export interface GitHubApi {
  token: string;
  fetch?: typeof fetch;
  url?: string;
}

/** Whether a ruleset ref pattern may match a ref. Conservative: `~ALL` and
 * `~DEFAULT_BRANCH` (which can be the base) match, and `*` is allowed to
 * cross `/`, so an exclusion is never underestimated. */
function mayMatchRef(pattern: string, ref: string): boolean {
  if (pattern === "~ALL" || pattern === "~DEFAULT_BRANCH") return true;
  const regex = pattern
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${regex}$`).test(ref);
}

interface Ruleset {
  id: number;
  enforcement?: string;
  target?: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  rules?: { type?: string }[];
  /** Whether the token's own user may bypass it ("never" is the only safe
   * answer: an "always" bypass lets the token push to the base). */
  current_user_can_bypass?: string;
}

/**
 * Before the Console touches a repository: its base branch must exist on
 * GitHub, and an active ruleset must name it exactly (`refs/heads/<base>`,
 * never "the default branch") and block deleting it, force-pushing it and
 * updating it directly, with no bypass for the token's own user.
 */
export async function checkGitHub(repo: string, base: string, gh: GitHubApi) {
  const get = async (path: string) => {
    const r = await githubCall(gh, "GET", `/repos/${repo}${path}`);
    if (r.status === 404) return null;
    if (r.status === 401 || r.status === 403) throw new GitError(`The GitHub token cannot read ${repo} (${r.status}). It needs access to this repository.`);
    if (r.status < 200 || r.status > 299) throw new GitError(`GitHub answered ${r.status} for ${repo}.`);
    return r.json;
  };
  if (!(await get("")))
    throw new GitError(`The repository ${repo} was not found, or the GitHub token cannot see it.`);
  if (!(await get(`/branches/${encodeURIComponent(base)}`)))
    throw new GitError(`The base branch ${base} does not exist on GitHub. Create it first.`);
  const listed = ((await get("/rulesets?includes_parents=true&per_page=100")) ?? []) as Ruleset[];
  for (const summary of listed) {
    const ruleset = (await get(`/rulesets/${summary.id}`)) as Ruleset | null;
    if (!ruleset || ruleset.enforcement !== "active" || (ruleset.target ?? "branch") !== "branch") continue;
    // A ruleset the token's own user may bypass protects nothing from it.
    if (ruleset.current_user_can_bypass !== "never") continue;
    if (!ruleset.conditions?.ref_name?.include?.includes(`refs/heads/${base}`)) continue;
    // An exclusion that matches wins on GitHub, so it must not touch the base.
    if ((ruleset.conditions.ref_name.exclude ?? []).some((p) => mayMatchRef(p, `refs/heads/${base}`))) continue;
    const types = new Set((ruleset.rules ?? []).map((r) => r.type));
    if (types.has("deletion") && types.has("non_fast_forward") && (types.has("update") || types.has("pull_request"))) return;
  }
  throw new GitError(
    `The base branch ${base} is not protected by a ruleset that names it exactly (refs/heads/${base}) and blocks deleting it, force pushes and direct updates, with no bypass for the token's user. Add one on GitHub first.`,
  );
}

// ── Pull requests ─────────────────────────────────────────────

/** One GitHub API call with the owner's token (the worker only). */
async function githubCall(gh: GitHubApi, method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  let response: Response;
  try {
    response = await (gh.fetch ?? fetch)(`${gh.url ?? GITHUB_API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${gh.token}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new GitError("GitHub could not be reached. Try again in a minute.");
  }
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}
const NEEDS_PR_WRITE = "The GitHub token cannot open pull requests here. Give it Pull requests: Read and write for this repository (Settings → Developer settings → Fine-grained tokens).";
/** A pull request call: refused (401, 403, or 404 for a repository the
 * token cannot see), it says what the token needs. */
async function pullRequestCall(gh: GitHubApi, method: "GET" | "POST" | "PATCH", path: string, body?: unknown) {
  const r = await githubCall(gh, method, path, body);
  if (r.status === 401 || r.status === 403 || r.status === 404) throw new GitError(NEEDS_PR_WRITE);
  return r;
}

/**
 * The open pull request from `branch` into `base`, opened now if there is
 * none. An open one gets `update`'s title and description (what the agent
 * wrote this time; the owner's own edits on GitHub are otherwise kept).
 * Returns its number and page, and whether it was opened now.
 */
export async function openPullRequest(
  repo: string,
  pr: { branch: string; base: string; title: string; body: string },
  gh: GitHubApi,
  update: { title?: string; body?: string } = {},
): Promise<{ number: number; url: string; created: boolean; updated: boolean }> {
  const open = await findPullRequest(repo, pr.branch, pr.base, gh);
  if (open) {
    if (!update.title && !update.body) return { ...open, created: false, updated: false };
    const patched = await pullRequestCall(gh, "PATCH", `/repos/${repo}/pulls/${open.number}`, update);
    if (patched.status !== 200) throw new GitError(`GitHub answered ${patched.status} when updating pull request #${open.number}.`);
    return { ...open, created: false, updated: true };
  }
  const made = await pullRequestCall(gh, "POST", `/repos/${repo}/pulls`, { title: pr.title, head: pr.branch, base: pr.base, body: pr.body });
  const created = made.json as { number?: unknown; html_url?: unknown; message?: unknown } | null;
  if (made.status !== 201 || typeof created?.number !== "number" || typeof created.html_url !== "string")
    throw new GitError(`GitHub did not open the pull request (${made.status}${typeof created?.message === "string" ? `: ${created.message.slice(0, 200)}` : ""}).`);
  return { number: created.number, url: created.html_url, created: true, updated: false };
}

/** A GitHub GraphQL call (review threads: their state, replies, resolving). */
async function githubGraphql(gh: GitHubApi, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await githubCall(gh, "POST", "/graphql", { query, variables });
  if (r.status === 401 || r.status === 403) throw new GitError(NEEDS_PR_WRITE);
  const json = r.json as { data?: Record<string, unknown>; errors?: { message?: string }[] } | null;
  if (r.status !== 200 || !json?.data || json.errors?.length)
    throw new GitError(`GitHub answered ${r.status}${json?.errors?.[0]?.message ? `: ${json.errors[0].message.slice(0, 200)}` : ""}.`);
  return json.data;
}

/** One review thread on a pull request (team_pr). */
export interface ReviewThread {
  id: string;
  resolved: boolean;
  outdated: boolean;
  path: string | null;
  line: number | null;
  comments: { author: string; body: string; createdAt: string; bot: boolean }[];
  /** Replies past the ones read. */
  moreComments?: number;
}
/** What team_pr reads: the pull request, its review threads and
 * its conversation. */
export interface PullRequestReview {
  number: number;
  url: string;
  title: string;
  state: string;
  headSha: string;
  threads: ReviewThread[];
  comments: { author: string; body: string; createdAt: string; bot: boolean }[];
  /** More threads than were read (past THREAD_PAGES pages). */
  moreThreads?: boolean;
  /** More conversation comments than were read. */
  moreConversation?: boolean;
}

/** The open pull request for a console/ branch, or null. */
export async function findPullRequest(repo: string, branch: string, base: string, gh: GitHubApi): Promise<{ number: number; url: string } | null> {
  if (!CONSOLE_BRANCH.test(branch)) throw new GitError(`Only console/ branches have pull requests here, not ${branch}.`);
  const owner = repo.split("/")[0];
  const found = await pullRequestCall(gh, "GET", `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}`);
  if (found.status !== 200) throw new GitError(`GitHub answered ${found.status} when looking for the pull request.`);
  const open = Array.isArray(found.json) ? (found.json[0] as { number?: unknown; html_url?: unknown } | undefined) : undefined;
  return open && typeof open.number === "number" && typeof open.html_url === "string" ? { number: open.number, url: open.html_url } : null;
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number url title state headRefOid
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved isOutdated path line comments(first: 20) { totalCount nodes { author { login __typename } body createdAt } } }
      }
    }
  }
}`;
const CONVERSATION_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { author { login __typename } body createdAt } }
    }
  }
}`;
const THREAD_COMMENTS_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { author { login __typename } body createdAt } } } }
}`;
/** Pages read at most, 100 items each: review threads, the conversation,
 * one thread's replies. */
const THREAD_PAGES = 10;
const CONVERSATION_PAGES = 10;
const REPLY_PAGES = 10;
type Node = { author?: { login?: string; __typename?: string } | null; body?: string; createdAt?: string };
type Conn = { nodes?: Record<string, unknown>[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } | undefined;
const comment = (c: Node) => ({
  author: c.author?.login ?? "ghost",
  body: String(c.body ?? ""),
  createdAt: String(c.createdAt ?? ""),
  // GraphQL names an app "vercel", not "vercel[bot]": its type says it.
  bot: c.author?.__typename === "Bot",
});
/** Every page of a connection, up to `max` pages; `more` when some remain. */
async function allPages(page: (after: string | null) => Promise<Conn>, max: number): Promise<{ nodes: Record<string, unknown>[]; more: boolean }> {
  const nodes: Record<string, unknown>[] = [];
  let after: string | null = null;
  for (let i = 0; i < max; i++) {
    const conn = await page(after);
    nodes.push(...(conn?.nodes ?? []));
    if (!(conn?.pageInfo?.hasNextPage === true && conn.pageInfo.endCursor)) return { nodes, more: false };
    after = conn.pageInfo.endCursor;
  }
  return { nodes, more: true };
}

/** A pull request's review threads and whole conversation (read only).
 * Conversation comments are in order from the first, so their numbers
 * stay the same from one read to the next. */
export async function readPullRequest(repo: string, number: number, gh: GitHubApi): Promise<PullRequestReview> {
  const [owner, name] = repo.split("/");
  let pr: Record<string, unknown> | undefined;
  const pull = (data: Record<string, unknown>) => {
    const got = (data.repository as { pullRequest?: Record<string, unknown> } | null)?.pullRequest;
    if (!got) throw new GitError(`Pull request #${number} was not found in ${repo}.`);
    return got;
  };
  const threadPages = await allPages(async (after) => {
    const got = pull(await githubGraphql(gh, THREADS_QUERY, { owner, name, number, after }));
    pr ??= got;
    return got.reviewThreads as Conn;
  }, THREAD_PAGES);
  const talk = await allPages(async (after) => pull(await githubGraphql(gh, CONVERSATION_QUERY, { owner, name, number, after })).comments as Conn, CONVERSATION_PAGES);
  if (!pr) throw new GitError(`Pull request #${number} was not found in ${repo}.`);
  const threads = threadPages.nodes.map((t) => {
    const c = t.comments as { nodes?: Node[]; totalCount?: number } | undefined;
    const shown = (c?.nodes ?? []).map(comment);
    return {
      id: String(t.id),
      resolved: t.isResolved === true,
      outdated: t.isOutdated === true,
      path: typeof t.path === "string" ? t.path : null,
      line: typeof t.line === "number" ? t.line : null,
      comments: shown,
      // Replies past the first 20 are counted, so the answer says so.
      moreComments: Math.max(0, (c?.totalCount ?? shown.length) - shown.length),
    };
  });
  return {
    number: Number(pr.number),
    url: String(pr.url),
    title: String(pr.title),
    state: String(pr.state),
    headSha: String(pr.headRefOid),
    threads,
    moreThreads: threadPages.more,
    comments: (talk.nodes as Node[]).map(comment),
    moreConversation: talk.more,
  };
}

/** Every reply in one review thread (team_pr(thread: id)). */
export async function readReviewThreadComments(threadId: string, gh: GitHubApi) {
  const got = await allPages(async (after) => {
    const data = await githubGraphql(gh, THREAD_COMMENTS_QUERY, { id: threadId, after });
    return (data.node as { comments?: Conn } | null)?.comments;
  }, REPLY_PAGES);
  return { comments: (got.nodes as Node[]).map(comment), more: got.more };
}

/** The pull request a review thread belongs to, as `owner/name#number`. */
export async function reviewThreadOwner(threadId: string, gh: GitHubApi): Promise<string | null> {
  const data = await githubGraphql(gh, "query($id: ID!) { node(id: $id) { ... on PullRequestReviewThread { pullRequest { number repository { nameWithOwner } } } } }", {
    id: threadId,
  });
  const pr = (data.node as { pullRequest?: { number?: number; repository?: { nameWithOwner?: string } } } | null)?.pullRequest;
  return pr?.number && pr.repository?.nameWithOwner ? `${pr.repository.nameWithOwner.toLowerCase()}#${pr.number}` : null;
}

/** Reply in a review thread, and resolve it when asked. A failed resolve
 * after a posted reply is reported, not thrown, so a retry never posts the
 * reply twice. */
export async function replyToReviewThread(threadId: string, body: string, resolve: boolean, gh: GitHubApi): Promise<{ resolveError: string | null }> {
  await githubGraphql(
    gh,
    "mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } } }",
    { id: threadId, body },
  );
  if (!resolve) return { resolveError: null };
  try {
    await githubGraphql(gh, "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }", { id: threadId });
    return { resolveError: null };
  } catch (error) {
    return { resolveError: error instanceof Error ? error.message : String(error) };
  }
}

/** A comment on a pull request (the Codex review request). */
export async function commentOnPullRequest(repo: string, number: number, text: string, gh: GitHubApi) {
  const r = await pullRequestCall(gh, "POST", `/repos/${repo}/issues/${number}/comments`, { body: text });
  if (r.status !== 201) throw new GitError(`GitHub answered ${r.status} to the comment.`);
}

// ── The owner's mirror ────────────────────────────────────────────────────

/** Git as the owner in the mirror: no global or system configuration (no
 * credential helpers or hooks of the owner's), and the token only as an
 * extra header in this process's environment. */
function ownerSpawn(args: string[], token: string | null, cwd: string | undefined, stdin: "ignore" | "pipe") {
  const config: [string, string][] = [
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
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
const fail = (what: string, r: RunResult, token?: string | null) => {
  let detail = r.stderr.split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 400);
  if (token) detail = detail.split(token).join("[redacted]");
  return new GitError(`${what} failed${detail ? `: ${detail}` : ` (exit ${r.code})`}`);
};

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

// ── The agent's clone (as `agent`, through the launcher) ──────────────────

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
