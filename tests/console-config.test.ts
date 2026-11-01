import assert from "node:assert/strict";
import { test } from "node:test";
import type { Stats } from "node:fs";
import { agentHostProblems, consoleClientBinary, consoleLauncher, consolePaths } from "../src/lib/console/config.ts";

// Review: the agent host's paths behind the environment, and the
// startup check of the shared folder.

test("the agent host's paths have defaults and move with the environment", () => {
  assert.deepEqual(consolePaths({}), { agentHome: "/Users/agent", shared: "/opt/console-shared" });
  assert.deepEqual(consolePaths({ CONSOLE_AGENT_HOME: "/Users/bot", CONSOLE_SHARED: "/srv/shared" }), { agentHome: "/Users/bot", shared: "/srv/shared" });
  assert.deepEqual(consoleLauncher({}).command, ["/usr/bin/sudo", "-n", "-u", "agent", "/usr/local/libexec/console-agent"]);
  assert.equal(consoleLauncher({ CONSOLE_LAUNCHER: "/opt/bin/console-agent" }).command.at(-1), "/opt/bin/console-agent");
  assert.equal(consoleClientBinary("claude-code", {}), "/opt/console-clients/bin/claude");
  assert.equal(consoleClientBinary("codex", { CONSOLE_CLIENTS_DIR: "/srv/clients" }), "/srv/clients/bin/codex");
});

const node = (o: { dir?: boolean; link?: boolean; uid?: number; gid?: number; mode?: number }) =>
  ({
    isDirectory: () => o.dir ?? true,
    isSymbolicLink: () => o.link ?? false,
    uid: o.uid ?? 501,
    gid: o.gid ?? 600,
    mode: o.mode ?? 0o40750,
  }) as unknown as Stats;
const paths = { agentHome: "/Users/agent", shared: "/opt/console-shared" };
const statOf = (shared: Stats | null, home: Stats | null = node({ uid: 600 })) => (path: string) => {
  const found = path === paths.shared ? shared : home;
  if (!found) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  return found;
};

test("a shared folder as the setup script leaves it passes", () => {
  assert.deepEqual(agentHostProblems(paths, statOf(node({})), 501), []);
});

test("a wrong group, mode, owner or a missing folder is named with its fix", () => {
  const wrongGroup = agentHostProblems(paths, statOf(node({ gid: 20 })), 501);
  assert.match(wrongGroup[0], /not in the agent user's group/);
  assert.match(wrongGroup.at(-1)!, /setup-agent-user\.sh/);
  assert.match(agentHostProblems(paths, statOf(node({ mode: 0o40700 })), 501)[0], /group cannot read/);
  assert.match(agentHostProblems(paths, statOf(node({ mode: 0o40755 })), 501)[0], /open to every user/);
  assert.match(agentHostProblems(paths, statOf(node({ uid: 0 })), 501)[0], /not owned by you/);
  assert.match(agentHostProblems(paths, statOf(node({ dir: false })), 501)[0], /not a folder/);
  assert.match(agentHostProblems(paths, statOf(null), 501)[0], /shared folder .* is missing/);
  assert.match(agentHostProblems(paths, statOf(node({}), null), 501)[0], /home .* is missing/);
});
