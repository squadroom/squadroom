import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { ACP_CLIENTS, CLIENT_VERSIONS } from "../src/lib/console/clients.ts";
import { envFileProblem } from "../src/config/server-env.ts";

// The setup script installs each client from its committed lockfile
// (scripts/console/clients/<name>), and bakes this host's paths into the
// launcher with sed. These checks keep both in step with the code.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const PINNED: Record<string, { package: string; version: string }> = {
  claude: { package: "@anthropic-ai/claude-code", version: CLIENT_VERSIONS.claude },
  codex: { package: "@openai/codex", version: CLIENT_VERSIONS.codex },
  ...ACP_CLIENTS,
};

test("every client has a committed lockfile pinned to its version in clients.ts, and no other client has one", () => {
  const dirs = readdirSync(new URL("../scripts/console/clients/", import.meta.url)).sort();
  assert.deepEqual(dirs, Object.keys(PINNED).sort());
  for (const [name, { package: pkg, version }] of Object.entries(PINNED)) {
    const manifest = JSON.parse(read(`scripts/console/clients/${name}/package.json`));
    assert.deepEqual(manifest.dependencies, { [pkg]: version }, `${name}/package.json`);
    const lock = JSON.parse(read(`scripts/console/clients/${name}/package-lock.json`));
    assert.equal(lock.lockfileVersion, 3, `${name}: lockfile version`);
    assert.deepEqual(lock.packages[""].dependencies, { [pkg]: version }, `${name}: the lockfile is of its package.json`);
    const entry = lock.packages[`node_modules/${pkg}`];
    assert.equal(entry?.version, version, `${name}: locked ${pkg}`);
    // Every package comes from the npm registry with an integrity hash.
    for (const [path, p] of Object.entries(lock.packages as Record<string, { resolved?: string; integrity?: string; link?: boolean }>)) {
      if (path === "" || p.link) continue;
      assert.match(p.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, `${name}: ${path} resolved`);
      assert.match(p.integrity ?? "", /^sha512-/, `${name}: ${path} integrity`);
    }
  }
});

