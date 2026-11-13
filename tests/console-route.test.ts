import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { needsFreshCode, runCommand } from "../src/lib/console/commands.ts";
import { DOCUMENT_REVIEW_ID } from "../src/lib/console/templates.ts";
import { ownerHeaders, signInState, useSignedInEnv } from "./helpers/signed-in.ts";

// the Console's routes need the signed-in session; owner commands
// also need the public Origin and a same-origin fetch. A header-only request
// from the Mac itself (an agent's curl) is refused.

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier.startsWith("@/") ? new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href : specifier,
      context,
    );
  },
});
const route = await import("../src/app/api/console/route.ts");
const uploadRoute = await import("../src/app/api/console/upload/route.ts");
const live = await import("../src/app/api/console/events/route.ts");
hooks.deregister();

const state = globalThis as typeof globalThis & { consoleStore?: ConsoleStore };
const URL_BASE = "http://127.0.0.1:3011/api/console";

test("Console routes: sign-in on every request; commands need Origin; the live view streams after an id; uploads are staged", async (t) => {
  const restore = useSignedInEnv();
  state.consoleStore = new ConsoleStore(":memory:");
  t.after(() => {
    state.consoleStore?.close();
    delete state.consoleStore;
    restore();
  });
  const owner = await ownerHeaders();
  const body = JSON.stringify({ action: "createProject", name: "Demo", source: "none" });
  // An agent's curl on the Mac: no session, with or without the header.
  assert.equal((await route.GET(new Request(URL_BASE, { headers: { host: "127.0.0.1:3011" } }))).status, 404);
  assert.equal((await route.GET(new Request(URL_BASE, { headers: { host: "127.0.0.1:3011", "x-workspace-request": "1" } }))).status, 401);
  assert.equal(
    (await route.POST(new Request(URL_BASE, { method: "POST", headers: { "x-workspace-request": "1" }, body }))).status,
    404,
  );
  assert.equal(
    (await live.GET(new Request(`${URL_BASE}/events?project=p000000000000`, { headers: { "x-workspace-request": "1" } }))).status,
    401,
  );
  // A session without Origin (a stolen cookie replayed by a program).
  assert.equal((await route.POST(new Request(URL_BASE, { method: "POST", headers: owner.get, body }))).status, 404);
  // The owner's page.
  const created = await route.POST(new Request(URL_BASE, { method: "POST", headers: owner.post, body }));
  assert.equal(created.status, 200);
  const { project } = (await created.json()) as { project: { id: string } };
  const list = (await (await route.GET(new Request(URL_BASE, { headers: owner.get }))).json()) as {
    projects: { id: string }[];
    worker: { online: boolean };
  };
  assert.deepEqual(list.projects.map((p) => p.id), [project.id]);
  assert.equal(list.worker.online, false);
  const view = (await (await route.GET(new Request(`${URL_BASE}?project=${project.id}`, { headers: owner.get }))).json()) as {
    tabs: { id: string }[];
  };
  const agent = (await (
    await route.POST(
      new Request(URL_BASE, {
        method: "POST",
        headers: owner.post,
        body: JSON.stringify({ action: "createAgent", tabId: view.tabs[0].id, name: "Lead", kind: "claude-code", model: "haiku", permission: "look" }),
      }),
    )
  ).json()) as { agent: { id: string } };
  const bad = await route.POST(
    new Request(URL_BASE, { method: "POST", headers: owner.post, body: JSON.stringify({ action: "send", agentId: agent.agent.id, text: "" }) }),
  );
  assert.equal(bad.status, 409);
  for (const text of ["first", "second"])
    await route.POST(new Request(URL_BASE, { method: "POST", headers: owner.post, body: JSON.stringify({ action: "send", agentId: agent.agent.id, text }) }));
  // The live view: everything after the given id, as server-sent events.
  const first = state.consoleStore.events(project.id, 0)[0].id;
  const controller = new AbortController();
  const response = await live.GET(
    new Request(`${URL_BASE}/events?project=${project.id}&after=${first}`, { headers: owner.get, signal: controller.signal }),
  );
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = response.body!.getReader();
  let text = "";
  while (!text.includes("second")) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.deepEqual(ids, [first + 1]);
  assert.match(text, /"text":"second"/);
  assert.doesNotMatch(text, /"text":"first"/);

  // A fresh view gets each window's own latest events: a busy window never
  // pushes a quiet one's transcript out.
  const quiet = (await (
    await route.POST(
      new Request(URL_BASE, {
        method: "POST",
        headers: owner.post,
        body: JSON.stringify({ action: "createAgent", tabId: view.tabs[0].id, name: "Quiet", kind: "claude-code", model: "haiku", permission: "look" }),
      }),
    )
  ).json()) as { agent: { id: string } };
  state.consoleStore.queueTurn(quiet.agent.id, "quiet one");
  for (let i = 0; i < 1005; i++) state.consoleStore.queueTurn(agent.agent.id, `busy ${i}`);
  const fresh = new AbortController();
  const all = await live.GET(new Request(`${URL_BASE}/events?project=${project.id}`, { headers: owner.get, signal: fresh.signal }));
  const freshReader = all.body!.getReader();
  let streamed = "";
  while (!streamed.includes('"busy 1004"')) streamed += new TextDecoder().decode((await freshReader.read()).value);
  fresh.abort();
  assert.match(streamed, /"text":"quiet one"/);
  assert.equal([...streamed.matchAll(/"text":"busy \d+"/g)].length, 1000);
  assert.doesNotMatch(streamed, /"text":"busy 4"/);

  // The navigation tree streams too, and follows renames without a reload.
  const treeAbort = new AbortController();
  const treeResponse = await live.GET(new Request(`${URL_BASE}/events?tree=1`, { headers: owner.get, signal: treeAbort.signal }));
  const treeReader = treeResponse.body!.getReader();
  let treeText = "";
  while (!treeText.includes('"name":"Quiet"')) treeText += new TextDecoder().decode((await treeReader.read()).value);
  assert.match(treeText, /^event: tree$/m);
  await route.POST(
    new Request(URL_BASE, { method: "POST", headers: owner.post, body: JSON.stringify({ action: "rename", target: "agent", id: quiet.agent.id, name: "Calm" }) }),
  );
  while (!treeText.includes('"name":"Calm"')) treeText += new TextDecoder().decode((await treeReader.read()).value);
  treeAbort.abort();
  // Uploads: the same gate; a named, bounded file is staged for the worker.
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const staging = mkdtempSync(join(tmpdir(), "console-uploads-"));
  process.env.CONSOLE_UPLOADS = staging;
  t.after(() => {
    delete process.env.CONSOLE_UPLOADS;
    rmSync(staging, { recursive: true, force: true });
  });
  const lease = state.consoleStore.takeLease("w", Date.now())!;
  state.consoleStore.setAgentFolder(lease, agent.agent.id, "/Users/agent/work/x/y");
  const send = (headers: Record<string, string>, body: string | Uint8Array<ArrayBuffer>, query = "") =>
    uploadRoute.POST(new Request(`${URL_BASE}/upload?agentId=${agent.agent.id}${query}`, { method: "POST", headers, body }));
  assert.equal((await send({ "x-workspace-request": "1", "x-file-name": "a.md" }, "x")).status, 404);
  assert.equal((await send({ ...owner.get, "x-file-name": "a.md" }, "x")).status, 404);
  assert.equal((await send({ ...owner.post, "x-file-name": "run.exe" }, "x")).status, 400);
  assert.equal((await send({ ...owner.post, "x-file-name": "big.md" }, new Uint8Array(11 * 1024 * 1024))).status, 413);
  const ok = await send({ ...owner.post, "x-file-name": encodeURIComponent("My notes.md") }, "# hi");
  assert.equal(ok.status, 200);
  const { uploadId } = (await ok.json()) as { uploadId: number };
  const queued = state.consoleStore.upload(uploadId)!;
  assert.deepEqual([queued.name, queued.size, queued.state, queued.replace], ["My notes.md", 4, "queued", false]);
  assert.equal(readFileSync(queued.staged, "utf8"), "# hi");
  assert.equal(queued.staged.startsWith(staging), true);
  // Without a session, no tree.
  assert.equal((await live.GET(new Request(`${URL_BASE}/events?tree=1`, { headers: { "x-workspace-request": "1" } }))).status, 401);
});

