import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { buildProblem, nextArgs, serverExitCode, webMode, webPort } from "../src/lib/shared/web-server.ts";

test("npm run web serves the build; --dev runs the development server", () => {
  assert.deepEqual(webMode(["--port", "3011"]), { mode: "start", rest: ["--port", "3011"] });
  assert.deepEqual(webMode(["--dev", "--webpack", "--port", "3011"]), { mode: "dev", rest: ["--webpack", "--port", "3011"] });
  // The owner's usual `--webpack` keeps working: `next start` would refuse it.
  assert.deepEqual(nextArgs("start", ["--webpack", "--port", "3011"]), ["start", "--hostname", "127.0.0.1", "--port", "3011"]);
  assert.deepEqual(nextArgs("dev", ["--webpack", "--port", "3011"]), ["dev", "--hostname", "127.0.0.1", "--webpack", "--port", "3011"]);
  for (const [args, port] of [
    [["--port", "3011"], "3011"],
    [["--port=3012"], "3012"],
    [["-p", "3013"], "3013"],
    [[], "4000"],
  ] as const)
    assert.equal(webPort([...args], { PORT: "4000" }), port);
  assert.equal(webPort([], {}), "3000");
});

test("the built server refuses no build and a build of another commit; a copy outside Git checks the stamp only", () => {
  const head = "a".repeat(40);
  assert.match(buildProblem(null, head)!, /no build/);
  assert.match(buildProblem({ commit: head }, head)!, /no build/);
  assert.match(buildProblem({ commit: "b".repeat(40), builtAt: "2026-10-23T00:00:00Z" }, head)!, /bbbbbbbbbbbb.*aaaaaaaaaaaa.*npm run build/);
  assert.equal(buildProblem({ commit: head, builtAt: "2026-10-23T00:00:00Z" }, head), null);
  assert.equal(buildProblem({ commit: null, builtAt: "2026-10-23T00:00:00Z" }, null), null);
  assert.match(buildProblem({ commit: null, builtAt: "2026-10-23T00:00:00Z" }, head)!, /unknown commit/);
});

test("the server ending by itself never exits 0, so its LaunchAgent restarts it", () => {
  assert.equal(serverExitCode(0), 1);
  assert.equal(serverExitCode(null), 1);
  assert.equal(serverExitCode(3), 3);
});

test("the LaunchAgent, update, setup and launcher scripts parse (zsh -n)", { skip: !existsSync("/bin/zsh") }, () => {
  for (const script of [
    "scripts/install-web-launch-agent.sh",
    "scripts/update.sh",
    "scripts/console/install-launch-agent.sh",
    "scripts/console/setup-agent-user.sh",
    "scripts/console/console-agent",
  ])
    execFileSync("/bin/zsh", ["-n", script]);
});
