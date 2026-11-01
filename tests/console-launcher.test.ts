import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Launcher, launcherEnvironment } from "../src/lib/console/launcher.ts";

// only the credentials the worker lists in `spawn --keep`
// reach an agent. The real launcher script runs here with its user check
// and home pointed at a temporary folder (no sudo, no agent account).

const SCRIPT = new URL("../scripts/console/console-agent", import.meta.url);
const zsh = existsSync("/bin/zsh");

function launcher(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "console-launcher-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = readFileSync(SCRIPT, "utf8")
    .replace("readonly AGENT_HOME=/Users/agent", `readonly AGENT_HOME=${root}`)
    .replace("[[ $(/usr/bin/id -un) == agent ]]", `[[ $(/usr/bin/id -un) == ${userInfo().username} ]]`);
  assert.notEqual(source, readFileSync(SCRIPT, "utf8"));
  const path = join(root, "console-agent");
  writeFileSync(path, source, { mode: 0o755 });
  // What reaches the program: the names of its environment.
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync("/bin/zsh", ["-f", path, ...args], { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  return { root, run };
}
const names = (stdout: string) =>
  stdout
    .split("\n")
    .map((l) => l.split("=")[0])
    // `_` is the shell's own (the program's path).
    .filter((n) => n && n !== "_")
    .sort();

const AMBIENT = {
  PATH: "/usr/bin:/bin",
  OPENAI_API_KEY: "sk-ambient-owner-key-0000000000",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-agent-token-000000000",
  OWNER_SECRET: "owner-only",
  NODE_OPTIONS: "--require /tmp/x.js",
};

test("spawn --keep passes only the listed credential, even with another key in the environment", { skip: !zsh }, (t) => {
  const { root, run } = launcher(t);
  const kept = run(["spawn", "--keep", "CLAUDE_CODE_OAUTH_TOKEN", root, "/usr/bin/env"], AMBIENT);
  assert.equal(kept.status, 0, kept.stderr);
  assert.deepEqual(names(kept.stdout), ["CLAUDE_CODE_OAUTH_TOKEN", "HOME", "LANG", "LOGNAME", "PATH", "PWD", "SHLVL", "TMPDIR", "USER"]);
  assert.match(kept.stdout, /^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-agent-token-000000000$/m);
  // No list, or an empty one: nothing crosses.
  for (const args of [["spawn", root, "/usr/bin/env"], ["spawn", "--keep", "", root, "/usr/bin/env"]]) {
    const none = run(args, AMBIENT);
    assert.equal(none.status, 0, none.stderr);
    assert.deepEqual(names(none.stdout), ["HOME", "LANG", "LOGNAME", "PATH", "PWD", "SHLVL", "TMPDIR", "USER"]);
  }
});

test("spawn --keep ZAI_API_KEY also sets ZHIPU_API_KEY, the name OpenCode's Z.AI provider reads; no other key does", { skip: !zsh }, (t) => {
  const { root, run } = launcher(t);
  const env = { ...AMBIENT, ZAI_API_KEY: "zai-FAKE-key-for-launcher-0000000000", ZHIPU_API_KEY: "zhipu-ambient-owner-0000000000" };
  const zai = run(["spawn", "--keep", "ZAI_API_KEY", root, "/usr/bin/env"], env);
  assert.equal(zai.status, 0, zai.stderr);
  assert.deepEqual(names(zai.stdout), ["HOME", "LANG", "LOGNAME", "PATH", "PWD", "SHLVL", "TMPDIR", "USER", "ZAI_API_KEY", "ZHIPU_API_KEY"]);
  assert.match(zai.stdout, /^ZHIPU_API_KEY=zai-FAKE-key-for-launcher-0000000000$/m);
  // Another key, or none: no ZHIPU_API_KEY, not even the one in the environment.
  for (const keep of ["OPENAI_API_KEY", ""]) {
    const other = run(["spawn", "--keep", keep, root, "/usr/bin/env"], env);
    assert.equal(other.status, 0, other.stderr);
    assert.ok(!names(other.stdout).includes("ZHIPU_API_KEY"), keep);
  }
  // It is not a credential the worker may name itself.
  assert.match(run(["spawn", "--keep", "ZHIPU_API_KEY", root, "/usr/bin/env"], env).stderr, /ZHIPU_API_KEY is not a credential/);
});

test("spawn --keep refuses names outside the credential list and credentials that were not given", { skip: !zsh }, (t) => {
  const { root, run } = launcher(t);
  const unlisted = run(["spawn", "--keep", "OWNER_SECRET", root, "/usr/bin/env"], AMBIENT);
  assert.equal(unlisted.status, 64);
  assert.match(unlisted.stderr, /OWNER_SECRET is not a credential/);
  const missing = run(["spawn", "--keep", "XAI_API_KEY", root, "/usr/bin/env"], AMBIENT);
  assert.equal(missing.status, 64);
  assert.match(missing.stderr, /XAI_API_KEY was not given/);
  // The working folder must still be in the agent's home.
  const outside = run(["spawn", "--keep", "", "/tmp", "/usr/bin/env"], AMBIENT);
  assert.equal(outside.status, 64);
});

// The worker refuses to start when the sweep fails, so a sweep with nothing
// to kill (after a reboot) must succeed. It once died on `status=$?`, a
// read-only special in zsh. The copy targets a user id with no processes
// (and an unknown name for pkill's own error), never a real account.
const NO_SUCH_UID = "4000123";
const freeUid = spawnSync("/usr/bin/id", [NO_SUCH_UID]).status !== 0;

test("sweep succeeds when nothing is left to kill and passes on pkill's own errors", { skip: !zsh || !freeUid || !existsSync("/usr/bin/pkill") }, (t) => {
  const { root, run } = launcher(t);
  const path = join(root, "console-agent");
  const source = readFileSync(path, "utf8");
  const sweepAs = (user: string) => {
    const targeted = source.replace("/usr/bin/pkill -KILL -U agent", `/usr/bin/pkill -KILL -U ${user}`);
    assert.notEqual(targeted, source);
    writeFileSync(path, targeted, { mode: 0o755 });
    return run(["sweep"], { PATH: "/usr/bin:/bin" });
  };
  const clean = sweepAs(NO_SUCH_UID);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stderr, "");
  const failed = sweepAs("console-no-such-user");
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /Unknown user/);
});

