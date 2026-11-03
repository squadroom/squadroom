import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/lib/console/commands.ts";
import { branchPatchView, changesView } from "../src/lib/console/views.ts";
import { checkGitHub, consoleBranch, CONSOLE_BRANCH, Mirror, parseRepo, validBranch } from "../src/lib/console/git.ts";
import { Launcher } from "../src/lib/console/launcher.ts";
import { ConsoleWorker } from "../src/lib/console/worker.ts";
import { GIT_TOKEN, harness, TOKEN } from "./helpers/console-harness.ts";

// -3: GitHub projects, clones, per-turn commits, the changes
// view and Push branch. "GitHub" is a local bare repository and a fake API;
// Git is real.

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: cwd } as Record<string, string> as NodeJS.ProcessEnv,
  }).trim();

/** A bare "GitHub" repository with `main` holding one file. */
/** The production push sequence (stage, push, always unstage) in one call. */
async function pushBranch(mirror: Mirror, bundle: string, branch: string, token: string, sha: string | null = null) {
  try {
    await mirror.pushStaged(branch, await mirror.stage(bundle, branch, sha), token);
  } finally {
    await mirror.unstage(branch);
  }
}

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
function api(ruleset: Record<string, unknown> | null = RULESET, seen: string[] = []) {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    seen.push(new Headers(init.headers).get("authorization") ?? "");
    const json = (v: unknown) => Response.json(v);
    if (url.endsWith("/repos/owner/repo")) return json({ id: 1 });
    if (url.endsWith("/branches/main")) return json({ name: "main" });
    if (url.includes("/branches/")) return new Response("{}", { status: 404 });
    if (url.includes("/rulesets?")) return json(ruleset ? [{ id: 7 }] : []);
    if (url.endsWith("/rulesets/7")) return json(ruleset);
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

test("repository names, base branches and console branches", () => {
  assert.equal(parseRepo("https://github.com/owner/repo"), "owner/repo");
  assert.equal(parseRepo("https://github.com/owner/repo.git/"), "owner/repo");
  assert.equal(parseRepo("owner/repo"), "owner/repo");
  for (const bad of ["https://evil.com/owner/repo", "owner/../x", "owner", "owner/repo/extra", 3]) assert.equal(parseRepo(bad), null);
  assert.ok(validBranch("main") && validBranch("release/1.2"));
  for (const bad of ["-x", "a..b", "a/", "x.lock", "", "a b"]) assert.ok(!validBranch(bad));
  assert.equal(consoleBranch("a0123456789ab", "Lead Dev!"), "console/a0123456789ab-lead-dev");
  assert.ok(CONSOLE_BRANCH.test(consoleBranch("a0123456789ab", "Lead")));
  assert.ok(!CONSOLE_BRANCH.test("main") && !CONSOLE_BRANCH.test("console/../main"));
});

const checkRepo = (base: string, fetcher: typeof fetch) => checkGitHub("owner/repo", base, { token: "tok", fetch: fetcher });

test("GitHub checks: the base branch exists and a ruleset names it exactly", async () => {
  const seen: string[] = [];
  await checkRepo("main", api(RULESET, seen));
  assert.ok(seen.every((h) => h === "Bearer tok"));
  await assert.rejects(checkRepo("develop", api()), /develop does not exist on GitHub/);
  // "The default branch" is not the base branch by name (check 6).
  await assert.rejects(
    checkRepo("main", api({ ...RULESET, conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } } })),
    /names it exactly/,
  );
  await assert.rejects(checkRepo("main", api({ ...RULESET, rules: [{ type: "deletion" }] })), /names it exactly/);
  await assert.rejects(checkRepo("main", api({ ...RULESET, enforcement: "evaluate" })), /names it exactly/);
  // A ruleset the token's own user may bypass protects nothing from it.
  for (const bypass of ["always", "pull_requests_only", undefined])
    await assert.rejects(checkRepo("main", api({ ...RULESET, current_user_can_bypass: bypass })), /no bypass for the token's user/);
  await assert.rejects(checkRepo("main", api(null)), /names it exactly/);
  // An exclusion that matches the base wins on GitHub.
  for (const exclude of ["refs/heads/main", "refs/heads/*", "~ALL", "~DEFAULT_BRANCH"])
    await assert.rejects(
      checkRepo("main", api({ ...RULESET, conditions: { ref_name: { include: ["refs/heads/main"], exclude: [exclude] } } })),
      /names it exactly/,
    );
  await checkRepo("main", api({ ...RULESET, conditions: { ref_name: { include: ["refs/heads/main"], exclude: ["refs/heads/dev"] } } }));
  await assert.rejects(
    checkRepo("main", (async () => new Response("{}", { status: 403 })) as typeof fetch),
    /cannot read owner\/repo \(403\)/,
  );
});

