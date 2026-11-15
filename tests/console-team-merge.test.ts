import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsFreshCode, runCommand } from "../src/lib/console/commands.ts";
import { checksLine, checksRefusal, mergeCommitTitle, mergeFailure, mergeHint, pullRefusal, reviewLine, type PullState } from "../src/lib/console/merge.ts";
import { needNotices } from "../src/lib/console/notify.ts";
import { teamToolsFor } from "../src/lib/console/team-tools.ts";
import { needsView, projectView } from "../src/lib/console/views.ts";
import { harness } from "./helpers/console-harness.ts";

// team_merge: an agent asks for its pull request to be merged (team_merge), the owner approves it in Needs you, and the worker
// asks GitHub to squash-merge it at the commit the owner saw. "GitHub" is a
// local bare repository and a fake REST + GraphQL API whose merge really
// squashes the branch onto main.

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
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
  return { bare, work };
}
const RULESET = {
  id: 7,
  enforcement: "active",
  target: "branch",
  conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request" }],
  current_user_can_bypass: "never",
};

type Pull = { number: number; head: string; base: string; title: string; body: string; state: string; merged: boolean; draft: boolean; mergeable: boolean | null; mergeable_state: string; repo: string; sha?: string; mergeCommit?: string };
/** Fake GitHub: pull requests, their checks, and a merge that squashes. */
function github(bare: string, work: string) {
  const pulls: Pull[] = [];
  const jobs: { id: number; sha: string; name: string; status: string; conclusion: string | null }[] = [];
  const merges: { number: number; body: Record<string, unknown> }[] = [];
  /** `computing`: how many reads of a pull request still answer that GitHub has not worked out whether it can be merged.
   * `retarget`: the base branch the pull request is moved to right after its next read.
   * `queuedRun`: a commit with a workflow that is queued and has no jobs yet.
   * `dropMerge`: the merge's answer never arrives, after merging ("merged") or with the pull request unreadable from then on ("unknown"). */
  const state = {
    refuse: null as { status: number; message: string } | null,
    runSha: "",
    comments: [] as { author: string; body: string }[],
    threads: 0,
    computing: 0,
    retarget: null as string | null,
    queuedRun: null as string | null,
    dropMerge: null as "merged" | "unknown" | null,
    unreadable: false,
  };
  const headOf = (p: Pull) => p.sha ?? git(bare, "rev-parse", `refs/heads/${p.head}`);
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const json = (v: unknown, status = 200) => Response.json(v, { status });
    const path = url.pathname;
    const method = init.method ?? "GET";
    if (path === "/user") return json({ message: "Bad credentials" }, 401);
    if (path === "/repos/owner/repo") return json({ id: 1 });
    if (path === "/repos/owner/repo/branches/main") return json({ name: "main" });
    if (path === "/repos/owner/repo/rulesets") return json([{ id: 7 }]);
    if (path === "/repos/owner/repo/rulesets/7") return json(RULESET);
    if (path === "/repos/owner/repo/pulls") {
      if (method === "GET") {
        const head = url.searchParams.get("head")!.replace(/^owner:/, "");
        return json(pulls.filter((p) => p.head === head && p.state === "open").map((p) => ({ number: p.number, html_url: `https://github.com/owner/repo/pull/${p.number}` })));
      }
      const b = JSON.parse(String(init.body)) as { head: string; base: string; title: string; body: string };
      const pr: Pull = { number: 100 + pulls.length, ...b, state: "open", merged: false, draft: false, mergeable: true, mergeable_state: "clean", repo: "owner/repo" };
      pulls.push(pr);
      return json({ number: pr.number, html_url: `https://github.com/owner/repo/pull/${pr.number}` }, 201);
    }
    const one = /^\/repos\/owner\/repo\/pulls\/(\d+)(\/merge)?$/.exec(path);
    if (one) {
      const pr = pulls.find((p) => p.number === Number(one[1]));
      if (!pr) return json({ message: "Not Found" }, 404);
      if (method === "PATCH") {
        Object.assign(pr, JSON.parse(String(init.body)));
        return json({});
      }
      if (!one[2]) {
        if (state.unreadable) return json({ message: "Server Error" }, 500);
        const read = {
          number: pr.number,
          html_url: `https://github.com/owner/repo/pull/${pr.number}`,
          title: pr.title,
          state: pr.state,
          merged: pr.merged,
          merge_commit_sha: pr.mergeCommit ?? null,
          draft: pr.draft,
          ...(state.computing-- > 0 ? { mergeable: null, mergeable_state: "unknown" } : { mergeable: pr.mergeable, mergeable_state: pr.mergeable_state }),
          head: { ref: pr.head, sha: headOf(pr), repo: { full_name: pr.repo } },
          base: { ref: pr.base },
        };
        if (state.retarget) [pr.base, state.retarget] = [state.retarget, null];
        return json(read);
      }
      // The merge: only at the commit named, and only by squashing.
      const body = JSON.parse(String(init.body)) as { merge_method: string; sha: string; commit_title: string };
      merges.push({ number: pr.number, body });
      if (state.refuse) return json({ message: state.refuse.message }, state.refuse.status);
      if (state.dropMerge === "unknown") {
        state.unreadable = true;
        throw new TypeError("fetch failed");
      }
      if (body.sha !== headOf(pr)) return json({ message: "Head branch was modified. Review and try the merge again." }, 409);
      try {
        git(work, "fetch", "--quiet", bare, "main");
        git(work, "reset", "--quiet", "--hard", "FETCH_HEAD");
        git(work, "fetch", "--quiet", bare, `refs/heads/${pr.head}`);
        git(work, "-c", "user.name=Owner", "-c", "user.email=o@x", "merge", "--squash", "--quiet", "FETCH_HEAD");
        git(work, "-c", "user.name=Owner", "-c", "user.email=o@x", "commit", "--quiet", "-m", body.commit_title);
        git(work, "push", "--quiet", bare, "main");
      } catch (e) {
        // The worker would only say GitHub could not be reached.
        console.error("fake GitHub's squash merge failed:", e);
        throw e;
      }
      pr.state = "closed";
      pr.merged = true;
      pr.mergeCommit = git(work, "rev-parse", "HEAD");
      if (state.dropMerge === "merged") throw new TypeError("fetch failed");
      return json({ sha: git(work, "rev-parse", "HEAD"), merged: true, message: "Pull Request successfully merged" });
    }
    if (path.startsWith("/repos/owner/repo/actions/")) {
      if (path.endsWith("/actions/runs")) {
        state.runSha = url.searchParams.get("head_sha")!;
        const ran = jobs.filter((j) => j.sha === state.runSha);
        const done = ran.every((j) => j.status === "completed");
        return json({
          workflow_runs: [
            ...(ran.length ? [{ id: 9, name: "CI", status: done ? "completed" : "in_progress", conclusion: !done ? null : ran.some((j) => j.conclusion === "failure") ? "failure" : "success" }] : []),
            ...(state.queuedRun === state.runSha ? [{ id: 10, name: "Deploy", status: "queued", conclusion: null }] : []),
          ],
        });
      }
      if (path.endsWith("/actions/runs/10/jobs")) return json({ jobs: [] });
      if (path.endsWith("/actions/runs/9/jobs")) return json({ jobs: jobs.filter((j) => j.sha === state.runSha) });
    }
    if (/^\/repos\/owner\/repo\/issues\/\d+\/comments$/.test(path)) return json({ id: 1 }, 201);
    if (path === "/graphql") {
      const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      const pr = pulls.find((p) => p.number === variables.number);
      if (!pr) return json({ data: { repository: { pullRequest: null } } });
      if (query.includes("reviewThreads"))
        return json({
          data: {
            repository: {
              pullRequest: {
                number: pr.number,
                url: `https://github.com/owner/repo/pull/${pr.number}`,
                title: pr.title,
                state: "OPEN",
                headRefOid: headOf(pr),
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: Array.from({ length: state.threads }, (_, i) => ({ id: `PRRT_${i}`, isResolved: false, isOutdated: false, path: "a.ts", line: 1, comments: { totalCount: 1, nodes: [{ author: { login: "owner", __typename: "User" }, body: "?", createdAt: "" }] } })),
                },
              },
            },
          },
        });
      return json({
        data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: state.comments.map((c) => ({ author: { login: c.author, __typename: "Bot" }, body: c.body, createdAt: "" })) } } } },
      });
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return { fetcher, pulls, jobs, merges, state, headOf };
}