test("each path line the setup script replaces in the launcher is there exactly once", () => {
  const setup = read("scripts/console/setup-agent-user.sh");
  const launcher = read("scripts/console/console-agent");
  const targets = [...setup.matchAll(/-e "s\|\^(readonly [A-Z_]+=[^\\$|]+)\\\$\|/g)].map((m) => m[1]);
  assert.deepEqual(targets.map((t) => t.split("=")[0]), ["readonly AGENT_HOME", "readonly SHARED", "readonly CLIENTS", "readonly NODE_BIN"]);
  for (const line of targets) assert.equal(launcher.split("\n").filter((l) => l === line).length, 1, line);
  // The Node the clients were installed with is on the agents' PATH.
  assert.match(launcher, /PATH=\$CLIENTS:\$NODE_BIN:/);
});

test("the setup script looks for Homebrew's keg-only node@24 and refuses to run over live agents without --force", () => {
  const setup = read("scripts/console/setup-agent-user.sh");
  assert.match(setup, /\/opt\/homebrew\/opt\/node@24\/bin\/node \/usr\/local\/opt\/node@24\/bin\/node \$owner_node/);
  assert.match(setup, /running=\$\(agent_programs\) && \[\[ -n \$running \]\]; then\n\s+\(\( force \)\) \|\| fail/);
  // The clients install as the agent user, from their lockfiles, never as root.
  assert.match(setup, /sudo -u \$AGENT \/usr\/bin\/env -i [^\n]*\\\n[^\n]*\\\n\s+\$NODE_BIN\/npm ci /);
  assert.doesNotMatch(setup, /npm install/);
  // The version checks run with the agent's own home: the owner's is not
  // writable to it, and opencode, gemini and codex fail on it.
  assert.doesNotMatch(setup, /sudo -u \$AGENT \$CLIENTS/);
  assert.match(setup, /sudo -H -u \$AGENT \$CLIENTS\/bin\/claude --version/);
});

test("the setup script defines every helper it calls", () => {
  const setup = read("scripts/console/setup-agent-user.sh");
  for (const helper of ["step", "fail", "warn"])
    if (new RegExp(`(^\\s*|[|&;] *|\\{ *)${helper} `, "m").test(setup)) assert.match(setup, new RegExp(`^${helper}\\(\\) \\{`, "m"), helper);
});

test("setup stops the Console worker before installing and starts it again on exit, even on failure", () => {
  const script = read("scripts/console/setup-agent-user.sh");
  const stop = script.indexOf("/bin/launchctl bootout $WORKER");
  const trap = script.indexOf("trap restart_worker EXIT");
  const install = script.indexOf("npm ci --no-audit");
  assert.ok(stop > 0 && trap > 0 && install > 0);
  // The trap is set before the worker stops, and both before any install:
  // a running worker ends every agent process each time it stops.
  assert.ok(trap < stop && stop < install);
  const restart = script.slice(script.indexOf("restart_worker() {"), script.indexOf("\n}\n", script.indexOf("restart_worker() {")));
  assert.match(restart, /launchctl bootstrap gui\/\$OWNER_UID \$WORKER_PLIST/);
  // A failed restart says so rather than claiming success.
  assert.match(restart, /warn "the Console worker did not start again/);
  // Running turns are checked in the store before the worker is stopped,
  // and setup waits for the old worker to unload before going on.
  const turns = script.indexOf("from console_turns where status in ('running', 'waiting_for_owner')");
  assert.ok(turns > 0 && turns < stop);
  assert.match(script, /readonly STORE=\$\{CONSOLE_STORE:-/);
  assert.match(script.slice(stop, install), /for try in \{1\.\.60\}; do worker_loaded \|\| break/);
});

test("the running-programs check ignores macOS's own processes for the agent account", () => {
  const script = read("scripts/console/setup-agent-user.sh");
  const pattern = script.match(/agent_programs\(\) \{[^}]*grep -Ev '([^']+)'/)?.[1];
  assert.ok(pattern, "the filter is found");
  const ignored = new RegExp(pattern);
  for (const system of ["/usr/sbin/distnoted", "/usr/sbin/cfprefsd", "/usr/libexec/secd", "/System/Library/Frameworks/x"]) assert.ok(ignored.test(system), system);
  for (const agent of ["/usr/local/bin/node", "/opt/console-clients/codex-0.155.1/node_modules/.bin/codex", "/bin/zsh"]) assert.ok(!ignored.test(agent), agent);
  assert.doesNotMatch(script, /running=\$\(\/usr\/bin\/pgrep -U \$AGENT\)/);
});

test("setup copies the clients without access lists or extended attributes, and removes any left", () => {
  const script = read("scripts/console/setup-agent-user.sh");
  assert.match(script, /\/usr\/bin\/ditto --noacl --noextattr \$stage\/pkg \$prefix\.new/);
  const acl = script.indexOf("/bin/chmod -R -N $prefix.new");
  assert.ok(acl > script.indexOf("chown -R root:wheel $prefix.new") && acl < script.indexOf("/bin/chmod -R a-w,ug-s $prefix.new"));
});

// .env.local holds the sign-in's secrets. Created 0644 and in a checkout
// outside the home folder, the agent user could read it.
test("setup's boundary check reads this checkout and its .env.local as the agent user", () => {
  const script = read("scripts/console/setup-agent-user.sh");
  assert.match(script, /readonly CHECKOUT=\$\{HERE:h:h\}/);
  assert.match(script, /for target in [^\n]* \$CHECKOUT \$CHECKOUT\/\.env\.local; do/);
  // A file is read, not only listed.
  assert.match(script, /\[\[ -f \$target \]\] && reader=\(\/usr\/bin\/head -c 1\) \|\| reader=\(\/bin\/ls\)/);
  assert.match(script, /sudo -u \$AGENT \$reader \$target/);
});

test("the web server and the worker refuse a .env.local every account can read, and say how to fix it", () => {
  assert.equal(envFileProblem("/x/.env.local", undefined), null);
  assert.equal(envFileProblem("/x/.env.local", 0o100600), null);
  assert.equal(envFileProblem("/x/.env.local", 0o100640), null);
  assert.match(envFileProblem("/x/.env.local", 0o100644) ?? "", /every account on this Mac.*chmod 600 \/x\/\.env\.local$/);
  for (const entry of ["scripts/web.ts", "scripts/console-worker.ts"]) {
    const source = read(entry);
    assert.match(source, /envFileProblem\(/, entry);
    assert.match(source, /process\.exit\(1\)/, entry);
  }
  // The worker checks before it reads the .env files.
  const worker = read("scripts/console-worker.ts");
  assert.ok(worker.indexOf("envFileProblem(") < worker.indexOf("workerEnv(root)"));
});