test("a GitHub project: checked, mirrored, cloned per agent; turns are committed; Push branch sends only console/", async (t) => {
  const bare = origin(t);
  const h = await harness(t, {}, false, {
    project: { source: "github", repo: "https://github.com/owner/repo", baseBranch: "main" },
    githubFetch: api(),
    remoteUrl: () => bare,
  });
  await h.worker.start();
  await h.until(() => h.store.project(h.project.id)!.state === "ready", "project ready");
  const lead = h.agent("Lead");
  const look = h.agent("Reviewer", "look");
  await h.until(() => [lead.id, look.id].every((id) => h.store.agent(id)!.state !== "creating"), "folders");
  assert.deepEqual([h.store.agent(lead.id)!.error, h.store.agent(look.id)!.error], [null, null]);
  const leadFolder = h.store.agent(lead.id)!.folder;
  const branch = h.store.agentBase(lead.id).branch!;
  assert.equal(branch, consoleBranch(lead.id, "Lead"));
  assert.equal(git(leadFolder, "rev-parse", "--abbrev-ref", "HEAD"), branch);
  assert.equal(readFileSync(join(leadFolder, "README.md"), "utf8"), "# Demo\n");
  // Look only: the base branch, detached, no branch of its own.
  assert.equal(git(h.store.agent(look.id)!.folder, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
  assert.equal(h.store.agentBase(look.id).branch, null);
  // The bundle the agents read is not world-readable.
  assert.equal(statSync(join(h.shared, `${h.project.id}.bundle`)).mode & 0o007, 0);

  const turn = h.send(lead.id, "write notes.txt");
  await h.ended(turn);
  await h.until(() => !!h.store.turn(turn)!.commitAfter, "turn committed");
  const row = h.store.turn(turn)!;
  assert.notEqual(row.commitBefore, row.commitAfter);
  // The subject is the agent's own summary; the body keeps the whole
  // request and names the agent.
  assert.equal(git(leadFolder, "log", "-1", "--format=%s"), "wrote notes.txt");
  const body = git(leadFolder, "log", "-1", "--format=%B");
  assert.match(body, /\n\nRequest:\nwrite notes\.txt\n/);
  assert.match(body, new RegExp(`\\nAgent: Lead \\(${lead.id}\\)\\nConsole-Turn: ${turn}$`));
  const view = changesView(h.store, lead.id)!;
  assert.equal(view.commits.length, 1);
  assert.match(view.commits[0].stat, /notes\.txt/);
  assert.match(branchPatchView(h.store, lead.id)!.patch, /\+written by claude/);
  // A turn that changed nothing makes no commit.
  const quiet = h.send(lead.id, "hello there");
  await h.ended(quiet);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(changesView(h.store, lead.id)!.commits.length, 1);

  // Push branch: refused while the folder has uncommitted changes.
  writeFileSync(join(leadFolder, "loose.txt"), "not committed\n");
  const early = (runCommand(h.store, { action: "push", agentId: lead.id }) as { job: { id: number } }).job;
  await h.until(() => ["done", "failed"].includes(h.store.job(early.id)!.state), "push refused");
  assert.match(h.store.job(early.id)!.message ?? "", /not committed yet/);
  // The next turn commits them on their own, not as its own work.
  const next = h.send(lead.id, "hello again");
  await h.ended(next);
  await h.until(() => changesView(h.store, lead.id)!.commits.length === 2, "leftovers committed");
  assert.equal(git(leadFolder, "log", "-1", "--format=%s"), `Console: changes not committed before turn ${next}`);
  // Push branch: the agent's branch reaches "GitHub"; the token was used by
  // the owner's mirror only, never written anywhere the agent user can read.
  const job = (runCommand(h.store, { action: "push", agentId: lead.id }) as { job: { id: number } }).job;
  await h.until(() => ["done", "failed"].includes(h.store.job(job.id)!.state), "push finished");
  assert.equal(h.store.job(job.id)!.state, "done", h.store.job(job.id)!.message ?? "");
  assert.equal(git(bare, "rev-parse", `refs/heads/${branch}`), git(leadFolder, "rev-parse", "HEAD"));
  assert.equal(git(bare, "rev-parse", "refs/heads/main"), git(leadFolder, "rev-parse", "main"));
  assert.equal(h.store.job(job.id)!.url, `https://github.com/owner/repo/compare/main...console/${branch.slice(8)}?expand=1`);
  const leak = (dir: string): boolean =>
    readdirSync(dir, { withFileTypes: true }).some((e) =>
      e.isDirectory() ? leak(join(dir, e.name)) : readFileSync(join(dir, e.name)).includes(GIT_TOKEN),
    );
  assert.ok(!leak(h.agentHome), "the GitHub token reached the agent's files");
  assert.ok(!leak(h.shared), "the GitHub token reached the shared folder");
  assert.throws(() => runCommand(h.store, { action: "push", agentId: look.id }), /Code analysis/);
  // A commit made after the turn ended (a program the agent left running)
  // was never checked, so it is not pushed until a turn has seen it.
  writeFileSync(join(leadFolder, "late.txt"), "after the turn\n");
  git(leadFolder, "add", "late.txt");
  git(leadFolder, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "--quiet", "-m", "late");
  const stray = (runCommand(h.store, { action: "push", agentId: lead.id }) as { job: { id: number } }).job;
  await h.until(() => ["done", "failed"].includes(h.store.job(stray.id)!.state), "push refused");
  assert.match(h.store.job(stray.id)!.message ?? "", /has a commit the Console has not checked/);
  assert.notEqual(git(bare, "rev-parse", `refs/heads/${branch}`), git(leadFolder, "rev-parse", "HEAD"));
  // The next turn records it (Changes shows it), and then it pushes.
  await h.ended(h.send(lead.id, "hello once more"));
  assert.ok(changesView(h.store, lead.id)!.diff!.files.includes("late.txt"));
  const after = (runCommand(h.store, { action: "push", agentId: lead.id }) as { job: { id: number } }).job;
  await h.until(() => ["done", "failed"].includes(h.store.job(after.id)!.state), "push after the turn");
  assert.equal(h.store.job(after.id)!.state, "done", h.store.job(after.id)!.message ?? "");
  assert.equal(git(bare, "rev-parse", `refs/heads/${branch}`), git(leadFolder, "rev-parse", "HEAD"));

  // A branch holding a credential the Console handed out is never pushed.
  const leaked = h.send(lead.id, "leak debug.txt");
  await h.ended(leaked);
  await h.until(() => !!h.store.turn(leaked)!.commitAfter, "leak committed");
  const refused = (runCommand(h.store, { action: "push", agentId: lead.id }) as { job: { id: number } }).job;
  await h.until(() => ["done", "failed"].includes(h.store.job(refused.id)!.state), "push refused");
  assert.match(h.store.job(refused.id)!.message ?? "", /contains a credential/);
  assert.notEqual(git(bare, "rev-parse", `refs/heads/${branch}`), git(leadFolder, "rev-parse", "HEAD"));
  // And never while the agent works.
  const busy = h.send(lead.id, "hang");
  await h.started(busy);
  assert.throws(() => runCommand(h.store, { action: "push", agentId: lead.id }), /is working/);
});

test("team_push: the owner approves in Needs you; the branch is pushed after the turn commits", async (t) => {
  const bare = origin(t);
  const h = await harness(t, {}, false, {
    project: { source: "github", repo: "https://github.com/owner/repo", baseBranch: "main" },
    githubFetch: api(),
    remoteUrl: () => bare,
  });
  await h.worker.start();
  await h.until(() => h.store.project(h.project.id)!.state === "ready", "project ready");
  const lead = h.agent("Lead");
  const look = h.agent("Reviewer", "look");
  await h.ready(lead.id, look.id);
  const branch = h.store.agentBase(lead.id).branch!;
  await h.ended(h.send(lead.id, "write notes.txt"));
  const asked = h.send(lead.id, "team_push");
  await h.until(() => h.store.openRequests().length === 1, "approval asked");
  const [request] = h.store.openRequests();
  assert.deepEqual([request.tool, request.summary], ["team_push", `Push ${branch} to GitHub and open its pull request\n\nNo description given: a new pull request is described by the agent's final message and its commits.`]);
  // A message queued meanwhile waits: the push carries exactly the work
  // that was approved, before any later turn starts.
  const later = h.send(lead.id, "write later.txt");
  runCommand(h.store, { action: "decide", requestId: request.id, decision: "always" });
  await h.ended(asked);
  assert.match(h.said(lead.id).at(-1)!, /^team_push: Approved\. console\/.+ is pushed after this turn ends/);
  await h.until(() => h.store.latestJob(lead.id)?.state === "done", "pushed");
  await h.ended(later);
  assert.equal(git(bare, "rev-parse", `refs/heads/${branch}`), h.store.turn(later)!.commitBefore);
  assert.doesNotMatch(git(bare, "ls-tree", "--name-only", `refs/heads/${branch}`), /later\.txt/);
  assert.match(git(bare, "ls-tree", "--name-only", `refs/heads/${branch}`), /notes\.txt/);
  await h.until(() => h.events(lead.id).some((e) => e.kind === "push"), "shown in the window");
  // "Always for this agent": the next push needs no approval.
  await h.ended(h.send(lead.id, "team_push"));
  assert.equal(h.store.openRequests().length, 0);
  assert.match(h.said(lead.id).at(-1)!, /^team_push: Approved/);
  // A Look only agent has no branch to push.
  await h.ended(h.send(look.id, "team_push"));
  assert.match(h.said(look.id).at(-1)!, /error: A Code analysis agent has no branch to push/);
});

test("cleanup: a closed agent's branch that was never pushed carries a warning; a pushed one does not", async (t) => {
  const bare = origin(t);
  const h = await harness(t, {}, false, {
    project: { source: "github", repo: "https://github.com/owner/repo", baseBranch: "main" },
    githubFetch: api(),
    remoteUrl: () => bare,
  });
  await h.worker.start();
  await h.until(() => h.store.project(h.project.id)!.state === "ready", "project ready");
  const pushed = h.agent("Pushed");
  const kept = h.agent("Kept");
  await h.ready(pushed.id, kept.id);
  for (const a of [pushed, kept]) {
    const turn = h.send(a.id, "write notes.txt");
    await h.ended(turn);
    await h.until(() => !!h.store.turn(turn)!.commitAfter, "committed");
  }
  const job = (runCommand(h.store, { action: "push", agentId: pushed.id }) as { job: { id: number } }).job;
  await h.until(() => h.store.job(job.id)!.state === "done", "pushed");
  for (const a of [pushed, kept]) runCommand(h.store, { action: "close", agentId: a.id });
  await h.until(() => h.worker.runningCount() === 0, "closed");
  // Closed agents' folders are listed once their processes have exited.
  let items: { key: string; warning: string | null }[] = [];
  for (let i = 0; i < 50 && items.filter((x) => x.key.startsWith(`work/${h.project.id}/`)).length < 2; i++) {
    const { cleanupId } = runCommand(h.store, { action: "cleanupScan" }) as { cleanupId: number };
    await h.until(() => h.store.cleanup(cleanupId)!.state === "done", "scanned");
    items = (h.store.cleanup(cleanupId)!.result as { items: { key: string; warning: string | null }[] }).items;
    await new Promise((r) => setTimeout(r, 100));
  }
  const warning = (id: string) => items.find((i) => i.key === `work/${h.project.id}/${id}`)!.warning;
  assert.equal(warning(pushed.id), null);
  assert.equal(warning(kept.id), `1 commit on ${h.store.agentBase(kept.id).branch} was never pushed to GitHub.`);
});

test("the mirror counts a commit as on GitHub only after its push succeeded", async (t) => {
  const bare = origin(t);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "console-mirror-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, "work");
  git(root, "clone", "--quiet", bare, work);
  const branch = "console/a000000000001-lead";
  git(work, "checkout", "--quiet", "-b", branch);
  writeFileSync(join(work, "x.txt"), "x\n");
  git(work, "add", "x.txt");
  git(work, "-c", "user.name=A", "-c", "user.email=a@x", "commit", "--quiet", "-m", "x");
  const sha = git(work, "rev-parse", "HEAD");
  const bundle = join(root, "b.bundle");
  git(work, "bundle", "create", "--quiet", bundle, `refs/heads/${branch}`);
  const dir = join(root, "mirror.git");
  await new Mirror(dir, "owner/repo", bare).update("tok");
  // The push fails after the branch reached the mirror: not counted.
  await assert.rejects(pushBranch(new Mirror(dir, "owner/repo", join(root, "missing.git")), bundle, branch, "tok"), /Pushing/);
  assert.equal(await new Mirror(dir, "owner/repo", bare).hasCommit(sha), false);
  // What was checked is what is pushed: a bundle whose branch
  // is not the commit resolved for the push is refused on the owner's side.
  const mirror = new Mirror(dir, "owner/repo", bare);
  await assert.rejects(mirror.stage(bundle, branch, "0".repeat(40)), /moved while it was being pushed/);
  await mirror.unstage(branch);
  // The scan sees the staged commit's new objects, raw: a blob's bytes.
  assert.equal(await mirror.stage(bundle, branch, sha), sha);
  await assert.rejects(mirror.scanNew(sha, (bytes) => bytes.equals(Buffer.from("x\n"))), /contains a credential/);
  await assert.rejects(mirror.scanNew(sha, () => false, { bytes: 1, objects: 1000 }), /too large/);
  await assert.rejects(mirror.scanNew(sha, () => false, { bytes: 1_000_000, objects: 1 }), /too large/);
  await mirror.scanNew(sha, () => false);
  await mirror.unstage(branch);
  await pushBranch(new Mirror(dir, "owner/repo", bare), bundle, branch, "tok", sha);
  assert.equal(await new Mirror(dir, "owner/repo", bare).hasCommit(sha), true);
  assert.equal(git(bare, "rev-parse", `refs/heads/${branch}`), sha);
  // A large blob arrives in many chunks and is read whole, once (in linear
  // time): a secret anywhere in it is found, a clean one passes within the
  // bound.
  writeFileSync(join(work, "big.bin"), Buffer.concat([randomBytes(3 * 1024 * 1024), Buffer.from("x\n"), randomBytes(3 * 1024 * 1024)]));
  git(work, "add", "big.bin");
  git(work, "-c", "user.name=A", "-c", "user.email=a@x", "commit", "--quiet", "-m", "big");
  const big = git(work, "rev-parse", "HEAD");
  git(work, "bundle", "create", "--quiet", bundle, `refs/heads/${branch}`);
  assert.equal(await mirror.stage(bundle, branch, big), big);
  const sizes: number[] = [];
  await assert.rejects(mirror.scanNew(big, (bytes) => (sizes.push(bytes.length), bytes.includes("x\n"))), /contains a credential/);
  assert.ok(sizes.includes(6 * 1024 * 1024 + 2), String(sizes));
  await mirror.scanNew(big, () => false, { bytes: 7 * 1024 * 1024, objects: 100 });
  await assert.rejects(mirror.scanNew(big, () => false, { bytes: 6 * 1024 * 1024, objects: 100 }), /too large/);
  await mirror.unstage(branch);
  git(work, "reset", "--quiet", "--hard", sha);
  git(work, "bundle", "create", "--quiet", bundle, `refs/heads/${branch}`);
  // Once on GitHub, nothing of the branch is new, so nothing is scanned.
  let scanned = 0;
  await new Mirror(dir, "owner/repo", bare).scanNew(sha, () => (scanned++, true));
  assert.equal(scanned, 0);
});

test("the mirror stages only a real bundle of the branch alone, never its tags, and its baseline is GitHub's branches", async (t) => {
  const bare = origin(t);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "console-mirror-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, "work");
  git(root, "clone", "--quiet", bare, work);
  const branch = "console/a000000000001-lead";
  git(work, "checkout", "--quiet", "-b", branch);
  writeFileSync(join(work, "x.txt"), "x\n");
  git(work, "add", "x.txt");
  git(work, "-c", "user.name=A", "-c", "user.email=a@x", "commit", "--quiet", "-m", "x");
  const sha = git(work, "rev-parse", "HEAD");
  const dir = join(root, "mirror.git");
  const mirror = new Mirror(dir, "owner/repo", bare);
  await mirror.update("tok");
  // A `gitdir:` file would make the fetch read the agent's repository.
  const gitfile = join(root, "gitfile.bundle");
  writeFileSync(gitfile, `gitdir: ${join(work, ".git")}\n`);
  await assert.rejects(mirror.stage(gitfile, branch, sha), /not a Git bundle/);
  // A tag riding along (it would join the baseline), or another branch.
  git(work, "tag", "planted", sha);
  const tagged = join(root, "tagged.bundle");
  git(work, "bundle", "create", "--quiet", tagged, `refs/heads/${branch}`, "refs/tags/planted");
  await assert.rejects(mirror.stage(tagged, branch, sha), /does not hold its branch alone/);
  const other = join(root, "other.bundle");
  git(work, "branch", "console/other", sha);
  git(work, "bundle", "create", "--quiet", other, "refs/heads/console/other");
  await assert.rejects(mirror.stage(other, branch, sha), /does not hold its branch alone/);
  assert.throws(() => git(dir, "rev-parse", "--verify", "--quiet", "refs/tags/planted"));
  // A tag in the mirror (however it got there) does not hide new objects.
  const bundle = join(root, "b.bundle");
  git(work, "bundle", "create", "--quiet", bundle, `refs/heads/${branch}`);
  assert.equal(await mirror.stage(bundle, branch, sha), sha);
  git(dir, "update-ref", "refs/tags/planted", sha);
  await assert.rejects(mirror.scanNew(sha, (bytes) => bytes.equals(Buffer.from("x\n"))), /contains a credential/);
  assert.equal(await mirror.addsConsoleFiles(sha), false);
  await mirror.unstage(branch);
  // Uploads the agent committed itself, even removed again later.
  mkdirSync(join(work, ".console-uploads"));
  writeFileSync(join(work, ".console-uploads", "contract.pdf"), "%PDF private\n");
  git(work, "add", "-f", ".console-uploads/contract.pdf");
  git(work, "-c", "user.name=A", "-c", "user.email=a@x", "commit", "--quiet", "-m", "upload");
  git(work, "rm", "--quiet", "-r", "--cached", ".console-uploads");
  git(work, "-c", "user.name=A", "-c", "user.email=a@x", "commit", "--quiet", "-m", "gone");
  const later = git(work, "rev-parse", "HEAD");
  git(work, "bundle", "create", "--quiet", bundle, `refs/heads/${branch}`);
  assert.equal(await mirror.stage(bundle, branch, later), later);
  assert.equal(await mirror.addsConsoleFiles(later), true);
  await mirror.unstage(branch);
});

/** Files committed directly in an agent's folder (as the test user), the
 * way an agent's own `git commit` or an earlier turn would leave them. */
function commitFiles(folder: string, message: string, files: Record<string, string | Buffer>) {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(folder, name), content);
  git(folder, "add", "-A");
  git(folder, "-c", "user.name=Agent", "-c", "user.email=a@x", "commit", "--quiet", "--no-verify", "-m", message);
}
/** A commit made outside a turn, recorded as a turn's end would record it
 * (Push branch sends only a recorded head). */
async function recorded(worker: ConsoleWorker, store: ConsoleWorker["store"], agentId: string) {
  await worker.repos.refreshDiff(store.agent(agentId)!, worker.epoch!);
}

test("Push branch checks the objects GitHub lacks, not a patch: binary and -diff blobs, removed history, messages and a moved base ref are refused; a clean binary artifact pushes", async (t) => {
  const bare = origin(t);
  const h = await harness(t, {}, false, {
    project: { source: "github", repo: "https://github.com/owner/repo", baseBranch: "main" },
    githubFetch: api(),
    remoteUrl: () => bare,
  });
  await h.worker.start();
  await h.until(() => h.store.project(h.project.id)!.state === "ready", "project ready");
  const names = ["Nul", "Attr", "Moved", "Message", "Clean"] as const;
  const agents = Object.fromEntries(names.map((n) => [n, h.agent(n)])) as Record<(typeof names)[number], { id: string }>;
  await h.ready(...names.map((n) => agents[n].id));
  const folder = (n: (typeof names)[number]) => h.store.agent(agents[n].id)!.folder;
  const branch = (n: (typeof names)[number]) => h.store.agentBase(agents[n].id).branch!;
  const push = async (n: (typeof names)[number]) => {
    await recorded(h.worker, h.store, agents[n].id);
    const { job } = runCommand(h.store, { action: "push", agentId: agents[n].id }) as { job: { id: number } };
    await h.until(() => ["done", "failed"].includes(h.store.job(job.id)!.state), `push ${n}`);
    return h.store.job(job.id)!;
  };
  const refused = async (n: (typeof names)[number]) => {
    const job = await push(n);
    assert.equal(job.state, "failed", `${n}: ${job.message}`);
    assert.match(job.message ?? "", /contains a credential/);
    assert.throws(() => git(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${branch(n)}`), `${n} reached GitHub`);
  };
  // A binary blob (NUL bytes) holding the token: no patch shows it.
  commitFiles(folder("Nul"), "archive", { "archive.bin": Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(TOKEN), Buffer.from([0, 255])]) });
  await refused("Nul");
  // Removed again in a later commit: the history still carries it.
  git(folder("Nul"), "rm", "--quiet", "archive.bin");
  git(folder("Nul"), "-c", "user.name=Agent", "-c", "user.email=a@x", "commit", "--quiet", "--no-verify", "-m", "remove it");
  await refused("Nul");
  // A text file Git is told not to diff.
  commitFiles(folder("Attr"), "attributes", { ".gitattributes": "secret.txt -diff\n", "secret.txt": `token=${TOKEN}\n` });
  await refused("Attr");
  // A plain-text secret behind the clone's own base ref, which the agent
  // controls: the baseline is the owner's mirror, not that ref.
  commitFiles(folder("Moved"), "notes", { "notes.txt": `${TOKEN}\n` });
  git(folder("Moved"), "update-ref", "refs/heads/main", "HEAD");
  await refused("Moved");
  // A commit message holding the token.
  commitFiles(folder("Message"), `debug ${TOKEN}`, { "ok.txt": "fine\n" });
  await refused("Message");
  // A clean binary artifact is pushed as before.
  const icon = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), randomBytes(2048)]);
  commitFiles(folder("Clean"), "icon", { "icon.png": icon });
  const done = await push("Clean");
  assert.equal(done.state, "done", done.message ?? "");
  assert.equal(git(bare, "rev-parse", `refs/heads/${branch("Clean")}`), git(folder("Clean"), "rev-parse", "HEAD"));
  assert.match(git(bare, "ls-tree", "--name-only", `refs/heads/${branch("Clean")}`), /icon\.png/);
});

test("Push branch refuses a branch whose commits add the owner's uploads", async (t) => {
  const bare = origin(t);
  const h = await harness(t, {}, false, {
    project: { source: "github", repo: "https://github.com/owner/repo", baseBranch: "main" },
    githubFetch: api(),
    remoteUrl: () => bare,
  });
  await h.worker.start();
  await h.until(() => h.store.project(h.project.id)!.state === "ready", "project ready");
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  const folder = h.store.agent(lead.id)!.folder;
  const branch = h.store.agentBase(lead.id).branch!;
  // The agent forces an upload into a commit of its own.
  mkdirSync(join(folder, ".console-uploads"), { recursive: true });
  writeFileSync(join(folder, ".console-uploads", "contract.pdf"), "%PDF private\n");
  git(folder, "add", "-f", ".console-uploads/contract.pdf");
  git(folder, "-c", "user.name=Agent", "-c", "user.email=a@x", "commit", "--quiet", "--no-verify", "-m", "upload");
  await recorded(h.worker, h.store, lead.id);
  const { job } = runCommand(h.store, { action: "push", agentId: lead.id }) as { job: { id: number } };
  await h.until(() => ["done", "failed"].includes(h.store.job(job.id)!.state), "push");
  assert.equal(h.store.job(job.id)!.state, "failed");
  assert.match(h.store.job(job.id)!.message ?? "", /add files under \.console-uploads/);
  assert.throws(() => git(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`));
});

test("the push check knows every key in the key file, in a worker that never handed one out", async (t) => {
  const bare = origin(t);
  const h = await harness(t, {}, false, {
    project: { source: "github", repo: "https://github.com/owner/repo", baseBranch: "main" },
    githubFetch: api(),
    remoteUrl: () => bare,
  });
  // A key no Claude Code agent is ever handed, present only in the file.
  const GEMINI = "AIzaSyFAKE-gemini-key-0000000000000000000";
  const keysFile = join(h.root, "keys.json");
  writeFileSync(keysFile, JSON.stringify({ keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN }, CONSOLE_GIT_TOKEN: { value: GIT_TOKEN }, GEMINI_API_KEY: { value: GEMINI } }, projects: {} }), { mode: 0o600 });
  await h.worker.start();
  await h.until(() => h.store.project(h.project.id)!.state === "ready", "project ready");
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  commitFiles(h.store.agent(lead.id)!.folder, "config", { "config.env": `GEMINI_API_KEY=${GEMINI}\n` });
  await recorded(h.worker, h.store, lead.id);
  // A new worker on the same store: it spawned nothing, so it was handed
  // nothing; the key file alone must tell it what to refuse.
  await h.worker.stop();
  const next = new ConsoleWorker({
    store: h.store,
    launcher: new Launcher({ command: [join(h.root, "launcher")] }),
    paths: { agentHome: h.agentHome, shared: h.shared },
    keysFile,
    binary: () => join(h.root, "claude"),
    tickMs: 25,
    renewMs: 100,
    stopGraceMs: 300,
    log: () => {},
    mirrorsDir: join(h.root, "mirrors"),
    githubFetch: api(),
    remoteUrl: () => bare,
    freeBytes: () => 1024 ** 4,
  });
  try {
    await next.start();
    const { job } = runCommand(h.store, { action: "push", agentId: lead.id }) as { job: { id: number } };
    await h.until(() => ["done", "failed"].includes(h.store.job(job.id)!.state), "push refused");
    assert.equal(h.store.job(job.id)!.state, "failed");
    assert.match(h.store.job(job.id)!.message ?? "", /contains a credential/);
    assert.throws(() => git(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${h.store.agentBase(lead.id).branch}`));
  } finally {
    await next.stop();
  }
});

test("a worker that never spawned an agent refuses to push a branch holding a project's own key from the key file", async (t) => {
  const bare = origin(t);
  const h = await harness(t, {}, false, {
    project: { source: "github", repo: "https://github.com/owner/repo", baseBranch: "main" },
    githubFetch: api(),
    remoteUrl: () => bare,
  });
  // The new shape, with the key only in the project's own overrides, and a
  // cap whose link must not block a push that mentions it.
  const OVERRIDE = "sk-proj-FAKE-project-only-key-2222222222222";
  const cap = { usd: 10, url: "https://platform.openai.com/settings/organization/limits", checkedAt: "2026-10-20" };
  const keysFile = join(h.root, "keys.json");
  writeFileSync(
    keysFile,
    JSON.stringify({
      keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN }, CONSOLE_GIT_TOKEN: { value: GIT_TOKEN } },
      projects: { [h.project.id]: { OPENAI_API_KEY: { value: OVERRIDE, cap } } },
    }),
    { mode: 0o600 },
  );
  await h.worker.start();
  await h.until(() => h.store.project(h.project.id)!.state === "ready", "project ready");
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  commitFiles(h.store.agent(lead.id)!.folder, "limits", { "LIMITS.md": `Set the cap at ${cap.url} (checked ${cap.checkedAt}, $${cap.usd}).\n` });
  await recorded(h.worker, h.store, lead.id);
  await h.worker.stop();
  const next = new ConsoleWorker({
    store: h.store,
    launcher: new Launcher({ command: [join(h.root, "launcher")] }),
    paths: { agentHome: h.agentHome, shared: h.shared },
    keysFile,
    binary: () => join(h.root, "claude"),
    tickMs: 25,
    renewMs: 100,
    stopGraceMs: 300,
    log: () => {},
    mirrorsDir: join(h.root, "mirrors"),
    githubFetch: api(),
    remoteUrl: () => bare,
    freeBytes: () => 1024 ** 4,
  });
  try {
    await next.start();
    // The cap's link and date are not secrets: that branch pushes.
    const first = runCommand(h.store, { action: "push", agentId: lead.id }) as { job: { id: number } };
    await h.until(() => ["done", "failed"].includes(h.store.job(first.job.id)!.state), "first push");
    assert.equal(h.store.job(first.job.id)!.state, "done", h.store.job(first.job.id)!.message ?? "");
    // The project's own key is: refused, in a worker that handed out nothing.
    commitFiles(h.store.agent(lead.id)!.folder, "config", { "config.env": `OPENAI_API_KEY=${OVERRIDE}\n` });
    await recorded(next, h.store, lead.id);
    const second = runCommand(h.store, { action: "push", agentId: lead.id }) as { job: { id: number } };
    await h.until(() => ["done", "failed"].includes(h.store.job(second.job.id)!.state), "second push");
    assert.equal(h.store.job(second.job.id)!.state, "failed");
    assert.match(h.store.job(second.job.id)!.message ?? "", /contains a credential/);
  } finally {
    await next.stop();
  }
});

test("no new clone when free disk would fall below the floor", async (t) => {
  const h = await harness(t, {}, false, { freeBytes: 1024 ** 3 });
  await h.worker.start();
  const lead = h.agent();
  await h.until(() => h.store.agent(lead.id)!.state === "error", "refused");
  assert.match(h.store.agent(lead.id)!.error!, /Not enough free disk/);
});

test("a GitHub project whose base branch is missing or unprotected is refused before any clone", async (t) => {
  const bare = origin(t);
  const h = await harness(t, {}, false, {
    project: { source: "github", repo: "owner/repo", baseBranch: "main" },
    githubFetch: api({ ...RULESET, conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } } }),
    remoteUrl: () => bare,
  });
  await h.worker.start();
  await h.until(() => h.store.project(h.project.id)!.state === "error", "project refused");
  assert.match(h.store.project(h.project.id)!.error!, /names it exactly/);
  const lead = h.agent("Lead");
  await h.until(() => h.store.agent(lead.id)!.state === "error", "agent refused");
  assert.match(h.store.agent(lead.id)!.error!, /not ready/);
});

test("a new-folder project: one shared repository, a branch per editing agent, a commit per turn", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  await h.ready(lead.id);
  const reviewer = h.agent("Reviewer", "look");
  await h.ready(reviewer.id);
  const folder = h.store.agent(lead.id)!.folder;
  assert.equal(git(folder, "log", "--format=%s"), "Start");
  assert.equal(git(folder, "rev-parse", "--abbrev-ref", "HEAD"), consoleBranch(lead.id, "Lead"));
  // Both agents start from the project's own repository: one history.
  const repo = join(h.agentHome, "projects", `${h.project.id}.git`);
  const root = git(repo, "rev-parse", "refs/heads/main");
  assert.equal(git(folder, "rev-parse", "main"), root);
  assert.equal(git(h.store.agent(reviewer.id)!.folder, "rev-parse", "HEAD"), root);
  const turn = h.send(lead.id, "write a.txt");
  await h.ended(turn);
  await h.until(() => !!h.store.turn(turn)!.commitAfter, "turn committed");
  assert.equal(git(folder, "log", "--format=%s").split("\n").length, 2);
  assert.match(changesView(h.store, lead.id)!.diff!.stat, /a\.txt/);
  // A project without files has no commits.
  const talk = runCommand(h.store, { action: "createProject", name: "Talk", source: "none" }).project as { id: string };
  const talker = runCommand(h.store, {
    action: "createAgent",
    tabId: h.store.tabs(talk.id)[0].id,
    name: "Talker",
    kind: "claude-code",
    model: "haiku",
    permission: "look",
  }).agent as { id: string };
  await h.ready(talker.id);
  const said = h.send(talker.id, "hello");
  await h.ended(said);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(h.store.turn(said)!.commitAfter, null);
});
