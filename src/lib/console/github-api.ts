import { CONSOLE_BRANCH, GitError } from "./git.ts";

// The Console's GitHub client: the checks a repository must pass, pull
// requests and their review threads (the worker only, with the owner's
// token).

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
/** The GitHub no-reply address of the token's own account, which GitHub
 * (and what deploys from it) recognises as that account's commits; null
 * when GitHub does not say. */
export async function noReplyEmail(gh: GitHubApi): Promise<string | null> {
  const me = await githubCall(gh, "GET", "/user").catch(() => null);
  const { id, login } = (me?.status === 200 ? me.json : {}) as { id?: unknown; login?: unknown };
  return Number.isSafeInteger(id) && typeof login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(login) ? `${id}+${login}@users.noreply.github.com` : null;
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
interface ReviewThread {
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
interface PullRequestReview {
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

// ── Checks ────────────────────────────────────────────────────

const NEEDS_ACTIONS_READ =
  "The GitHub token cannot read this repository's checks. Ask the owner to give it Actions: Read-only for this repository (Settings → Developer settings → Fine-grained tokens).";

/** One job of a GitHub Actions run for a commit. */
export interface CheckJob {
  id: number;
  run: string;
  name: string;
  /** queued, in_progress, completed, … as GitHub says it. */
  status: string;
  /** success, failure, cancelled, skipped, … once completed. */
  conclusion: string | null;
}
/** The most runs of one commit read, and pages of 100 jobs of one run. */
const CHECK_RUNS_MAX = 20;
const CHECK_JOB_PAGES = 3;

/** The GitHub Actions jobs that ran for a commit (read only): each run's
 * latest attempt. `incomplete` when GitHub has more runs or jobs than are
 * read here, so nobody takes the list for all of them. Needs Actions:
 * Read-only on the token. */
export async function readChecks(
  repo: string,
  sha: string,
  gh: GitHubApi,
): Promise<{ jobs: CheckJob[]; incomplete: boolean }> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitError("That is not a commit.");
  const get = async (path: string, what: string) => {
    const r = await githubCall(gh, "GET", `/repos/${repo}/actions/${path}`);
    if (r.status === 401 || r.status === 403 || r.status === 404) throw new GitError(NEEDS_ACTIONS_READ);
    if (r.status !== 200) throw new GitError(`GitHub answered ${r.status} when reading ${what}.`);
    return (r.json ?? {}) as { total_count?: unknown; workflow_runs?: unknown; jobs?: unknown };
  };
  const total = (v: unknown, seen: number) => (typeof v === "number" ? v : seen);
  const runs = await get(`runs?head_sha=${sha}&per_page=${CHECK_RUNS_MAX}`, "the checks");
  const list = (Array.isArray(runs.workflow_runs) ? runs.workflow_runs : []) as { id?: unknown; name?: unknown }[];
  let incomplete = total(runs.total_count, list.length) > list.length;
  const jobs: CheckJob[] = [];
  for (const run of list) {
    if (typeof run.id !== "number") continue;
    let seen = 0;
    for (let page = 1; ; page++) {
      const got = await get(`runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`, "a check's jobs");
      const rows = (Array.isArray(got.jobs) ? got.jobs : []) as Record<string, unknown>[];
      seen += rows.length;
      for (const j of rows) {
        if (typeof j.id !== "number") continue;
        jobs.push({
          id: j.id,
          run: typeof run.name === "string" ? run.name : "",
          name: typeof j.name === "string" ? j.name : "",
          status: typeof j.status === "string" ? j.status : "",
          conclusion: typeof j.conclusion === "string" ? j.conclusion : null,
        });
      }
      const more = total(got.total_count, seen) > seen && rows.length > 0;
      if (!more) break;
      if (page === CHECK_JOB_PAGES) {
        incomplete = true;
        break;
      }
    }
  }
  return { jobs, incomplete };
}

/** The end of one job's log: at most `maxBytes` of it are ever held (the
 * rest is read and dropped as it streams, when the log's host does not
 * honour the range asked for). GitHub answers with a redirect to the log
 * itself, which fetch follows without the token. */
export async function readJobLog(
  repo: string,
  jobId: number,
  maxBytes: number,
  gh: GitHubApi,
): Promise<{ text: string; cut: boolean }> {
  let response: Response;
  try {
    response = await (gh.fetch ?? fetch)(`${gh.url ?? GITHUB_API}/repos/${repo}/actions/jobs/${jobId}/logs`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${gh.token}`, "x-github-api-version": "2022-11-28", range: `bytes=-${maxBytes}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new GitError("GitHub could not be reached.");
  }
  if (response.status === 401 || response.status === 403) throw new GitError(NEEDS_ACTIONS_READ);
  if (response.status === 404 || response.status === 410) throw new GitError("That job's log is not there (not started yet, or expired).");
  if (response.status !== 200 && response.status !== 206) throw new GitError(`GitHub answered ${response.status} when reading the job's log.`);
  // A range answer says how long the whole log is ("bytes 0-9/100").
  const whole = Number(/\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1]);
  const tail: Buffer[] = [];
  let held = 0;
  let read = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      tail.push(Buffer.from(chunk));
      held += chunk.length;
      read += chunk.length;
      // Whole chunks past the limit go; the last one kept is trimmed below.
      while (tail.length > 1 && held - tail[0].length >= maxBytes) held -= tail.shift()!.length;
    }
  } catch {
    throw new GitError("The job's log could not be read to its end (too long, or the connection dropped).");
  }
  const bytes = Buffer.concat(tail);
  return { text: bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString("utf8"), cut: read > maxBytes || (response.status === 206 && whole > read) };
}
