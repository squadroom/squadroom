import { GitError } from "./git.ts";
import { checkGitHub, type GitHubApi } from "./github-api.ts";

// Preparing a GitHub repository for the Console (`npm run console:prepare-repo`):
// the owner's command, run with the owner's own `gh` sign-in, never the
// Console's token. That token cannot administer the repository, so nothing
// the Console runs can change the ruleset that protects the base branch.

/** The ruleset the worker's check asks for: the base branch by its exact
 * name, no deleting it, no force pushes, changes only through a pull
 * request (no approvals needed). */
export function consoleBaseRuleset(base: string) {
  return {
    name: "Squadroom base",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: [`refs/heads/${base}`], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ["merge", "squash", "rebase"],
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: false,
        },
      },
    ],
  };
}

/**
 * Makes `repo` pass the worker's checks for `base`: creates the branch when
 * it is missing (an empty repository first gets a README, as GitHub needs a
 * commit), adds the "Squadroom base" ruleset unless one already names the
 * branch, then runs the worker's own check. Returns what it did.
 */
export async function prepareRepo(repo: string, base: string, gh: GitHubApi): Promise<string[]> {
  const call = async (method: string, path: string, body?: unknown) => {
    let response: Response;
    try {
      response = await (gh.fetch ?? fetch)(`${gh.url ?? "https://api.github.com"}/repos/${repo}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${gh.token}`,
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new GitError("GitHub could not be reached. Try again in a minute.");
    }
    if (method === "GET" && response.status === 404) return null;
    if (!response.ok) {
      const detail = ((await response.json().catch(() => null)) as { message?: string } | null)?.message;
      throw new GitError(`GitHub answered ${response.status} for ${method} ${path || "/"}${detail ? `: ${detail}` : ""}.`);
    }
    return response.status === 204 ? {} : response.json();
  };
  const done: string[] = [];
  const info = (await call("GET", "")) as { default_branch: string; permissions?: { admin?: boolean } } | null;
  if (!info) throw new GitError(`The repository ${repo} was not found, or your gh sign-in cannot see it.`);
  if (info.permissions && !info.permissions.admin) throw new GitError(`Your gh sign-in is not an admin of ${repo}, so it cannot add a ruleset.`);

  if (!(await call("GET", `/branches/${encodeURIComponent(base)}`))) {
    const branches = (await call("GET", "/branches?per_page=1")) as unknown[];
    if (!branches.length) {
      // An empty repository: its first commit makes the default branch.
      const readme = `# ${repo.split("/")[1]}\n`;
      await call("PUT", "/contents/README.md", { message: "Add README", content: Buffer.from(readme).toString("base64") });
      done.push(`Added README.md, the repository's first commit, on ${info.default_branch}.`);
    }
    if (!(await call("GET", `/branches/${encodeURIComponent(base)}`))) {
      const from = (await call("GET", `/branches/${encodeURIComponent(info.default_branch)}`)) as { commit: { sha: string } } | null;
      if (!from) throw new GitError(`The default branch ${info.default_branch} was not found.`);
      await call("POST", "/git/refs", { ref: `refs/heads/${base}`, sha: from.commit.sha });
      done.push(`Created the branch ${base} from ${info.default_branch}.`);
    }
  }

  const listed = ((await call("GET", "/rulesets?per_page=100")) ?? []) as { id: number }[];
  let named = false;
  for (const summary of listed) {
    const r = (await call("GET", `/rulesets/${summary.id}`)) as { conditions?: { ref_name?: { include?: string[] } } } | null;
    if (r?.conditions?.ref_name?.include?.includes(`refs/heads/${base}`)) named = true;
  }
  if (!named) {
    await call("POST", "/rulesets", consoleBaseRuleset(base));
    done.push(`Added the "Squadroom base" ruleset on refs/heads/${base}.`);
  }

  // The worker's own check, so a ruleset that names the branch but would
  // not pass (a bypass, a missing rule) is reported here, not later.
  await checkGitHub(repo, base, gh);
  return done;
}
