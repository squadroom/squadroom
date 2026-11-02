import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/lib/console/commands.ts";
import { cleanComment, codexState, pullRequestReviewText } from "../src/lib/console/pull-request.ts";
import { harness } from "./helpers/console-harness.ts";
import { resendNote } from "../src/lib/console/team.ts";

// an agent reads its own pull request (Codex's
// findings, comments) and answers a finding, through the worker with the
// owner's token; the agent never holds a GitHub login. "GitHub" is a local
// bare repository and a fake REST + GraphQL API.

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: cwd } as Record<string, string> as NodeJS.ProcessEnv,
  }).trim();
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
  const state = { head: "b149db344f31750d3d7ec0c8e19df27ec48bd3bd", failResolve: false, pageSize: 1, commentPage: 2, holdReply: null as Promise<void> | null };
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
  return { fetcher, pulls, threads, comments, state };
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
  // A Look only agent has no pull request of its own.
  await h.ended(h.send(look.id, call("team_pr")));
  assert.match(h.said(look.id).at(-1)!, /error: A Code analysis agent has no branch/);

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
