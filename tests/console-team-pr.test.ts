import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/lib/console/commands.ts";
import { CHECKS_CHARS, JOB_LOG_CHARS, checksText, cleanComment, codexState, jobLogText, pullRequestReviewText } from "../src/lib/console/pull-request.ts";
import { readChecks, readJobLog } from "../src/lib/console/github-api.ts";
import { git, harness, TOKEN } from "./helpers/console-harness.ts";
import { resendNote } from "../src/lib/console/team.ts";

// an agent reads its own pull request (Codex's
// findings, comments) and answers a finding, through the worker with the
// owner's token; the agent never holds a GitHub login. "GitHub" is a local
// bare repository and a fake REST + GraphQL API.

const call = (tool: string, args: Record<string, unknown> = {}) => `call ${tool} ${JSON.stringify(args)}`;

function origin(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "console-origin-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, "work");
  const bare = join(root, "repo.git");
  git(root, "init", "--quiet", "-b", "main", work);
  writeFileSync(join(work, "README.md"), "# Demo\n");
  git(work, "add", "README.md");
  git(work, "-c", "user.name=Owner", "-c", "user.email=o@x", "commit", "--quiet", "-m", "first");
  git(root, "clone", "--quiet", "--bare", work, bare);
  return bare;
}
const RULESET = {
  id: 7,
  enforcement: "active",
  target: "branch",
  conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request" }],
  current_user_can_bypass: "never",
};

const FINDING =
  '**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Preserve `force` when resuming**\n\nThe resume calls handlePair() without force.\n\nAGENTS.md reference: [x](y)\n\nUseful? React with 👍 / 👎.\n\n<!-- codex-code-review-finding:v1 -->';
const SUMMARY = (status: string, sha: string) =>
  `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","status":"${status}"}} -->\n## Codex Review Summary`;