test("commands with weight beyond the page need a code entered in the last 8 hours", async (t) => {
  const restore = useSignedInEnv({ mail: true });
  state.consoleStore = new ConsoleStore(":memory:");
  t.after(() => {
    state.consoleStore?.close();
    delete state.consoleStore;
    restore();
  });
  const cs = state.consoleStore;
  const fresh = await ownerHeaders();
  // The Console's window is 8 hours: a code from 9 hours ago is stale.
  const stale = await ownerHeaders({ staleCode: 9 * 60 * 60_000 });
  const recent = await ownerHeaders({ staleCode: true });
  const post = (headers: Record<string, string>, body: Record<string, unknown>) =>
    route.POST(new Request(URL_BASE, { method: "POST", headers, body: JSON.stringify(body) }));
  const gated: Record<string, unknown>[] = [
    { action: "decide", requestId: 1, decision: "always" },
    { action: "decide", requestId: 1, decision: "project" },
    { action: "cleanupDelete", keys: ["work/p/a"] },
    { action: "setAskFirst", agentId: "a000000000000", on: false },
    // An agent's Network to Auto; a tab's agents, or with a
    // network request's answer.
    { action: "setNetwork", agentId: "a000000000000", auto: true },
    { action: "setNetwork", tabId: "t000000000000", auto: true },
    { action: "decide", requestId: 1, decision: "auto" },
  ];
  const open: Record<string, unknown>[] = [
    { action: "createProject", name: "Demo", source: "none" },
    { action: "decide", requestId: 1, decision: "allow" },
    { action: "decide", requestId: 1, decision: "deny" },
    { action: "setAskFirst", agentId: "a000000000000", on: true },
    { action: "setNetwork", agentId: "a000000000000", auto: false },
    { action: "setNetwork", tabId: "t000000000000", auto: false },
    { action: "decide", requestId: 1, decision: "again" },
    { action: "decide", requestId: 1, decision: "dismiss" },
    { action: "rename", target: "project", id: "p000000000000", name: "Renamed" },
    { action: "restore", scope: "project", id: "p000000000000" },
    // No longer gated.
    { action: "push", agentId: "a000000000000" },
    { action: "openPullRequest", agentId: "a000000000000" },
    { action: "saveRole", role: { id: "x", name: "X" } },
    { action: "deleteRole", id: "x" },
    { action: "resetRole", id: "x" },
    { action: "archive", scope: "project", id: "p000000000000" },
  ];
  for (const body of gated) {
    assert.equal(needsFreshCode(body), true, String(body.action));
    const refused = await post(stale.post, body);
    assert.equal(refused.status, 403, String(body.action));
    assert.deepEqual(await refused.json(), { error: "This action needs the code we e-mail you, entered in the last 8 hours.", freshCode: true });
    // With a fresh code, or one an hour old, the command runs (and may fail
    // on its own terms, never for the code).
    for (const headers of [fresh, recent]) {
      const ran = await post(headers.post, body);
      assert.notEqual(ran.status, 403, String(body.action));
      assert.equal(((await ran.json()) as { freshCode?: string }).freshCode, undefined);
    }
  }
  for (const body of open) {
    assert.equal(needsFreshCode(body), false, String(body.action));
    const ran = await post(stale.post, body);
    assert.notEqual(ran.status, 403, String(body.action));
  }
  // Approving an agent's team_push or team_pr_reply needs no code since,
  // like Push branch; an "Always" rule for it still does.
  const project = (await (await post(fresh.post, { action: "createProject", name: "Gated", source: "folder" })).json()) as { project: { id: string } };
  const agent = (await (
    await post(fresh.post, { action: "createAgent", tabId: cs.tabs(project.project.id)[0].id, name: "Lead", kind: "claude-code", model: "haiku", permission: "edit" })
  ).json()) as { agent: { id: string } };
  const epoch = cs.takeLease("w", Date.now())!;
  const turn = cs.queueTurn(agent.agent.id, "team_push");
  const request = (tool: string, ruleKey: string | null = null) =>
    cs.recordRequest(epoch, { turnId: turn.id, agentId: agent.agent.id, tool, input: "{}", ruleKey, state: "open", reason: "asked" });
  const pushRequest = request("team_push", "tool:team_push");
  const replyRequest = request("team_pr_reply");
  const readRequest = request("WebSearch", "tool:WebSearch");
  assert.equal((await post(stale.post, { action: "decide", requestId: pushRequest, decision: "always" })).status, 403);
  assert.equal(cs.request(pushRequest)!.state, "open");
  assert.equal(needsFreshCode({ action: "decide", requestId: pushRequest, decision: "allow" }), false);
  assert.equal((await post(stale.post, { action: "decide", requestId: readRequest, decision: "allow" })).status, 200);
  assert.equal((await post(stale.post, { action: "decide", requestId: replyRequest, decision: "deny" })).status, 200);
  assert.equal((await post(stale.post, { action: "decide", requestId: pushRequest, decision: "allow" })).status, 200);
  assert.equal(cs.request(pushRequest)!.state, "allowed");
  // A tab's spend limit: none until set; a stale session may set or lower
  // it, never raise or remove it; with a fresh code the raise lands.
  const tabId = cs.tabs(project.project.id)[0].id;
  const limit = async (headers: Record<string, string>, limitUsd: number | null) => post(headers, { action: "setSpendLimit", tabId, limitUsd });
  assert.equal((await limit(stale.post, 1)).status, 200);
  assert.equal(cs.tab(tabId)!.spendLimitUsd, 1);
  assert.equal((await limit(stale.post, 2)).status, 403);
  assert.equal((await limit(stale.post, null)).status, 403);
  assert.equal(cs.tab(tabId)!.spendLimitUsd, 1);
  assert.equal((await limit(stale.post, 0.5)).status, 200);
  assert.equal((await limit(fresh.post, null)).status, 200);
  assert.equal(cs.tab(tabId)!.spendLimitUsd, null);
  assert.equal((await post(stale.post, { action: "setSpendLimit", tabId: "t000000000000", limitUsd: 1 })).status, 403);
  // A tab's turn limits, the same way.
  const turns = async (headers: Record<string, string>, n: number | null) => post(headers, { action: "setTurnLimits", tabId, turns: n, minutes: null });
  assert.equal((await turns(stale.post, 10)).status, 200);
  assert.equal((await turns(stale.post, 11)).status, 403);
  assert.equal((await turns(stale.post, null)).status, 403);
  assert.equal(cs.tab(tabId)!.turnLimit, 10);
  assert.equal((await turns(fresh.post, 80)).status, 200);
  assert.equal(cs.tab(tabId)!.turnLimit, 80);
  // The Console-wide limit: none until set; a stale session may set or
  // lower it, never raise, remove or reset it.
  const consoleLimit = (headers: Record<string, string>, limitUsd: number | null) => post(headers, { action: "setConsoleSpendLimit", limitUsd });
  assert.equal(cs.consoleSpend().limitUsd, null);
  assert.equal((await consoleLimit(stale.post, 10)).status, 200);
  assert.equal(cs.consoleSpend().limitUsd, 10);
  assert.equal((await consoleLimit(stale.post, 11)).status, 403);
  assert.equal((await consoleLimit(stale.post, null)).status, 403);
  assert.equal((await post(stale.post, { action: "resetConsoleSpend" })).status, 403);
  assert.equal(cs.consoleSpend().limitUsd, 10);
  assert.equal((await consoleLimit(fresh.post, null)).status, 200);
  assert.equal((await post(fresh.post, { action: "resetConsoleSpend" })).status, 200);
  assert.equal(cs.consoleSpend().limitUsd, null);
  // The gate comes after sign-in: no session, no 403 either.
  const anonymous = await post({ "x-workspace-request": "1", origin: "https://squadroom.example", "sec-fetch-site": "same-origin" }, gated[0]);
  assert.equal(anonymous.status, 401);
});

