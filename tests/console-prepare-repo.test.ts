import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/lib/console/commands.ts";
import { consoleBaseRuleset, prepareRepo } from "../src/lib/console/prepare-repo.ts";
import { ConsoleStore } from "../src/lib/console/store.ts";

// Preparing a new repository (`npm run console:prepare-repo`) and Check
// again on a GitHub project whose checks failed.

type Ruleset = ReturnType<typeof consoleBaseRuleset> & { id: number; current_user_can_bypass: string };

/** A fake GitHub API for one repository: branches by name, rulesets. */
function github(branches: Record<string, string>, rulesets: Ruleset[] = [], admin = true) {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetcher = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname.replace("/repos/owner/repo", "");
    const query = new URL(url).search;
    calls.push(`${method} ${path}${query}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method === "GET" && path === "") return json({ default_branch: "main", permissions: { admin } });
    if (method === "GET" && path === "/branches") return json(Object.keys(branches).map((name) => ({ name })));
    if (method === "GET" && path.startsWith("/branches/")) {
      const sha = branches[decodeURIComponent(path.slice(10))];
      return sha ? json({ commit: { sha } }) : json({ message: "Branch not found" }, 404);
    }
    if (method === "PUT" && path === "/contents/README.md") {
      branches.main = "first";
      return json({}, 201);
    }
    if (method === "POST" && path === "/git/refs") {
      branches[body.ref.replace("refs/heads/", "")] = body.sha;
      return json({}, 201);
    }
    if (method === "GET" && path === "/rulesets") return json(rulesets.map((r) => ({ id: r.id })));
    if (method === "GET" && path.startsWith("/rulesets/")) return json(rulesets.find((r) => r.id === Number(path.slice(10))));
    if (method === "POST" && path === "/rulesets") {
      rulesets.push({ ...body, id: rulesets.length + 1, current_user_can_bypass: "never" });
      return json({}, 201);
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return { fetcher, calls, branches, rulesets };
}

test("an empty repository gets a first commit, the base branch and the Squadroom base ruleset", async () => {
  const gh = github({});
  const done = await prepareRepo("owner/repo", "main", { token: "tok", fetch: gh.fetcher });
  assert.deepEqual(done, ["Added README.md, the repository's first commit, on main.", 'Added the "Squadroom base" ruleset on refs/heads/main.']);
  assert.deepEqual(gh.rulesets[0].conditions.ref_name.include, ["refs/heads/main"]);
  // Running it again changes nothing.
  assert.deepEqual(await prepareRepo("owner/repo", "main", { token: "tok", fetch: gh.fetcher }), []);
  assert.equal(gh.rulesets.length, 1);
});

test("a missing base branch is made from the default branch", async () => {
  const gh = github({ main: "abc" });
  const done = await prepareRepo("owner/repo", "develop", { token: "tok", fetch: gh.fetcher });
  assert.equal(gh.branches.develop, "abc");
  assert.equal(done[0], "Created the branch develop from main.");
  assert.ok(!gh.calls.includes("PUT /contents/README.md"));
});

test("a ruleset that names the branch but would fail the worker's check is reported, not doubled", async () => {
  const weak = { ...consoleBaseRuleset("main"), rules: [{ type: "deletion" }], id: 1, current_user_can_bypass: "never" } as Ruleset;
  const gh = github({ main: "abc" }, [weak]);
  await assert.rejects(prepareRepo("owner/repo", "main", { token: "tok", fetch: gh.fetcher }), /names it exactly/);
  assert.equal(gh.rulesets.length, 1);
  await assert.rejects(prepareRepo("owner/repo", "main", { token: "tok", fetch: github({ main: "abc" }, [], false).fetcher }), /not an admin/);
});

test("Check again sends a failed GitHub project back to the worker and retries agents that got no folder", () => {
  const store = new ConsoleStore(":memory:", () => 1_000);
  const p = store.createProject("Repo", "github", "owner/repo", "main");
  const tab = store.tabs(p.id)[0].id;
  const make = (name: string) => (runCommand(store, { action: "createAgent", tabId: tab, name, kind: "claude-code", model: "haiku", permission: "edit" }).agent as { id: string }).id;
  const waiting = make("Waiting");
  const setUp = make("Set up");
  // Not yet failed: nothing to check again.
  assert.throws(() => runCommand(store, { action: "recheckProject", id: p.id }), /checks failed/);
  const epoch = store.takeLease("w", 1_000)!;
  store.setAgentFolder(epoch, setUp, "/Users/agent/work/x");
  store.setProjectState(epoch, p.id, "error", "not protected");
  store.setAgentError(epoch, waiting, "The project is not ready: not protected");
  runCommand(store, { action: "recheckProject", id: p.id });
  assert.equal(store.project(p.id)!.state, "preparing");
  assert.equal(store.project(p.id)!.error, null);
  assert.equal(store.agent(waiting)!.state, "creating");
  assert.equal(store.agent(setUp)!.state, "ready");
  // Only GitHub projects that failed, and not while archived.
  const folder = store.createProject("Folder", "folder");
  assert.throws(() => runCommand(store, { action: "recheckProject", id: folder.id }), /checks failed/);
  store.setProjectState(epoch, p.id, "error", "again");
  store.archive("project", p.id);
  assert.throws(() => runCommand(store, { action: "recheckProject", id: p.id }), /archived/);
  store.close();
});