test("the worker starts sudo with only a fixed PATH and the selected credential", () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-ambient-owner-key-0000000000";
  try {
    assert.deepEqual(launcherEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: "t" }), {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      CLAUDE_CODE_OAUTH_TOKEN: "t",
    });
    assert.deepEqual(Object.keys(launcherEnvironment({})).sort(), ["LANG", "PATH"]);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

// ACP agent programs run in the launcher's
// sandbox profile. Allow-default reads, except the listed folders; writes
// only in the clone and its temporary folder (Look only: the temporary
// folder alone); no network but the Console's loopback port unless the
// project's switch is on. The real script and the real sandbox-exec run
// here (macOS only), with the agent's home and the shared folder pointed at
// a temporary folder.
const sandboxed = zsh && existsSync("/usr/bin/sandbox-exec");

function sandboxLauncher(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "console-sandbox-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shared = join(root, "shared");
  const source = readFileSync(SCRIPT, "utf8")
    .replace("readonly AGENT_HOME=/Users/agent", `readonly AGENT_HOME=${root}`)
    .replace("readonly SHARED=/opt/console-shared", `readonly SHARED=${shared}`)
    .replace("[[ $(/usr/bin/id -un) == agent ]]", `[[ $(/usr/bin/id -un) == ${userInfo().username} ]]`);
  const path = join(root, "console-agent");
  writeFileSync(path, source, { mode: 0o755 });
  const mine = join(root, "work", "p1", "a1");
  const mate = join(root, "work", "p1", "a2");
  const other = join(root, "work", "p2", "a3");
  for (const dir of [mine, mate, other, join(root, "projects", "p1.git"), join(root, ".codex"), join(root, ".claude"), join(root, ".kimi-code"), shared, join(root, ".tmp", "someone-else")])
    mkdirSync(dir, { recursive: true });
  for (const [dir, name] of [
    [mine, "own.txt"],
    [mate, "secret.txt"],
    [other, "secret.txt"],
    [join(root, "projects", "p1.git"), "HEAD"],
    [join(root, ".codex"), "auth.json"],
    [join(root, ".claude"), "creds"],
    [join(root, ".kimi-code"), "credentials.json"],
    [shared, "a2.json"],
    [join(root, ".tmp", "someone-else"), "scratch"],
  ])
    writeFileSync(join(dir, name), "x\n");
  const run = (level: "look" | "edit", script: string, extra: string[] = [], net = "off", port = "4999") =>
    spawnSync("/bin/zsh", ["-f", path, "spawn", "--keep", "", "--sandbox", level, "--net", net, "--port", port, "--deny", mate, ...extra, mine, "/bin/sh", "-c", script], {
      env: { PATH: "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
  return { root, path, mine, mate, other, shared, run };
}

test("spawn --sandbox: reads of the listed folders are refused, the rest of the system and the own clone are readable", { skip: !sandboxed }, (t) => {
  const s = sandboxLauncher(t);
  const ok = s.run("edit", `cat ${s.mine}/own.txt && cat /etc/hosts >/dev/null && cat "$TMPDIR"/../ 2>/dev/null; echo done`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^x\n/);
  for (const target of [
    `${s.mate}/secret.txt`,
    `${s.other}/secret.txt`,
    `${s.root}/projects/p1.git/HEAD`,
    `${s.root}/.codex/auth.json`,
    `${s.root}/.claude/creds`,
    `${s.root}/.kimi-code/credentials.json`,
    `${s.shared}/a2.json`,
    `${s.root}/.tmp/someone-else/scratch`,
  ]) {
    const r = s.run("edit", `cat ${target}`);
    assert.notEqual(r.status, 0, `read of ${target} was allowed`);
    assert.match(r.stderr, /Operation not permitted/, target);
  }
  // Kimi Code's membership login: only a program started with
  // --login kimi reads it, and nothing else may be named there.
  const kimi = s.run("edit", `cat ${s.root}/.kimi-code/credentials.json`, ["--login", "kimi"]);
  assert.equal(kimi.status, 0, kimi.stderr);
  // It also writes its own data root (sessions, settings, the login's
  // refresh), at Look only too, and still not its clone there.
  const write = s.run("look", `echo s > ${s.root}/.kimi-code/session && cat ${s.root}/.kimi-code/session`, ["--login", "kimi"]);
  assert.equal(write.status, 0, write.stderr);
  assert.notEqual(s.run("look", `echo x > ${s.mine}/probe`, ["--login", "kimi"]).status, 0);
  assert.notEqual(s.run("edit", `echo x > ${s.root}/.kimi-code/other`).status, 0);
  assert.notEqual(s.run("edit", "true", ["--login", "codex"]).status, 0);
  // A listing of another project's folder or of a teammate's is refused too.
  assert.notEqual(s.run("edit", `ls ${s.root}/work/p2`).status, 0);
  assert.notEqual(s.run("edit", `ls ${s.mate}`).status, 0);
});

test("spawn --sandbox: Gemini CLI's and Grok Build's own folders are the window's, in its temporary folder (live check 2026-10-22)", { skip: !sandboxed }, (t) => {
  const s = sandboxLauncher(t);
  const r = s.run("look", 'echo "$GEMINI_CLI_HOME|$GROK_HOME|$GROK_DISABLE_AUTOUPDATER|$TMPDIR" && echo x > "$GEMINI_CLI_HOME/f" && echo x > "$GROK_HOME/f"');
  assert.equal(r.status, 0, r.stderr);
  const [gemini, grok, noUpdate, tmp] = r.stdout.trim().split("|");
  assert.equal(gemini, `${tmp.replace(/\/$/, "")}/gemini`);
  assert.equal(grok, `${tmp.replace(/\/$/, "")}/grok`);
  assert.equal(noUpdate, "1");
});

test("spawn --sandbox: writes only in the clone and its temporary folder; Look only writes neither its clone", { skip: !sandboxed }, (t) => {
  const s = sandboxLauncher(t);
  const edit = s.run("edit", `echo y > ${s.mine}/new.txt && echo z > "$TMPDIR/t.txt" && echo ok`);
  assert.equal(edit.status, 0, edit.stderr);
  assert.ok(existsSync(join(s.mine, "new.txt")));
  for (const target of [`${s.root}/work/p1/outside.txt`, `${s.mate}/planted.txt`, `${s.root}/escape.txt`, "/tmp/console-sandbox-escape.txt"]) {
    const r = s.run("edit", `echo bad > ${target}`);
    assert.notEqual(r.status, 0, `write to ${target} was allowed`);
    assert.ok(!existsSync(target), target);
  }
  const look = s.run("look", `echo y > ${s.mine}/look.txt`);
  assert.notEqual(look.status, 0);
  assert.ok(!existsSync(join(s.mine, "look.txt")));
  assert.equal(s.run("look", `cat ${s.mine}/own.txt && echo z > "$TMPDIR/t.txt"`).status, 0);
});

test("spawn --sandbox: no network but the Console's loopback port, unless the project's switch is on", { skip: !sandboxed }, async (t) => {
  const s = sandboxLauncher(t);
  const { createServer } = await import("node:net");
  const listen = () =>
    new Promise<{ port: number; close: () => void }>((resolve) => {
      const server = createServer((c) => c.on("error", () => {}).end("hi\n")).listen(0, "127.0.0.1", () =>
        resolve({ port: (server.address() as { port: number }).port, close: () => server.close() }),
      );
    });
  const console = await listen();
  const elsewhere = await listen();
  t.after(() => {
    console.close();
    elsewhere.close();
  });
  const probe = (port: number) => `/usr/bin/nc -z -w 2 127.0.0.1 ${port}`;
  const check = (script: string, net: string) =>
    new Promise<number | null>((resolve) => {
      const child = spawn("/bin/zsh", ["-f", s.path, "spawn", "--keep", "", "--sandbox", "edit", "--net", net, "--port", String(console.port), s.mine, "/bin/sh", "-c", script], {
        env: { PATH: "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv,
      });
      child.on("close", (code: number | null) => resolve(code));
    });
  assert.equal(await check(probe(console.port), "off"), 0, "the Console's team tools stay reachable");
  assert.notEqual(await check(probe(elsewhere.port), "off"), 0, "any other connection is refused");
  assert.equal(await check(probe(elsewhere.port), "on"), 0, "the project's switch turns network on");
});

test("spawn --sandbox refuses a folder outside an agent's clone and a --deny outside its project", { skip: !zsh }, (t) => {
  const s = sandboxLauncher(t);
  const run = (args: string[]) => spawnSync("/bin/zsh", ["-f", s.path, "spawn", "--keep", "", ...args], { env: { PATH: "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
  const notClone = run(["--sandbox", "edit", "--net", "off", "--port", "4999", s.root, "/usr/bin/true"]);
  assert.equal(notClone.status, 64);
  assert.match(notClone.stderr, /runs in an agent's clone/);
  const outside = run(["--sandbox", "edit", "--net", "off", "--port", "4999", "--deny", s.other, s.mine, "/usr/bin/true"]);
  assert.equal(outside.status, 64);
  assert.match(outside.stderr, /teammate's clone in the same project/);
  const partial = run(["--sandbox", "edit", s.mine, "/usr/bin/true"]);
  assert.equal(partial.status, 64);
  assert.equal(run(["--sandbox", "all", "--net", "off", "--port", "4999", s.mine, "/usr/bin/true"]).status, 64);
});

// Just after boot sudo can refuse before macOS knows the owner's account
// ("you do not exist in the passwd database"); the call is tried again
// instead of failing the worker's start. Any other failure is not retried.
test("a launcher call sudo refuses before the user directory is up is tried again", { skip: !existsSync("/bin/sh") }, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "console-boot-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tries = join(root, "tries");
  const fake = join(root, "launcher");
  writeFileSync(
    fake,
    `#!/bin/sh\necho x >> "${tries}"\nif [ "$(wc -l < "${tries}")" -lt 3 ]; then echo "sudo: you do not exist in the passwd database" >&2; exit 1; fi\nexit 0\n`,
    { mode: 0o755 },
  );
  await new Launcher({ command: [fake], bootRetryMs: 1 }).sweep();
  assert.equal(readFileSync(tries, "utf8").trim().split("\n").length, 3);

  const other = join(root, "other");
  writeFileSync(other, `#!/bin/sh\necho x >> "${join(root, "other-tries")}"\necho "pkill: failed" >&2\nexit 2\n`, { mode: 0o755 });
  await assert.rejects(new Launcher({ command: [other], bootRetryMs: 1 }).sweep(), /The agent sweep failed: pkill: failed/);
  assert.equal(readFileSync(join(root, "other-tries"), "utf8").trim().split("\n").length, 1);
});