test("an action that is not a string is unknown, so no check can be bypassed by wrapping a name", () => {
  for (const action of [["setAcpNetwork"], ["resetSpend"], { toString: () => "rename" }, 1, null]) {
    assert.equal(needsFreshCode({ action }), false);
    assert.throws(() => runCommand({} as ConsoleStore, { action }), /Unknown action\./);
  }
});

test("Ask me first: in a project that uses it, a stale session cannot make agents, teams or template tabs without it", async (t) => {
  const restore = useSignedInEnv({ mail: true });
  state.consoleStore = new ConsoleStore(":memory:");
  t.after(() => {
    state.consoleStore?.close();
    delete state.consoleStore;
    restore();
  });
  const cs = state.consoleStore;
  const fresh = await ownerHeaders();
  const stale = await ownerHeaders({ staleCode: 9 * 60 * 60_000 });
  const post = (headers: Record<string, string>, body: Record<string, unknown>) =>
    route.POST(new Request(URL_BASE, { method: "POST", headers, body: JSON.stringify(body) }));
  const projectId = ((await (await post(stale.post, { action: "createProject", name: "Guarded", source: "folder" })).json()) as { project: { id: string } }).project.id;
  const tabId = cs.tabs(projectId)[0].id;
  const agent = (headers: Record<string, string>, name: string, extra: Record<string, unknown> = {}) =>
    post(headers, { action: "createAgent", tabId, name, kind: "claude-code", model: "haiku", permission: "edit", ...extra });
  // No agent asks first yet: no code needed.
  assert.equal((await agent(stale.post, "Plain")).status, 200);
  // One that asks first needs none either; from then on the project uses it.
  const guarded = ((await (await agent(stale.post, "Guard", { askFirst: true })).json()) as { agent: { id: string } }).agent.id;
  assert.equal(cs.askFirstInUse(projectId), true);
  const refused = await agent(stale.post, "Loose");
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { freshCode?: boolean }).freshCode, true);
  assert.equal((await agent(stale.post, "Loose", { kind: "codex", model: "gpt-5.6-sol" })).status, 403);
  assert.equal((await agent(stale.post, "Careful", { askFirst: true })).status, 200);
  assert.equal((await post(stale.post, { action: "createTeam", tabId })).status, 403);
  assert.equal((await post(stale.post, { action: "createTab", projectId, name: "Review", templateId: DOCUMENT_REVIEW_ID })).status, 403);
  // An empty tab is fine; its agents are gated the same way.
  assert.equal((await post(stale.post, { action: "createTab", projectId, name: "Empty" })).status, 200);
  // Closing the guarded agent and making it again does not drop Ask me first.
  assert.equal((await post(stale.post, { action: "close", agentId: guarded })).status, 200);
  assert.equal((await agent(stale.post, "Guard")).status, 403);
  // With a fresh code each lands.
  assert.equal((await agent(fresh.post, "Guard")).status, 200);
  assert.notEqual((await post(fresh.post, { action: "createTab", projectId, name: "Review", templateId: DOCUMENT_REVIEW_ID })).status, 403);
  // Another project is not affected.
  const other = ((await (await post(stale.post, { action: "createProject", name: "Other", source: "folder" })).json()) as { project: { id: string } }).project.id;
  assert.equal((await post(stale.post, { action: "createAgent", tabId: cs.tabs(other)[0].id, name: "Plain", kind: "claude-code", model: "haiku", permission: "edit" })).status, 200);
});

