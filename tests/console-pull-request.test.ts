import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPEN_PR_PROMPT, runCommand } from "../src/lib/console/commands.ts";
import { commentOnPullRequest, openPullRequest } from "../src/lib/console/git.ts";
import { CODEX_REVIEW, codexReviewSetting, pullRequestText, pushRequest, wantsReview } from "../src/lib/console/pull-request.ts";
import { harness, TOKEN } from "./helpers/console-harness.ts";

// After a push the Console opens the pull request with a description and,
// when Codex reviews are switched on, asks Codex to review it, so the owner
// does neither by hand. "GitHub" is a local bare repository and a fake API.

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
};

/** A fake GitHub API that keeps pull requests and comments. `canWrite`
 * false answers 403 to pull request calls, as a token without "Pull
 * requests: write" gets. */
function github(canWrite = true) {
  const pulls: { number: number; head: string; base: string; title: string; body: string }[] = [];
  const comments: { number: number; body: string }[] = [];
  const auth: string[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    auth.push(new Headers(init.headers).get("authorization") ?? "");
    const json = (v: unknown, status = 200) => Response.json(v, { status });
    const path = url.pathname;
    if (path === "/repos/owner/repo") return json({ id: 1 });
    if (path === "/repos/owner/repo/branches/main") return json({ name: "main" });
    if (path === "/repos/owner/repo/rulesets") return json([{ id: 7 }]);
    if (path === "/repos/owner/repo/rulesets/7") return json(RULESET);
    if (path === "/repos/owner/repo/pulls") {
      if (!canWrite) return json({ message: "Resource not accessible by personal access token" }, 403);
      if ((init.method ?? "GET") === "GET") {
        const head = url.searchParams.get("head")!.replace(/^owner:/, "");
        return json(pulls.filter((p) => p.head === head && p.base === url.searchParams.get("base")).map((p) => ({ number: p.number, html_url: `https://github.com/owner/repo/pull/${p.number}` })));
      }
      const b = JSON.parse(String(init.body)) as { head: string; base: string; title: string; body: string };
      const pr = { number: 100 + pulls.length, ...b };
      pulls.push(pr);
      return json({ number: pr.number, html_url: `https://github.com/owner/repo/pull/${pr.number}` }, 201);
    }
    const patch = /^\/repos\/owner\/repo\/pulls\/(\d+)$/.exec(path);
    if (patch && init.method === "PATCH") {
      if (!canWrite) return json({}, 403);
      const pr = pulls.find((p) => p.number === Number(patch[1]));
      if (!pr) return json({}, 404);
      Object.assign(pr, JSON.parse(String(init.body)));
      return json({ number: pr.number });
    }
    const comment = /^\/repos\/owner\/repo\/issues\/(\d+)\/comments$/.exec(path);
    if (comment) {
      if (!canWrite) return json({}, 403);
      comments.push({ number: Number(comment[1]), body: (JSON.parse(String(init.body)) as { body: string }).body });
      return json({ id: 1 }, 201);
    }
    return json({}, 404);
  }) as typeof fetch;
  return { fetcher, pulls, comments, auth };
}