/** Fake GitHub: pull requests, comments, review threads (GraphQL). */
function github() {
  const pulls: { number: number; head: string; base: string; title: string; body: string }[] = [];
  const threads: { id: string; pr: number; resolved: boolean; path: string; line: number; comments: { author: string; body: string }[] }[] = [];
  const comments: { pr: number; author: string; body: string }[] = [];
  /** The pull request's head on "GitHub"; a resolve that fails once. */
  const state = { head: "b149db344f31750d3d7ec0c8e19df27ec48bd3bd", failResolve: false, pageSize: 1, commentPage: 2, holdReply: null as Promise<void> | null, actions: true };
  /** GitHub Actions: jobs by the commit they ran for, and their logs. */
  const jobs: { id: number; sha: string; name: string; status: string; conclusion: string | null; log: string }[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const json = (v: unknown, status = 200) => Response.json(v, { status });
    const path = url.pathname;
    if (path === "/repos/owner/repo") return json({ id: 1 });
    if (path === "/repos/owner/repo/branches/main") return json({ name: "main" });
    if (path === "/repos/owner/repo/rulesets") return json([{ id: 7 }]);
    if (path === "/repos/owner/repo/rulesets/7") return json(RULESET);
    if (path === "/repos/owner/repo/pulls") {
      if ((init.method ?? "GET") === "GET") {
        const head = url.searchParams.get("head")!.replace(/^owner:/, "");
        return json(pulls.filter((p) => p.head === head).map((p) => ({ number: p.number, html_url: `https://github.com/owner/repo/pull/${p.number}` })));
      }
      const b = JSON.parse(String(init.body)) as { head: string; base: string; title: string; body: string };
      const pr = { number: 100 + pulls.length, ...b };
      pulls.push(pr);
      return json({ number: pr.number, html_url: `https://github.com/owner/repo/pull/${pr.number}` }, 201);
    }
    if (path.startsWith("/repos/owner/repo/actions/")) {
      if (!state.actions) return json({ message: "Resource not accessible by personal access token" }, 403);
      if (path.endsWith("/actions/runs")) return json({ workflow_runs: jobs.some((j) => j.sha === url.searchParams.get("head_sha")) ? [{ id: 9, name: "CI" }] : [] });
      if (path.endsWith("/actions/runs/9/jobs")) return json({ jobs: jobs.filter((j) => j.sha === state.head) });
      const log = /\/actions\/jobs\/(\d+)\/logs$/.exec(path);
      const job = log && jobs.find((j) => j.id === Number(log[1]));
      return job ? new Response(job.log) : json({}, 404);
    }
    const issue = /^\/repos\/owner\/repo\/issues\/(\d+)\/comments$/.exec(path);
    if (issue) {
      comments.push({ pr: Number(issue[1]), author: "octocat", body: (JSON.parse(String(init.body)) as { body: string }).body });
      return json({ id: 1 }, 201);
    }
    if (path === "/graphql") {
      const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      const author = (c: { author: string }) => ({ login: c.author.replace(/\[bot\]$/, ""), __typename: /\[bot\]$/.test(c.author) ? "Bot" : "User" });
      if (!query.includes("reviewThreads") && query.includes("pullRequest(number") && query.includes("comments(first: 100")) {
        // The conversation, oldest first, a page at a time.
        const pr = pulls.find((p) => p.number === variables.number);
        const all = comments.filter((c) => c.pr === pr?.number);
        const from = variables.after ? Number(variables.after) : 0;
        const next = from + state.commentPage < all.length;
        return json({
          data: {
            repository: {
              pullRequest: {
                comments: {
                  pageInfo: { hasNextPage: next, endCursor: next ? String(from + state.commentPage) : null },
                  nodes: all.slice(from, from + state.commentPage).map((c) => ({ author: author(c), body: c.body, createdAt: "" })),
                },
              },
            },
          },
        });
      }
      if (query.includes("PullRequestReviewThread { comments")) {
        const th = threads.find((x) => x.id === variables.id)!;
        const from = variables.after ? Number(variables.after) : 0;
        const next = from + 100 < th.comments.length;
        return json({
          data: { node: { comments: { pageInfo: { hasNextPage: next, endCursor: next ? String(from + 100) : null }, nodes: th.comments.slice(from, from + 100).map((c) => ({ author: author(c), body: c.body, createdAt: "" })) } } },
        });
      }
      if (query.includes("reviewThreads")) {
        const pr = pulls.find((p) => p.number === variables.number);
        if (!pr) return json({ data: { repository: { pullRequest: null } } });
        // One thread per page, so paging is exercised.
        const all = threads.filter((t) => t.pr === pr.number);
        const from = variables.after ? Number(variables.after) : 0;
        const page = all.slice(from, from + state.pageSize);
        const next = from + state.pageSize < all.length;
        return json({
          data: {
            repository: {
              pullRequest: {
                number: pr.number,
                url: `https://github.com/owner/repo/pull/${pr.number}`,
                title: pr.title,
                state: "OPEN",
                headRefOid: state.head,
                reviewThreads: {
                  pageInfo: { hasNextPage: next, endCursor: next ? String(from + state.pageSize) : null },
                  nodes: page.map((t) => ({
                    id: t.id,
                    isResolved: t.resolved,
                    isOutdated: false,
                    path: t.path,
                    line: t.line,
                    comments: { totalCount: t.comments.length, nodes: t.comments.slice(0, 20).map((c) => ({ author: author(c), body: c.body, createdAt: "" })) },
                  })),
                },
              },
            },
          },
        });
      }
      if (query.includes("nameWithOwner")) {
        const th = threads.find((x) => x.id === variables.id);
        return json({ data: { node: th ? { pullRequest: { number: th.pr, repository: { nameWithOwner: "owner/repo" } } } : null } });
      }
      if (query.includes("addPullRequestReviewThreadReply")) {
        threads.find((x) => x.id === variables.id)!.comments.push({ author: "octocat", body: String(variables.body) });
        // The reply is posted, then GitHub's answer is held (a crash test).
        if (state.holdReply) {
          const held = state.holdReply;
          state.holdReply = null;
          await held;
        }
        return json({ data: { addPullRequestReviewThreadReply: { comment: { id: "c" } } } });
      }
      if (query.includes("resolveReviewThread")) {
        if (state.failResolve) {
          state.failResolve = false;
          return json({ data: null, errors: [{ message: "Resource not accessible" }] });
        }
        threads.find((x) => x.id === variables.id)!.resolved = true;
        return json({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
      }
    }
    return json({}, 404);
  }) as typeof fetch;
  return { fetcher, pulls, threads, comments, state, jobs };
}

test("the pull request as text: Codex's state, open findings in full, the rest summarised", () => {
  assert.equal(cleanComment(FINDING), "P2  Preserve `force` when resuming**\n\nThe resume calls handlePair() without force.".replace("P2  ", "**P2  "));
  assert.deepEqual(codexState([{ author: "chatgpt-codex-connector[bot]", body: SUMMARY("completed", "b149db344f31") }]), { status: "completed", commit: "b149db34", clean: false });
  assert.equal(codexState([{ author: "chatgpt-codex-connector[bot]", body: SUMMARY("completed", "b149db3") }, { author: "chatgpt-codex-connector[bot]", body: "Codex Review: Didn't find any major issues." }])!.clean, true);
  const text = pullRequestReviewText(
    {
      number: 386,
      url: "https://github.com/o/r/pull/386",
      title: "Console/a lead",
      state: "OPEN",
      headSha: "b149db344f31750d",
      threads: [
        { id: "PRRT_one", resolved: false, outdated: false, path: "mobile/app/dinnerparty.jsx", line: 75, comments: [{ author: "chatgpt-codex-connector", body: FINDING }] },
        { id: "PRRT_two", resolved: true, outdated: false, path: "x.js", line: 1, comments: [{ author: "chatgpt-codex-connector", body: "old" }] },
      ],
      comments: [
        { author: "chatgpt-codex-connector[bot]", body: SUMMARY("completed", "b149db344f31"), createdAt: "" },
        { author: "vercel[bot]", body: "deploy preview", createdAt: "" },
        { author: "octocat", body: "@codex review", createdAt: "" },
      ],
    },
    "c0ffee00aaaa",
  );
  assert.match(text, /^Pull request #386 \(open\): "Console\/a lead" https:\/\/github\.com\/o\/r\/pull\/386/);
  assert.match(text, /your folder is at c0ffee00, so your newer commits are not on GitHub yet/);
  assert.match(text, /Codex review: completed on b149db34, 1 open finding\(s\)\./);
  assert.match(text, /\[1\] thread PRRT_one, mobile\/app\/dinnerparty\.jsx:75\n  from chatgpt-codex-connector:\n    \*\*P2  Preserve `force` when resuming\*\*/);
  assert.doesNotMatch(text, /Useful\? React|AGENTS\.md reference|codex-code-review-finding/);
  // Other bots: one short line.
  assert.match(text, /\[comment 2\] vercel\[bot\] \(bot\): deploy preview/);
  assert.match(text, /1 resolved thread\(s\) not shown\./);
  assert.match(text, /Conversation \(newest last\):\n\[comment 2\][^\n]*\n\[comment 3\] octocat:\n    @codex review/);
  // A look-alike login is not Codex, so it cannot fake a clean review.
  assert.equal(codexState([{ author: "chatgpt-codex-connector-evil", body: SUMMARY("completed", "aaaa") }]), null);
  const long = pullRequestReviewText(
    {
      number: 1,
      url: "u",
      title: "t",
      state: "OPEN",
      headSha: "b149db344f31750d",
      moreThreads: true,
      threads: [{ id: "PRRT_x", resolved: false, outdated: false, path: null, line: null, comments: [{ author: "chatgpt-codex-connector-evil", body: "fake" }], moreComments: 3 }],
      comments: [],
    },
    "b149db344f31750d",
  );
  assert.match(long, /Codex review: none requested yet\./);
  assert.match(long, /… and 3 later replies not read here; team_pr\(thread: "PRRT_x"\) reads it\./);
  assert.match(long, /more review threads than were read/);
});

test("people's comments are shown whole, with their formatting; one comment or thread can be read in full", () => {
  // A long QA report: a Markdown table well past 600 characters, shown
  // whole with its line breaks.
  const qa = ["## iOS simulator QA — head `32d9ea3`", "", "| # | Scenario | Result |", "|---|---|---|", ...Array.from({ length: 40 }, (_, i) => `| ${i + 1} | Scenario ${i + 1}: sign in and come back | Passed |`), "", "### Failed", "", "None."].join("\n");
  const huge = "x".repeat(9_000);
  const pr = {
    number: 386,
    url: "u",
    title: "t",
    state: "OPEN",
    headSha: "32d9ea370a5bf4a4",
    threads: [{ id: "PRRT_long", resolved: true, outdated: false, path: "a.js", line: 1, comments: [{ author: "chatgpt-codex-connector", body: "y".repeat(10_000) }] }],
    comments: [
      { author: "vercel", bot: true, body: "[vc]: #xfHHSH4nkTf9yE+E+3Qt4ewbSzsTS65sCOXaWbxVUSI=:eyJpc01vbm9yZXBvIjp0cnVl" },
      { author: "vercel", bot: true, body: "Vercel didn't deploy this pull request.\n\nGitHub couldn't verify an account for commit 32d9ea3." },
      { author: "octocat", body: huge },
      { author: "octocat", body: qa },
    ],
  };
  const text = pullRequestReviewText(pr, "32d9ea370a5bf4a4");
  // Vercel's hidden metadata is left out; its message is one line, as a bot.
  assert.doesNotMatch(text, /\[vc\]:|xfHHSH4nk/);
  assert.match(text, /\[comment 2\] vercel \(bot\): Vercel didn't deploy this pull request\. GitHub couldn't verify/);
  // The QA report in full, line breaks kept, down to its last line.
  assert.ok(text.includes("    | 40 | Scenario 40: sign in and come back | Passed |\n    \n    ### Failed\n    \n    None."));
  // Past the per-comment allowance: cut, with how to read the rest.
  assert.match(text, /… \(cut at 8000 characters: team_pr\(comment: 3\) reads all of it\)/);
  // One comment, or one thread, in full.
  assert.equal(pullRequestReviewText(pr, null, undefined, { comment: 3 }).length > 9_000, true);
  assert.match(pullRequestReviewText(pr, null, undefined, { comment: 4 }), /^Comment 4 on pull request #386, from octocat:\n\n## iOS simulator QA/);
  assert.match(pullRequestReviewText(pr, null, undefined, { comment: 9 }), /has no comment 9; it has 4\./);
  assert.match(pullRequestReviewText(pr, null, undefined, { thread: "PRRT_long" }), /^Thread PRRT_long on pull request #386, a\.js:1 \(resolved\):\n\nchatgpt-codex-connector:\ny{10000}/);
  // Hidden metadata stays out even by number.
  assert.match(pullRequestReviewText(pr, null, undefined, { comment: 1 }), /is vercel's hidden status data, not a message/);
  // Threads left out for space are listed by id, so each can be read.
  const many = pullRequestReviewText(
    {
      ...pr,
      threads: [1, 2, 3].map((n) => ({ id: `PRRT_${n}`, resolved: false, outdated: false, path: `f${n}.js`, line: n, comments: [{ author: "chatgpt-codex-connector", body: "z".repeat(5_000) }] })),
    },
    null,
    12_000,
  );
  assert.match(many, /more open thread\(s\) not shown for space: PRRT_2 \(f2\.js:2\), PRRT_3 \(f3\.js:3\)\. team_pr\(thread: "<id>"\) reads one\./);
  // When everything does not fit, the oldest comments are named, newest kept.
  const tight = pullRequestReviewText(pr, null, 3_000);
  assert.match(tight, /Not shown for space: comments [\d, ]+; team_pr\(comment: <number>\) reads one\./);
  assert.match(tight, /\[comment 4\] octocat/);
});

test("team_pr reads the agent's pull request; team_pr_reply answers and resolves a finding once the owner approves; other threads are refused", async (t) => {
  const bare = origin(t);
  const gh = github();
  const h = await harness(t, {}, false, {
    project: { source: "github", repo: "https://github.com/owner/repo", baseBranch: "main" },
    githubFetch: gh.fetcher,
    remoteUrl: () => bare,
    options: { codexReview: true },
  });
  await h.worker.start();
  await h.until(() => h.store.project(h.project.id)!.state === "ready", "project ready");
  const lead = h.agent("Lead");
  const look = h.agent("Reviewer", "look");
  await h.until(() => [lead.id, look.id].every((id) => h.store.agent(id)!.state === "ready"), "folders");
  await h.ended(h.send(lead.id, "write fix.txt"));
  // No pull request yet.
  await h.ended(h.send(lead.id, call("team_pr")));
  assert.match(h.said(lead.id).at(-1)!, /error: console\/[^ ]+ has no open pull request yet\. Push it with team_push/);
  // Open one, then Codex reviews it (seeded into the fake).
  const pushed = h.store.queueTurn(lead.id, call("team_push", { title: "Fix sign-in", body: "Details" }), null, { pushApproved: true }).id;
  await h.until(() => h.store.openRequests().length === 1, "push asked");
  runCommand(h.store, { action: "decide", requestId: h.store.openRequests()[0].id, decision: "allow" });
  await h.ended(pushed);
  await h.until(() => gh.pulls.length === 1 && gh.comments.length === 1, "pull request opened");
  gh.comments.push({ pr: 100, author: "chatgpt-codex-connector[bot]", body: SUMMARY("completed", "b149db344f31") });
  gh.threads.push({ id: "PRRT_one", pr: 100, resolved: false, path: "mobile/app/dinnerparty.jsx", line: 75, comments: [{ author: "chatgpt-codex-connector", body: FINDING }] });
  gh.threads.push({ id: "PRRT_two", pr: 100, resolved: false, path: "mobile/app/guest.jsx", line: 9, comments: [{ author: "octocat", body: "Same here?" }] });
  // GitHub has what the folder has.
  gh.state.head = git(h.store.agent(lead.id)!.folder, "rev-parse", "HEAD");
  gh.threads.push({ id: "PRRT_elsewhere", pr: 999, resolved: false, path: "x", line: 1, comments: [{ author: "someone", body: "not yours" }] });

  await h.ended(h.send(lead.id, call("team_pr")));
  const read = h.said(lead.id).at(-1)!;
  assert.match(read, /^team_pr: Pull request #100 \(open\): "Fix sign-in"/);
  assert.match(read, /Codex review: completed on b149db34, 1 open finding\(s\)\./);
  assert.match(read, /thread PRRT_one, mobile\/app\/dinnerparty\.jsx:75/);
  assert.match(read, /Preserve `force` when resuming/);
  // Both threads, read across two pages.
  assert.match(read, /\[2\] thread PRRT_two, mobile\/app\/guest\.jsx:9/);
  // A long thread: team_pr(thread) reads every reply, past the first 20.
  gh.threads.push({ id: "PRRT_long", pr: 100, resolved: true, path: "a.js", line: 1, comments: Array.from({ length: 25 }, (_, i) => ({ author: "octocat", body: `reply ${i + 1}` })) });
  await h.ended(h.send(lead.id, call("team_pr", { thread: "PRRT_long" })));
  const longRead = h.said(lead.id).at(-1)!;
  assert.match(longRead, /reply 25/);
  assert.doesNotMatch(longRead, /goes on past/);
  // One comment in full, by its number.
  gh.comments.push({ pr: 100, author: "octocat", body: "## QA\n\n| # | Result |\n|---|---|\n| 1 | Passed |" });
  await h.ended(h.send(lead.id, call("team_pr", { comment: gh.comments.length })));
  // Read across pages of the conversation (two comments a page here), so
  // the last comment's number is its place from the first.
  assert.match(h.said(lead.id).at(-1)!, new RegExp(`^team_pr: Comment ${gh.comments.length} on pull request #100, from octocat:\\n\\n## QA\\n\\n\\| # \\| Result \\|`));
  await h.ended(h.send(lead.id, call("team_pr", { comment: 0 })));
  assert.match(h.said(lead.id).at(-1)!, /error: comment must be a comment's number/);
  // A Code analysis agent has no pull request of its own.
  await h.ended(h.send(look.id, call("team_pr")));
  assert.match(h.said(look.id).at(-1)!, /error: A Code analysis agent has no branch/);

  // team_checks: the checks GitHub ran on the pull request's
  // latest commit, and the end of a failed job's log.
  const checks = async (args: Record<string, unknown> = {}, who = lead.id) => {
    await h.ended(h.send(who, call("team_checks", args)));
    return h.said(who).at(-1)!;
  };
  assert.match(await checks(), /^team_checks: Checks for [0-9a-f]{8}, the latest commit on your pull request\.\nNo check has started for it/);
  gh.jobs.push(
    { id: 41, sha: gh.state.head, name: "chromium", status: "completed", conclusion: "success", log: "" },
    { id: 42, sha: gh.state.head, name: "webkit", status: "completed", conclusion: "failure", log: `2026-11-12T10:00:00.0000000Z Running 3 tests\n2026-11-12T10:00:09.0000000Z   1) layout.spec.ts:12 marks overlap ${TOKEN}\n2026-11-12T10:00:10.0000000Z 1 failed\n` },
    { id: 43, sha: gh.state.head, name: "firefox", status: "in_progress", conclusion: null, log: "" },
    // A name with a credential across the name's length limit: masked whole, never cut into.
    { id: 44, sha: gh.state.head, name: `${"n".repeat(110)}${TOKEN}`, status: "completed", conclusion: "success", log: "" },
    { id: 77, sha: "f".repeat(40), name: "someone else's", status: "completed", conclusion: "failure", log: "not yours" },
  );
  const listed = await checks();
  assert.match(listed, new RegExp(`^team_checks: Checks for ${gh.state.head.slice(0, 8)}, the latest commit on your pull request\\.\\n- CI / webkit: FAILED \\(job 42\\)\\n- CI / firefox: running \\(job 43\\)\\n- CI / chromium: passed \\(job 41\\)\\n- CI / n{110}\\[redact`));
  assert.match(listed, /\nRead the end of a failed job's log with team_checks\(job: 42\)\.$/);
  assert.ok(!listed.includes(TOKEN.slice(0, 8)));
  // The log's end, without GitHub's timestamps, and redacted.
  const log = await checks({ job: 42 });
  assert.match(log, /^team_checks: The end of the log of CI \/ webkit \(job 42\):\n\nRunning 3 tests\n  1\) layout\.spec\.ts:12 marks overlap \[redacted[^\]]*\]\n1 failed$/);
  // Only its own pull request's jobs; a number, never anything else.
  assert.match(await checks({ job: 77 }), /error: Job 77 is not one of your pull request's checks/);
  assert.match(await checks({ job: "42" }), /error: job must be a job's number/);
  assert.match(await checks({}, look.id), /error: A Code analysis agent has no branch/);
  // A token without Actions: Read-only says what is missing.
  gh.state.actions = false;
  assert.match(await checks(), /error: The GitHub token cannot read this repository's checks\. Ask the owner to give it Actions: Read-only/);
  gh.state.actions = true;

  // A reply waits for the owner, then is posted and the thread resolved.
  const reply = h.send(lead.id, call("team_pr_reply", { thread: "PRRT_one", message: "Fixed in abc1234: force is carried into the resume.", resolve: true }));
  await h.until(() => h.store.openRequests().length === 1, "approval asked");
  // Needs you shows the whole reply as it will be posted.
  assert.equal(h.store.openRequests()[0].summary, "Reply on its pull request and resolve the thread:\n\nFixed in abc1234: force is carried into the resume.");
  runCommand(h.store, { action: "decide", requestId: h.store.openRequests()[0].id, decision: "allow" });
  await h.ended(reply);
  assert.match(h.said(lead.id).at(-1)!, /^team_pr_reply: Replied on pull request #100 and resolved the thread\./);
  const thread = gh.threads.find((x) => x.id === "PRRT_one")!;
  assert.equal(thread.resolved, true);
  assert.match(thread.comments.at(-1)!.body, /^Fixed in abc1234: force is carried into the resume\.\n\n_— Lead, via Squadroom_$/);
  // A thread on another pull request is refused before the owner is asked.
  await h.ended(h.send(lead.id, call("team_pr_reply", { thread: "PRRT_elsewhere", message: "hi" })));
  assert.equal(h.store.openRequests().length, 0);
  assert.match(h.said(lead.id).at(-1)!, /error: That thread is not on your pull request #100\./);
  assert.equal(gh.threads.find((x) => x.id === "PRRT_elsewhere")!.comments.length, 1);
  // A resolve that fails after the reply is posted is reported, so the
  // agent does not post the reply again.
  gh.state.failResolve = true;
  const partial = h.send(lead.id, call("team_pr_reply", { thread: "PRRT_two", message: "Yes, fixed too.", resolve: true }));
  await h.until(() => h.store.openRequests().length === 1, "asked for two");
  runCommand(h.store, { action: "decide", requestId: h.store.openRequests()[0].id, decision: "allow" });
  await h.ended(partial);
  assert.match(h.said(lead.id).at(-1)!, /^team_pr_reply: Replied on pull request #100, but the thread could not be resolved .* Do not reply again/);
  assert.equal(gh.threads.find((x) => x.id === "PRRT_two")!.comments.length, 2);
  // New commits not on GitHub yet: push first, reply later.
  await h.ended(h.send(lead.id, "write more.txt"));
  await h.ended(h.send(lead.id, call("team_pr_reply", { thread: "PRRT_one", message: "More." })));
  assert.match(h.said(lead.id).at(-1)!, /error: Your folder has commits GitHub does not have yet/);
  // A reply longer than Needs you shows is refused.
  await h.ended(h.send(lead.id, call("team_pr_reply", { thread: "PRRT_one", message: "x".repeat(1501) })));
  assert.match(h.said(lead.id).at(-1)!, /error: A reply is at most 1500 characters/);
  // A credential in a reply is refused before anything is asked or sent.
  await h.ended(h.send(lead.id, call("team_pr_reply", { thread: "PRRT_one", message: "see $TOKEN" })));
  assert.match(h.said(lead.id).at(-1)!, /error: The message contains a credential/);
  assert.equal(h.store.openRequests().length, 0);

  // The worker stops after GitHub posted a reply but before its answer is
  // recorded: the call was journaled first, so the Re-send
  // note says the reply may be there.
  gh.state.head = git(h.store.agent(lead.id)!.folder, "rev-parse", "HEAD");
  let release!: () => void;
  gh.state.holdReply = new Promise<void>((r) => (release = r));
  const cut = h.send(lead.id, call("team_pr_reply", { thread: "PRRT_one", message: "Posted, then the worker stopped." }));
  await h.until(() => h.store.openRequests().length === 1, "asked for the cut reply");
  runCommand(h.store, { action: "decide", requestId: h.store.openRequests()[0].id, decision: "allow" });
  await h.until(() => gh.threads.find((x) => x.id === "PRRT_one")!.comments.some((c) => c.body.startsWith("Posted, then the worker stopped.")), "reply posted");
  await h.worker.stop();
  release();
  assert.equal(h.store.turn(cut)!.status, "interrupted");
  assert.match(resendNote(h.store.toolCalls(cut)), /A reply to thread PRRT_one may have been posted; check team_pr before replying again/);
});

test("checks: only a list that is whole and all passed says so; what did not pass comes first, within a bound", () => {
  const sha = "a".repeat(40);
  const job = (id: number, conclusion: string | null, status = "completed", name = `job ${id}`) => ({ id, run: "CI", name, status, conclusion });
  const last = (text: string) => text.split("\n").at(-1)!;
  assert.equal(last(checksText([job(1, "success"), job(2, "skipped"), job(3, "neutral")], sha, sha)), "Every check passed.");
  // Ended without a result: never "passed".
  for (const c of ["cancelled", "action_required", "stale"]) assert.match(last(checksText([job(1, "success"), job(2, c)], sha, sha)), /^Not every check ran to a result/);
  const timedOut = checksText([job(1, "success"), job(2, "timed_out")], sha, sha);
  assert.match(timedOut, /- CI \/ job 2: FAILED: timed out \(job 2\)\n- CI \/ job 1: passed/);
  assert.match(last(timedOut), /team_checks\(job: 2\)/);
  assert.match(last(checksText([job(1, "success"), job(2, null, "queued")], sha, sha)), /^Still running/);
  // More on GitHub than was read: said, and never "every check".
  const partial = checksText([job(1, "success")], sha, sha, true);
  assert.match(partial, /GitHub has more jobs for this commit than are read here/);
  assert.equal(last(partial), "Every job listed passed.");
  // Many long-named jobs: bounded, the failed one shown, the rest counted.
  const many = [...Array.from({ length: 400 }, (_, i) => job(i + 1, "success", "completed", "x".repeat(300))), job(999, "failure")];
  const text = checksText(many, sha, "b".repeat(40));
  assert.ok(text.length < CHECKS_CHARS + 600, String(text.length));
  assert.match(text, /its newer commits are not pushed/);
  assert.match(text, /\n- CI \/ job 999: FAILED \(job 999\)\n/);
  assert.match(text, /\d+ more job\(s\) not shown for space: \d+ passed\./);
});

test("a job's log: masked before any of it is chosen, long lines cut, never empty when there is text", () => {
  const job = { id: 7, run: "CI", name: "webkit" };
  const secret = "LINE-ONE-OF-SECRET\nLINE-TWO-OF-SECRET";
  const redact = (t: string) => t.split(secret).join("[redacted]");
  // A credential over two lines, with enough after it that only its second line would fit.
  const tail = Array.from({ length: 400 }, (_, i) => `line ${i} ${"y".repeat(50)}`).join("\n");
  const out = jobLogText(job, { text: `start\n${secret}\n${tail}`, cut: false }, redact);
  assert.ok(out.length <= JOB_LOG_CHARS + 100);
  assert.doesNotMatch(out, /SECRET/);
  // Read from inside the log: what a cut credential could have left at the start is dropped.
  const inside = jobLogText(job, { text: `WO-OF-SECRET\n${"z".repeat(5000)}\nlast line`, cut: true }, redact);
  assert.doesNotMatch(inside, /SECRET/);
  assert.match(inside, /last line$/);
  // One very long last line does not hide the lines before it.
  const long = jobLogText(job, { text: `2026-11-12T10:00:00.0000000Z test assertion failed\n${"q".repeat(30_000)}\n`, cut: false }, redact);
  assert.match(long, /\n\ntest assertion failed\nq{2000} \[…line cut\]$/);
  assert.match(jobLogText(job, { text: "", cut: false }, redact), /\(The log is empty\.\)$/);
});

test("reading checks from GitHub: every page of jobs within a bound; a log's end without holding the whole of it", async () => {
  const sha = "c".repeat(40);
  const page = (n: number, from: number, total: number) => ({ total_count: total, jobs: Array.from({ length: n }, (_, i) => ({ id: from + i, name: `j${from + i}`, status: "completed", conclusion: "success" })) });
  const api = (pages: Record<string, unknown>, runs = { total_count: 1, workflow_runs: [{ id: 9, name: "CI" }] }) =>
    (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/actions/runs")) return Response.json(runs);
      return Response.json(pages[url.searchParams.get("page") ?? "1"] ?? { total_count: 0, jobs: [] });
    }) as typeof fetch;
  const two = await readChecks("owner/repo", sha, { token: "t", fetch: api({ "1": page(100, 1, 130), "2": page(30, 101, 130) }) });
  assert.deepEqual([two.jobs.length, two.incomplete, two.jobs.at(-1)!.id], [130, false, 130]);
  const huge = await readChecks("owner/repo", sha, { token: "t", fetch: api({ "1": page(100, 1, 900), "2": page(100, 101, 900), "3": page(100, 201, 900) }) });
  assert.deepEqual([huge.jobs.length, huge.incomplete], [300, true]);
  const manyRuns = await readChecks("owner/repo", sha, { token: "t", fetch: api({ "1": page(1, 1, 1) }, { total_count: 45, workflow_runs: [{ id: 9, name: "CI" }] }) });
  assert.equal(manyRuns.incomplete, true);
  await assert.rejects(readChecks("owner/repo", "main", { token: "t", fetch: api({}) }), /not a commit/);

  // A 2 MB log streamed in pieces: only its end is kept, and it is asked for by range.
  let asked = "";
  const body = () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 32; i++) c.enqueue(new Uint8Array(64 * 1024).fill(97 + (i % 26)));
        c.enqueue(new TextEncoder().encode("THE END"));
        c.close();
      },
    });
  const logs = (async (_input: string | URL | Request, init: RequestInit = {}) => {
    asked = new Headers(init.headers).get("range") ?? "";
    return new Response(body());
  }) as typeof fetch;
  const log = await readJobLog("owner/repo", 7, 1024, { token: "t", fetch: logs });
  assert.equal(asked, "bytes=-1024");
  assert.deepEqual([log.text.length, log.cut, log.text.endsWith("THE END")], [1024, true, true]);
  // A host that honours the range says how long the whole log is.
  const ranged = (async () => new Response("tail", { status: 206, headers: { "content-range": "bytes 96-99/100" } })) as typeof fetch;
  assert.deepEqual(await readJobLog("owner/repo", 7, 1024, { token: "t", fetch: ranged }), { text: "tail", cut: true });
  const small = (async () => new Response("all of it")) as typeof fetch;
  assert.deepEqual(await readJobLog("owner/repo", 7, 1024, { token: "t", fetch: small }), { text: "all of it", cut: false });
});
