import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { ACP_CLIENTS, CLIENT_VERSIONS } from "../src/lib/console/clients.ts";

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
  assert.match(script, /restart_worker\(\) \{[^}]*launchctl bootstrap gui\/\$OWNER_UID \$WORKER_PLIST/);
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