test("the pull request's text: the agent's own words first, else its latest report, the commits and a footer", () => {
  assert.deepEqual(pushRequest({ title: " Fix sign-in ", body: "Details", review: true }, "agent"), { by: "agent", title: "Fix sign-in", body: "Details", review: true });
  assert.deepEqual(pushRequest({}, "agent"), { by: "agent" });
  assert.match((pushRequest({ title: "x".repeat(121) }, "agent") as { error: string }).error, /title is at most 120/);
  assert.match((pushRequest({ review: "yes" }, "agent") as { error: string }).error, /review must be true or false/);
  const given = pullRequestText({ request: { by: "agent", title: "Fix sign-in", body: "What changed." }, agentName: "Lead", model: "Opus 5.5", branch: "console/a1-lead", report: "Ignored.", commits: ["second", "first"] });
  assert.equal(given.title, "Fix sign-in");
  assert.match(given.body, /^What changed\.\n\n### Commits\n\n- second\n- first\n\n---\nOpened by Squadroom for Lead \(Opus 5\.5\), from `console\/a1-lead`\.$/);
  const fallback = pullRequestText({ request: { by: "owner" }, agentName: "Lead", model: "Opus 5.5", branch: "console/a1-lead", report: "Sign-in now returns to the builder. More text.", commits: [] });
  assert.equal(fallback.title, "Sign-in now returns to the builder");
  assert.match(fallback.body, /^Sign-in now returns to the builder\. More text\./);
  assert.equal(pullRequestText({ request: null, agentName: "Lead", model: "m", branch: "console/a1-lead", report: null, commits: ["newest", "oldest work"] }).title, "oldest work");
  // Codex: always for a new pull request; again only when asked (the
  // owner's Push branch always asks).
  assert.equal(wantsReview({ by: "agent" }, true), true);
  assert.equal(wantsReview({ by: "agent" }, false), false);
  assert.equal(wantsReview({ by: "agent", review: true }, false), true);
  assert.equal(wantsReview({ by: "owner" }, false), true);
  // The switch itself: off unless set on.
  assert.equal(codexReviewSetting({}), false);
  assert.equal(codexReviewSetting({ CONSOLE_CODEX_REVIEW: "" }), false);
  assert.equal(codexReviewSetting({ CONSOLE_CODEX_REVIEW: "off" }), false);
  assert.equal(codexReviewSetting({ CONSOLE_CODEX_REVIEW: "On" }), true);
  assert.equal(codexReviewSetting({ CONSOLE_CODEX_REVIEW: "1" }), true);
  assert.throws(() => codexReviewSetting({ CONSOLE_CODEX_REVIEW: "maybe" }), /on or off/);
});

test("GitHub calls: an open pull request is reused, a new one is opened; a token without pull request access is named", async () => {
  const gh = github();
  const first = await openPullRequest("owner/repo", { branch: "console/a1-lead", base: "main", title: "T", body: "B" }, "tok", gh.fetcher, "https://api.example");
  assert.deepEqual(first, { number: 100, url: "https://github.com/owner/repo/pull/100", created: true, updated: false });
  const again = await openPullRequest("owner/repo", { branch: "console/a1-lead", base: "main", title: "T2", body: "B2" }, "tok", gh.fetcher, "https://api.example");
  assert.deepEqual([again.created, again.updated], [false, false]);
  assert.equal(gh.pulls.length, 1);
  // An open one takes the agent's new title and description when given.
  const updated = await openPullRequest("owner/repo", { branch: "console/a1-lead", base: "main", title: "T3", body: "B3" }, "tok", gh.fetcher, "https://api.example", { title: "T3", body: "B3" });
  assert.equal(updated.updated, true);
  assert.deepEqual([gh.pulls[0].title, gh.pulls[0].body], ["T3", "B3"]);
  await commentOnPullRequest("owner/repo", 100, CODEX_REVIEW, "tok", gh.fetcher, "https://api.example");
  assert.deepEqual(gh.comments, [{ number: 100, body: "@codex review" }]);
  assert.ok(gh.auth.every((a) => a === "Bearer tok"));
  await assert.rejects(openPullRequest("owner/repo", { branch: "main", base: "main", title: "T", body: "B" }, "tok", gh.fetcher, "https://api.example"), /Only console\/ branches/);
  const denied = github(false);
  await assert.rejects(
    openPullRequest("owner/repo", { branch: "console/a1-lead", base: "main", title: "T", body: "B" }, "tok", denied.fetcher, "https://api.example"),
    /Pull requests: Read and write/,
  );
});

test("team_push opens the pull request with the agent's description and asks Codex; Open pull request needs no second approval; Push branch updates it", async (t) => {
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
  await h.until(() => h.store.agent(lead.id)!.state === "ready", "folder");
  const branch = h.store.agentBase(lead.id).branch!;
  await h.ended(h.send(lead.id, "write fix.txt"));

  // The agent asks; the owner approves in Needs you.
  const asked = h.send(lead.id, call("team_push", { title: "Return to the builder after sign-in", body: "## What changed\nSign-in returns you." }));
  await h.until(() => h.store.openRequests().length === 1, "asked");
  assert.match(h.store.openRequests()[0].summary, /open its pull request: "Return to the builder after sign-in"/);
  runCommand(h.store, { action: "decide", requestId: h.store.openRequests()[0].id, decision: "allow" });
  await h.ended(asked);
  const job = () => h.store.latestJob(lead.id)!;
  await h.until(() => ["done", "failed"].includes(job().state), "pushed");
  assert.equal(job().state, "done", job().message ?? "");
  const firstJob = job().id;
  assert.equal(job().url, "https://github.com/owner/repo/pull/100");
  assert.match(job().message!, /Opened pull request #100\. Codex was asked to review it\./);
  assert.equal(gh.pulls.length, 1);
  assert.equal(gh.pulls[0].title, "Return to the builder after sign-in");
  assert.equal(gh.pulls[0].head, branch);
  assert.match(gh.pulls[0].body, /^## What changed\nSign-in returns you\.\n\n### Commits\n\n- /);
  assert.match(gh.pulls[0].body, /Opened by Squadroom for Lead/);
  assert.deepEqual(gh.comments, [{ number: 100, body: "@codex review" }]);
  // The agent's login token never leaves in a description.
  assert.ok(!gh.pulls[0].body.includes(TOKEN));

  // "Open pull request": an owner turn whose team_push is already approved.
  const opened = (runCommand(h.store, { action: "openPullRequest", agentId: lead.id }) as { turnId: number }).turnId;
  assert.equal(h.store.turn(opened)!.prompt, OPEN_PR_PROMPT);
  assert.equal(h.store.pushApproved(opened), true);
  await h.ended(opened);
  // The same approval, used by a turn the fake can run: no Needs you item;
  // the open pull request takes the new title, and the owner's ask brings
  // a Codex review without review: true.
  const approved = h.store.queueTurn(lead.id, call("team_push", { title: "Again" }), null, { pushApproved: true }).id;
  await h.ended(approved);
  assert.equal(h.store.openRequests().length, 0);
  await h.until(() => job().id !== firstJob && ["done", "failed"].includes(job().state), "pushed again");
  assert.match(job().message!, /Updated the title and description of pull request #100\. Codex was asked to review it\./);
  assert.equal(gh.pulls.length, 1);
  assert.equal(gh.pulls[0].title, "Again");
  assert.match(gh.pulls[0].body, /^## What changed/);
  assert.equal(gh.comments.length, 2);
  // Send again of an owner-approved turn keeps the approval.
  assert.equal(h.store.pushApproved(h.store.queueTurn(lead.id, "hello", approved).id), true);
  assert.equal(h.store.pushApproved(h.store.queueTurn(lead.id, "hello").id), false);
  // A credential in the agent's text: refused before redaction could hide it.
  const leaky = h.send(lead.id, call("team_push", { title: "Fix", body: "token $TOKEN" }));
  await h.ended(leaky);
  assert.match(h.said(lead.id).at(-1)!, /error: The title or description contains a credential/);

  // The owner's Push branch on an existing pull request asks Codex again.
  await h.ended(h.send(lead.id, "write more.txt"));
  const pushed = (runCommand(h.store, { action: "push", agentId: lead.id }) as { job: { id: number } }).job;
  await h.until(() => ["done", "failed"].includes(h.store.job(pushed.id)!.state), "owner push");
  // No new text from the agent: the description on GitHub is kept.
  assert.match(h.store.job(pushed.id)!.message!, /Pushed to pull request #100\. Codex was asked to review it\./);
  assert.equal(gh.pulls[0].title, "Again");
  assert.equal(gh.comments.length, 3);
});

test("with Codex reviews off (the default), the pull request is opened and no one is asked to review it", async (t) => {
  const bare = origin(t);
  const gh = github();
  const h = await harness(t, {}, false, {
    project: { source: "github", repo: "https://github.com/owner/repo", baseBranch: "main" },
    githubFetch: gh.fetcher,
    remoteUrl: () => bare,
  });
  await h.worker.start();
  await h.until(() => h.store.project(h.project.id)!.state === "ready", "project ready");
  const lead = h.agent("Lead");
  await h.until(() => h.store.agent(lead.id)!.state === "ready", "folder");
  await h.ended(h.send(lead.id, "write fix.txt"));
  await h.ended(h.store.queueTurn(lead.id, call("team_push", { title: "Fix", body: "Details", review: true }), null, { pushApproved: true }).id);
  const job = () => h.store.latestJob(lead.id)!;
  await h.until(() => ["done", "failed"].includes(job()?.state ?? ""), "pushed");
  assert.equal(job().state, "done", job().message ?? "");
  assert.match(job().message!, /Opened pull request #100\.$/);
  assert.equal(gh.pulls.length, 1);
  assert.deepEqual(gh.comments, []);
});

test("a token without pull request access: the branch is still pushed, and the window says what the token needs", async (t) => {
  const bare = origin(t);
  const gh = github(false);
  const h = await harness(t, {}, false, {
    project: { source: "github", repo: "https://github.com/owner/repo", baseBranch: "main" },
    githubFetch: gh.fetcher,
    remoteUrl: () => bare,
  });
  await h.worker.start();
  await h.until(() => h.store.project(h.project.id)!.state === "ready", "project ready");
  const lead = h.agent("Lead");
  await h.until(() => h.store.agent(lead.id)!.state === "ready", "folder");
  await h.ended(h.send(lead.id, "write fix.txt"));
  const pushed = (runCommand(h.store, { action: "push", agentId: lead.id }) as { job: { id: number } }).job;
  await h.until(() => ["done", "failed"].includes(h.store.job(pushed.id)!.state), "pushed");
  const done = h.store.job(pushed.id)!;
  assert.equal(done.state, "done");
  assert.match(done.message!, /The pull request was not opened: .*Pull requests: Read and write/);
  assert.match(done.url!, /\/compare\/main\.\.\.console\//);
  assert.equal(git(bare, "rev-parse", `refs/heads/${h.store.agentBase(lead.id).branch!}`).length, 40);
});