test("without mail, commands with weight beyond the page are refused with how to enable them", async (t) => {
  const restore = useSignedInEnv();
  state.consoleStore = new ConsoleStore(":memory:");
  t.after(() => {
    state.consoleStore?.close();
    delete state.consoleStore;
    restore();
  });
  // Even a session marked as freshly confirmed: there is no second factor.
  const owner = await ownerHeaders();
  const post = (body: Record<string, unknown>) => route.POST(new Request(URL_BASE, { method: "POST", headers: owner.post, body: JSON.stringify(body) }));
  for (const body of [
    { action: "decide", requestId: 1, decision: "always" },
    { action: "cleanupDelete", keys: ["work/p/a"] },
  ]) {
    const refused = await post(body);
    assert.equal(refused.status, 403);
    const answer = (await refused.json()) as { error: string; freshCode?: unknown };
    assert.equal(answer.freshCode, undefined);
    assert.match(answer.error, /e-mail is not configured/);
    assert.match(answer.error, /CONSOLE_RESEND_API_KEY, CONSOLE_MAIL_FROM and CONSOLE_NOTIFY_EMAIL/);
  }
  // Ordinary commands still run.
  assert.equal((await post({ action: "createProject", name: "Demo", source: "none" })).status, 200);
});

test("an open stream ends when the session does; a fresh view's history is bounded by bytes per window", async (t) => {
  const restore = useSignedInEnv();
  state.consoleStore = new ConsoleStore(":memory:");
  t.after(() => {
    state.consoleStore?.close();
    delete state.consoleStore;
    restore();
  });
  const owner = await ownerHeaders();
  const cs = state.consoleStore;
  const project = cs.createProject("P", "none", null, "main");
  const tab = cs.tabs(project.id)[0];
  const agent = cs.createAgent({ tabId: tab.id, name: "Big", role: "", kind: "claude-code", model: "haiku", effort: null, permission: "look" });
  const epoch = cs.takeLease("w", Date.now())!;
  const turn = cs.queueTurn(agent.id, "go");
  cs.startTurn(epoch, turn.id);
  for (let i = 0; i < 40; i++) cs.addEvent(epoch, turn.id, "tool_result", { id: `t${i}`, text: `${i}:${"x".repeat(60_000)}`, error: false });
  const fresh = new AbortController();
  const response = await live.GET(new Request(`${URL_BASE}/events?project=${project.id}`, { headers: owner.get, signal: fresh.signal }));
  const reader = response.body!.getReader();
  let text = "";
  while (!text.includes('"39:')) text += new TextDecoder().decode((await reader.read()).value);
  // About a megabyte of the newest, not all 2.4 MB.
  const shown = [...text.matchAll(/"text":"(\d+):/g)].map((m) => Number(m[1]));
  assert.ok(shown.length < 20 && shown.length > 10, String(shown.length));
  assert.equal(shown.at(-1), 39);
  // Polling a view the page has: only its version comes back.
  const first = (await (await route.GET(new Request(`${URL_BASE}?project=${project.id}`, { headers: owner.get }))).json()) as { version: string; tabs: unknown[] };
  assert.ok(first.version && first.tabs.length);
  const again = (await (await route.GET(new Request(`${URL_BASE}?project=${project.id}&version=${first.version}`, { headers: owner.get }))).json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(again).sort(), ["unchanged", "version", "worker"]);
  const list = (await (await route.GET(new Request(URL_BASE, { headers: owner.get }))).json()) as { version: string };
  assert.equal(((await (await route.GET(new Request(`${URL_BASE}?version=${list.version}`, { headers: owner.get }))).json()) as { unchanged?: boolean }).unchanged, true);
  // Signing out ends the open stream on its next poll.
  signInState.signInStore!.deleteAllSessions();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
  fresh.abort();
});