const PULL: PullState = { number: 7, url: "u", title: "T", state: "open", merged: false, draft: false, mergeable: true, mergeableState: "clean", headRef: "console/a-b", headSha: "a".repeat(40), headRepo: "owner/repo", baseRef: "main", mergeCommit: null };
const job = (name: string, status: string, conclusion: string | null) => ({ id: 1, run: "CI", name, status, conclusion });

test("what blocks a merge, in plain words: the pull request's state, then its checks", () => {
  assert.equal(pullRefusal(PULL), null);
  assert.equal(pullRefusal({ ...PULL, mergeableState: "has_hooks" }), null);
  assert.equal(pullRefusal({ ...PULL, merged: true, state: "closed" }), "Pull request #7 is already merged.");
  assert.equal(pullRefusal({ ...PULL, state: "closed" }), "Pull request #7 is closed, not open.");
  assert.match(pullRefusal({ ...PULL, draft: true })!, /^Pull request #7 is a draft\. It has to be marked ready for review on GitHub first/);
  assert.equal(
    pullRefusal({ ...PULL, mergeable: false, mergeableState: "dirty" }),
    'Pull request #7 conflicts with main, so GitHub cannot merge it. Its branch needs main brought in: team_pull(from: "main") in that branch\'s own folder, resolve the conflicts, push with team_push, then ask again.',
  );
  assert.match(pullRefusal({ ...PULL, mergeable: null, mergeableState: "unknown" })!, /has not worked out yet .* Ask again in a minute\.$/);
  assert.match(pullRefusal({ ...PULL, mergeableState: "behind" })!, /is behind main/);
  assert.match(pullRefusal({ ...PULL, mergeableState: "blocked" })!, /a rule of the repository blocks it .* Only the owner can change that/);

  const sha = "1a2b3c4d".padEnd(40, "0");
  // No check at all is fine; skipped and neutral count as passed.
  assert.equal(checksRefusal(7, sha, [], false), null);
  assert.equal(checksRefusal(7, sha, [job("unit", "completed", "success"), job("e2e", "completed", "skipped"), job("lint", "completed", "neutral")], false), null);
  assert.equal(
    checksRefusal(7, sha, [job("unit", "completed", "success"), job("webkit", "completed", "failure"), job("firefox", "in_progress", null), job("deploy", "completed", "cancelled")], false),
    "Pull request #7's checks have not all passed for 1a2b3c4d (failed: CI / webkit; ended without a result: CI / deploy; still running: CI / firefox). It is merged only once every check has finished and passed: read them with team_checks, fix and push what failed, or ask again when they are done.",
  );
  assert.match(checksRefusal(7, sha, [job("queued", "queued", null)], false)!, /still running: CI \/ queued/);
  // More jobs than were read: never taken for "all passed".
  assert.match(checksRefusal(7, sha, [job("unit", "completed", "success")], true)!, /more checks for 1a2b3c4d than the Console reads/);
  assert.equal(checksLine([]), "Checks: none ran for this commit.");
  assert.equal(checksLine([job("unit", "completed", "success"), job("e2e", "completed", "skipped")]), "Checks: all 2 passed (1 skipped).");
  assert.equal(reviewLine({ comments: [], threads: [{ resolved: false }, { resolved: true }] }), "Codex review: none requested. Open review threads: 1.");
  // GitHub's own title for a squash commit.
  assert.equal(mergeCommitTitle("Add the booking form", 7), "Add the booking form (#7)");
});

test("a merge GitHub refused gets a plain hint and who has to act; unknown causes keep their text", () => {
  const refused = (status: number, message: string) => `GitHub did not merge pull request #7 (${status}: ${message}).`;
  assert.equal(mergeHint(refused(409, "Head branch was modified. Review and try the merge again."))?.who, "agent");
  assert.match(mergeHint(refused(405, "Squash merges are not allowed on this repository."))!.text, /squash merging is switched off for this repository/);
  assert.match(mergeHint(refused(405, "Repository rule violations found\n\nAt least 1 approving review is required"))!.text, /a branch protection rule or ruleset of the repository does not allow this merge/);
  assert.match(mergeHint(refused(403, "Resource not accessible by personal access token"))!.text, /may not merge pull requests in this repository\. The owner has to act: give that token Contents: Read and write and Pull requests: Read and write/);
  assert.match(mergeHint(refused(401, "Bad credentials"))!.text, /did not accept the Console's GitHub token/);
  assert.match(mergeHint(refused(405, "refusing to allow a Personal Access Token to create or update workflow"))!.text, /Workflows permission/);
  assert.equal(mergeHint("GitHub could not be reached."), null);
  assert.equal(mergeFailure("GitHub could not be reached."), "GitHub could not be reached.");
  // Only an editing agent of a GitHub project is offered the tool.
  const offered = (permission: "look" | "edit", source: "folder" | "none" | "github") => teamToolsFor({ permission }, { source }).some((t) => t.name === "team_merge");
  assert.deepEqual([offered("edit", "github"), offered("look", "github"), offered("edit", "folder"), offered("edit", "none")], [true, false, false, false]);
  // The implementer's default: approving a merge needs no fresh code.
  assert.equal(needsFreshCode({ action: "decideMerge", noticeId: 1, decision: "approve" }), false);
});

test("team_merge: asked, shown in Needs you with the facts, approved after the turn ended, squash-merged at the commit the owner saw; the merged branch then takes main in cleanly", async (t) => {
  const { bare, work } = origin(t);
  const gh = github(bare, work);
  const h = await harness(t, {}, false, {
    project: { source: "github", repo: "https://github.com/owner/repo", baseBranch: "main" },
    githubFetch: gh.fetcher,
    remoteUrl: () => bare,
  });
  await h.worker.start();
  await h.until(() => h.store.project(h.project.id)!.state === "ready", "project ready");
  const lead = h.agent("Lead");
  const builder = h.agent("Builder");
  const look = h.agent("Reviewer", "look");
  await h.ready(lead.id, builder.id, look.id);
  // The fake agent's own files stay out of the commits.
  for (const id of [lead.id, builder.id]) writeFileSync(join(h.store.agent(id)!.folder, ".git", "info", "exclude"), "args.jsonl\nenv.json\n");
  const folder = (id: string) => h.store.agent(id)!.folder;
  const branch = (id: string) => h.store.agentBase(id).branch!;
  const echo = async (id: string, text: string) => {
    await h.ended(h.send(id, text));
    return h.said(id).at(-1)!;
  };
  const merge = (id: string, args: Record<string, unknown> = {}) => echo(id, call("team_merge", args));
  /** The agent's branch pushed (approved by the owner beforehand), its pull request's number. */
  const push = async (id: string, title: string) => {
    const before = h.store.latestJob(id)?.id ?? 0;
    const turn = h.store.queueTurn(id, call("team_push", { title, body: "Details" }), null, { pushApproved: true }).id;
    await h.until(() => h.store.openRequests().length === 1, "push asked");
    runCommand(h.store, { action: "decide", requestId: h.store.openRequests()[0].id, decision: "allow" });
    await h.ended(turn);
    await h.until(() => (h.store.latestJob(id)?.id ?? 0) > before && h.store.latestJob(id)!.state === "done", `${title} pushed`);
    return gh.pulls.find((p) => p.head === branch(id) && p.state === "open")!;
  };
  const green = (sha: string) => gh.jobs.push({ id: gh.jobs.length + 1, sha, name: "unit", status: "completed", conclusion: "success" }, { id: gh.jobs.length + 2, sha, name: "e2e", status: "completed", conclusion: "skipped" });
  const items = () => needsView(h.store).notices.filter((n) => n.merge);
  const lines = (id: string) => h.events(id).filter((e) => e.kind === "push").map((e) => (e.body as { text: string }).text);
  const jobDone = (id: number) => h.until(() => ["done", "failed"].includes(h.store.job(id)!.state), "the merge ends");
  const approve = async () => {
    const before = gh.merges.length;
    const item = items()[0];
    runCommand(h.store, { action: "decideMerge", noticeId: item.id, decision: "approve" });
    const row = h.store.all("SELECT MAX(id) AS id FROM console_jobs WHERE kind = 'merge'")[0].id as number;
    await jobDone(row);
    return { job: h.store.job(row)!, asked: gh.merges.length > before };
  };

  // Nothing to merge before a pull request exists.
  await echo(lead.id, "write fix.txt");
  assert.match(await merge(lead.id), /^team_merge: error: console\/[^ ]+ has no open pull request yet\. Push it with team_push/);
  const pr = await push(lead.id, "Fix sign-in");
  const head = gh.headOf(pr);
  assert.equal(head, git(folder(lead.id), "rev-parse", "HEAD"));

  // Refused before the owner is asked, each with what to do.
  gh.jobs.push({ id: 1, sha: head, name: "unit", status: "completed", conclusion: "failure" }, { id: 2, sha: head, name: "e2e", status: "in_progress", conclusion: null });
  assert.equal(
    await merge(lead.id),
    `team_merge: error: Pull request #100's checks have not all passed for ${head.slice(0, 8)} (failed: CI / unit; still running: CI / e2e). It is merged only once every check has finished and passed: read them with team_checks, fix and push what failed, or ask again when they are done.`,
  );
  gh.jobs.length = 0;
  gh.jobs.push({ id: 3, sha: head, name: "unit", status: "queued", conclusion: null });
  assert.match(await merge(lead.id), /error: Pull request #100's checks have not all passed .*\(still running: CI \/ unit\)/);
  gh.jobs.length = 0;
  green(head);
  pr.draft = true;
  assert.match(await merge(lead.id), /error: Pull request #100 is a draft\./);
  pr.draft = false;
  Object.assign(pr, { mergeable: false, mergeable_state: "dirty" });
  assert.match(await merge(lead.id), /error: Pull request #100 conflicts with main, so GitHub cannot merge it\. Its branch needs main brought in: team_pull\(from: "main"\)/);
  Object.assign(pr, { mergeable: true, mergeable_state: "unstable" });
  assert.match(await merge(lead.id), /error: GitHub reports a check on pull request #100 that has not passed and is not a GitHub Actions job/);
  pr.mergeable_state = "clean";
  // A Code analysis agent cannot ask, for its own or anyone's.
  assert.equal(await merge(look.id, { pull_request: 100 }), "team_merge: error: A Code analysis agent cannot ask for a merge; a Code edit agent of the project can.");
  assert.match(await merge(lead.id, { pull_request: "100" }), /error: pull_request must be a pull request's number/);
  // A pull request the Console did not open for an agent of this project.
  gh.pulls.push({ number: 55, head: "feature/x", base: "main", title: "Someone's", body: "", state: "open", merged: false, draft: false, mergeable: true, mergeable_state: "clean", repo: "owner/repo", sha: "f".repeat(40) });
  gh.pulls.push({ number: 56, head: branch(lead.id), base: "main", title: "A fork's", body: "", state: "closed", merged: false, draft: false, mergeable: true, mergeable_state: "clean", repo: "stranger/repo", sha: "e".repeat(40) });
  for (const n of [55, 56]) assert.equal(await merge(lead.id, { pull_request: n }), `team_merge: error: Pull request #${n} is not one the Console opened for an agent of this project, so it cannot be merged from here.`);
  assert.equal(await merge(lead.id, { pull_request: 999 }), "team_merge: error: Pull request #999 was not found in owner/repo.");
  // Commits not pushed yet: push first.
  await echo(lead.id, "gitcommit later.txt");
  assert.match(await merge(lead.id), new RegExp(`error: Your folder has commits that are not on GitHub yet \\(it is at [0-9a-f]{8}, pull request #100 at ${head.slice(0, 8)}\\)\\. Push with team_push first`));
  // A push asked for in the same turn has not run yet.
  h.store.queuePush(lead.id);
  await h.until(() => h.store.latestJob(lead.id)!.state === "done", "pushed");
  const sha = gh.headOf(pr);
  assert.notEqual(sha, head);
  assert.equal(items().length, 0);
  assert.equal(gh.merges.length, 0);

  // Asked: one item in Needs you, with the facts; the turn does not wait.
  green(sha);
  gh.state.comments.push({ author: "chatgpt-codex-connector", body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","status":"completed"}} -->\nDidn't find any major issues.` });
  gh.state.threads = 2;
  assert.equal(
    await merge(lead.id),
    `team_merge: Asked the owner to merge pull request #100 into main (squash), at commit ${sha.slice(0, 8)}. It waits in their Needs you and stays there after your turn ends; this does not wait for the answer. You are told the result at the start of a later turn. The approval is for this commit only: a push to ${branch(lead.id)} before then means asking again.`,
  );
  assert.equal(items().length, 1);
  const item = items()[0];
  assert.deepEqual([item.agentId, item.agentName, item.kind], [lead.id, "Lead", "merge"]);
  assert.equal(
    item.text,
    `Merge pull request #100 into main: "Fix sign-in"\nIts branch ${branch(lead.id)} → main · Squash and merge · commit ${sha.slice(0, 8)}\nChecks: all 2 passed (1 skipped).\nCodex review: completed on ${sha.slice(0, 8)}, no major issues. Open review threads: 2.`,
  );
  assert.deepEqual([item.merge!.url, item.merge!.sha, item.merge!.authorId], ["https://github.com/owner/repo/pull/100", sha, lead.id]);
  // It notifies as any Needs you item does, and is answered, never dismissed.
  assert.ok(needNotices(needsView(h.store)).some((n) => n.key === `notice:${item.id}` && n.title === "Lead asks to merge" && n.body.startsWith('Merge pull request #100 into main: "Fix sign-in"')));
  assert.throws(() => runCommand(h.store, { action: "dismissNotice", noticeId: item.id }), /already ended/);
  assert.throws(() => runCommand(h.store, { action: "decideMerge", noticeId: item.id, decision: "always" }), /Choose Approve or Deny/);
  // The same commit asked for again adds nothing.
  assert.match(await echo(lead.id, call("team_merge", { pull_request: 100 })), /^team_merge: Pull request #100 at commit [0-9a-f]{8} is already waiting for the owner/);
  assert.equal(items().length, 1);

  // Approved long after the asking turn ended: merged by GitHub, squash, at
  // the commit the owner saw, with GitHub's own commit title.
  assert.equal(h.store.openTurns().length, 0);
  const merged = await approve();
  assert.equal(merged.job.state, "done", merged.job.message ?? "");
  assert.deepEqual(gh.merges, [{ number: 100, body: { merge_method: "squash", sha, commit_title: "Fix sign-in (#100)" } }]);
  const tip = git(bare, "rev-parse", "refs/heads/main");
  assert.equal(git(bare, "log", "-1", "--format=%s", "main"), "Fix sign-in (#100)");
  // The branch is not deleted.
  assert.equal(git(bare, "rev-parse", `refs/heads/${branch(lead.id)}`), sha);
  const line = `Merged pull request #100 into main (squash, commit ${tip.slice(0, 8)}), approved by the owner. Lead's branch ${branch(lead.id)} is now part of main: its next work should start with team_pull(from: "main").`;
  assert.equal(merged.job.message, line);
  assert.equal(lines(lead.id).at(-1), line);
  assert.equal(items().length, 0);
  assert.throws(() => runCommand(h.store, { action: "decideMerge", noticeId: item.id, decision: "approve" }), /already been answered/);
  // The merge is no push: Changes still shows the agent's last push.
  assert.equal(h.store.latestJob(lead.id)!.kind, "push");
  // The base branch moved for everyone, without waiting for the check.
  assert.equal(projectView(h.store, h.project.id)!.agents.find((a) => a.id === builder.id)!.baseMoved, "main");
  // The agent is told at its next turn, once, then that main has new commits.
  assert.equal(
    await echo(lead.id, "next"),
    `echo: Your pull request #100 was merged into main (squash, commit ${tip.slice(0, 8)}), as the owner approved. Your branch's work is now on main as one commit, and the pull request is closed. Start your next work with team_pull(from: "main"); your next team_push then opens a new pull request.\n\nmain on GitHub has new commits that your branch does not have yet. team_pull(from: "main") brings them in.\n\nnext`,
  );
  assert.equal(await echo(lead.id, "again"), "echo: again");
  // Merged already: refused.
  assert.equal(await merge(lead.id, { pull_request: 100 }), "team_merge: error: Pull request #100 is already merged.");

  // The squash-merged branch takes main in without conflicts, and has no
  // changes of its own left against it.
  assert.match(await echo(lead.id, call("team_pull", { from: "main" })), /^team_pull: Merged main from GitHub into your branch \(commit [0-9a-f]{8}\)\. main is now at /);
  assert.equal(h.store.merging(lead.id), null);
  assert.equal(h.store.agentBase(lead.id).baseCommit, tip);
  assert.deepEqual(h.store.diff(lead.id)!.files, []);
  // Its next work goes into a new pull request with only that work as its
  // changes; the branch still carries the merged commits in its history.
  await echo(lead.id, "write second.txt");
  await h.until(() => h.store.diff(lead.id)!.files.includes("second.txt"), "committed");
  assert.deepEqual(h.store.diff(lead.id)!.files, ["second.txt"]);
  const second = await push(lead.id, "Second change");
  assert.equal(second.number, 100 + gh.pulls.length - 1);
  assert.deepEqual(git(bare, "diff", "--name-only", `main...${branch(lead.id)}`).split("\n"), ["second.txt"]);

  // A Lead asks for another agent's pull request by number; its branch
  // moves before the owner approves: nothing is merged, and both are told.
  await echo(builder.id, "main moved");
  await echo(builder.id, "write feature.txt");
  const theirs = await push(builder.id, "Add the feature");
  const seen = gh.headOf(theirs);
  green(seen);
  gh.state.comments.length = 0;
  gh.state.threads = 0;
  assert.match(await merge(lead.id, { pull_request: theirs.number }), new RegExp(`^team_merge: Asked the owner to merge pull request #${theirs.number} into main \\(squash\\), at commit ${seen.slice(0, 8)}\\.`));
  assert.equal(
    items()[0].text,
    `Merge pull request #${theirs.number} into main: "Add the feature"\nBuilder's branch ${branch(builder.id)} → main · Squash and merge · commit ${seen.slice(0, 8)}\nChecks: all 2 passed (1 skipped).\nCodex review: none requested. Open review threads: 0.`,
  );
  await echo(builder.id, "write more.txt");
  h.store.queuePush(builder.id);
  await h.until(() => gh.headOf(theirs) !== seen, "the branch moved");
  const now = gh.headOf(theirs);
  green(now);
  const moved = await approve();
  assert.equal(moved.job.state, "failed");
  assert.equal(moved.asked, false);
  const why = `Pull request #${theirs.number} changed after it was asked for: the approval was for ${seen.slice(0, 8)}, and its branch is now at ${now.slice(0, 8)}. Nothing was merged. Ask again with team_merge, so the owner approves the commit that is there now.`;
  assert.equal(lines(lead.id).at(-1), `Pull request #${theirs.number} was not merged: ${why}`);
  assert.equal(lines(builder.id).at(-1), `Pull request #${theirs.number} was not merged: ${why}`);
  assert.ok(needsView(h.store).notices.some((n) => n.kind === "note" && n.agentId === lead.id && n.text === `Pull request #${theirs.number} was not merged after your approval. ${why}`));
  assert.equal(await echo(lead.id, "and"), `echo: Pull request #${theirs.number} was not merged, though the owner approved it. ${why}\nNothing was merged. Once that is settled, ask again with team_merge.\n\nand`);

  // A check that changed between the ask and the approval: not merged.
  assert.match(await merge(lead.id, { pull_request: theirs.number }), /^team_merge: Asked the owner/);
  gh.jobs.find((j) => j.sha === now && j.name === "unit")!.conclusion = "failure";
  const failing = await approve();
  assert.deepEqual([failing.job.state, failing.asked], ["failed", false]);
  assert.match(failing.job.message!, new RegExp(`^Pull request #${theirs.number} was not merged: Pull request #${theirs.number}'s checks have not all passed for ${now.slice(0, 8)} \\(failed: CI / unit\\)`));
  gh.jobs.find((j) => j.sha === now && j.name === "unit")!.conclusion = "success";
  await echo(lead.id, "noted");

  // Deny tells the asking agent, and merges nothing.
  assert.match(await merge(lead.id, { pull_request: theirs.number }), /^team_merge: Asked the owner/);
  runCommand(h.store, { action: "decideMerge", noticeId: items()[0].id, decision: "deny" });
  assert.equal(items().length, 0);
  assert.equal(await echo(lead.id, "so"), `echo: The owner did not approve merging pull request #${theirs.number}, so it was not merged. Do not ask for it again until the owner tells you to.\n\nso`);

  // A merge GitHub itself refuses says why in plain words, to both.
  assert.match(await merge(lead.id, { pull_request: theirs.number }), /^team_merge: Asked the owner/);
  gh.state.refuse = { status: 405, message: "Repository rule violations found\n\nAt least 1 approving review is required by reviewers with write access." };
  const refused = await approve();
  assert.deepEqual([refused.job.state, refused.asked], ["failed", true]);
  assert.match(refused.job.message!, /was not merged: GitHub refused because a branch protection rule or ruleset of the repository does not allow this merge .* The owner has to act: change that rule on GitHub, or merge this one there\. \(GitHub did not merge pull request #\d+ \(405: Repository rule violations found/);
  gh.state.refuse = null;
  await echo(lead.id, "noted");

  // A pull request retargeted while GitHub works out whether it merges is
  // not the one approved: nothing is merged.
  assert.match(await merge(lead.id, { pull_request: theirs.number }), /^team_merge: Asked the owner/);
  gh.state.computing = 1;
  gh.state.retarget = "production";
  const retargeted = await approve();
  assert.deepEqual([retargeted.job.state, retargeted.asked], ["failed", false]);
  assert.match(retargeted.job.message!, /is not one the Console opened for an agent of this project/);
  gh.pulls.find((p) => p.number === theirs.number)!.base = "main";
  await echo(lead.id, "noted");

  // A workflow that is queued and has made no job yet is a check still
  // running: refused before the owner is asked.
  gh.state.queuedRun = now;
  assert.match(await merge(lead.id, { pull_request: theirs.number }), new RegExp(`^team_merge: error: Pull request #${theirs.number}'s checks have not all passed for ${now.slice(0, 8)} \\(still running: Deploy / workflow\\)`));
  gh.state.queuedRun = null;
  assert.equal(items().length, 0);

  // GitHub's answer to the merge never arrives and the pull request cannot
  // be read again: nobody is told that nothing was merged.
  assert.match(await merge(lead.id, { pull_request: theirs.number }), /^team_merge: Asked the owner/);
  gh.state.dropMerge = "unknown";
  const lost = await approve();
  assert.deepEqual([lost.job.state, lost.asked], ["failed", true]);
  assert.match(lost.job.message!, new RegExp(`^It is not known whether GitHub merged pull request #${theirs.number}`));
  assert.doesNotMatch(await echo(lead.id, "noted"), /Nothing was merged/);
  [gh.state.dropMerge, gh.state.unreadable] = [null, false];

  // The branch's agent asks for the same commit the Lead already asked for:
  // one item, and both are told the owner's answer.
  assert.match(await merge(lead.id, { pull_request: theirs.number }), /^team_merge: Asked the owner/);
  assert.match(await merge(builder.id), /^team_merge: Pull request #\d+ at commit [0-9a-f]{8} is already waiting for the owner/);
  assert.equal(items().length, 1);
  runCommand(h.store, { action: "decideMerge", noticeId: items()[0].id, decision: "deny" });
  for (const id of [lead.id, builder.id]) assert.match(await echo(id, "so"), new RegExp(`^echo: The owner did not approve merging pull request #${theirs.number}`));

  // Approved and merged: the branch's own agent is told too, and by whom.
  // GitHub has not worked out yet whether it can be merged (its base just
  // moved): the worker asks again instead of failing an approved merge.
  // GitHub's answer to the merge itself is lost, but the pull request read
  // again shows it merged, so it counts as merged.
  assert.match(await merge(lead.id, { pull_request: theirs.number }), /^team_merge: Asked the owner/);
  gh.state.computing = 1;
  gh.state.dropMerge = "merged";
  const done = await approve();
  gh.state.dropMerge = null;
  assert.equal(done.job.state, "done", done.job.message ?? "");
  assert.deepEqual(gh.merges.at(-1), { number: theirs.number, body: { merge_method: "squash", sha: now, commit_title: `Add the feature (#${theirs.number})` } });
  const top = git(bare, "rev-parse", "refs/heads/main");
  assert.match(lines(builder.id).at(-1)!, new RegExp(`^Merged pull request #${theirs.number} into main \\(squash, commit ${top.slice(0, 8)}\\), approved by the owner\\. Builder's branch`));
  assert.match(await echo(lead.id, "and"), new RegExp(`^echo: Pull request #${theirs.number} \\(Builder's\\) was merged into main \\(squash, commit ${top.slice(0, 8)}\\), as the owner approved\\.\\n\\n`));
  assert.match(await echo(builder.id, "and"), new RegExp(`^echo: Your pull request #${theirs.number} was merged into main \\(squash, commit ${top.slice(0, 8)}\\): Lead asked for it and the owner approved\\.`));

  // Why the note says to start with team_pull: work on a merged file
  // before taking main in conflicts with the squash commit of that file.
  await echo(builder.id, "write feature.txt");
  assert.match(await echo(builder.id, call("team_pull", { from: "main" })), /^team_pull: The merge of main from GitHub has conflicts in: feature\.txt\./);
  await echo(builder.id, call("team_pull_abort"));
  // Another project of the same repository cannot ask for this project's
  // pull requests.
  const other = runCommand(h.store, { action: "createProject", name: "Other", source: "github", repo: "https://github.com/owner/repo", baseBranch: "main" }).project as { id: string };
  await h.until(() => h.store.project(other.id)!.state === "ready", "second project ready");
  const stranger = runCommand(h.store, { action: "createAgent", tabId: h.store.tabs(other.id)[0].id, name: "Stranger", kind: "claude-code", model: "haiku", permission: "edit" }).agent as { id: string };
  await h.ready(stranger.id);
  await h.ended(h.send(stranger.id, call("team_merge", { pull_request: second.number })));
  const answered = h.store.events(other.id, 0, 10_000).filter((e) => e.agentId === stranger.id && e.kind === "text").map((e) => (e.body as { text: string }).text);
  assert.equal(answered.at(-1), `team_merge: error: Pull request #${second.number} is not one the Console opened for an agent of this project, so it cannot be merged from here.`);
  assert.equal(items().length, 0);
});
