import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentModel } from "../src/lib/console/agents.ts";
import { apiKeyTurnUsage, apiKeyUsage, expectedKeySource, turnModelUsage } from "../src/lib/console/claude-session.ts";
import { codexServerArgs } from "../src/lib/console/codex.ts";
import { chargeTurn, NO_REQUESTS, readRunning, requestGauged, requestUsage } from "../src/lib/console/spend.ts";
import { runCommand } from "../src/lib/console/commands.ts";
import { GIT_TOKEN, harness, TOKEN } from "./helpers/console-harness.ts";

// Claude Code on an Anthropic API key and Codex on an OpenAI API key, as
// explicit model choices: each runs on its key and is charged from its
// reported usage; a subscription window still refuses API credentials, and an API-key window never runs on the subscription login.
// Against the fake clients: no sudo, no network, no model call.

const ANTHROPIC = "sk-ant-api03-FAKE-anthropic-key-0000000000WXYZ";
const OPENAI = "sk-proj-FAKE-openai-key-for-codex-000000000ABCD";
const CAP = { usd: 10, url: "https://example.test/limits", checkedAt: "2026-11-01" };
const SONNET_KEY = agentModel("claude-code", "claude-sonnet-5@api-key")!;
const SOL_KEY = agentModel("codex", "gpt-5.6-sol@api-key")!;

function keys(path: string, openai = OPENAI) {
  writeFileSync(
    path,
    JSON.stringify({
      keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN }, CONSOLE_GIT_TOKEN: { value: GIT_TOKEN }, ANTHROPIC_API_KEY: { value: ANTHROPIC, cap: CAP }, OPENAI_API_KEY: { value: openai, cap: CAP } },
      projects: {},
    }),
    { mode: 0o600 },
  );
}

test("the API-key models: twins of the subscription ones, on the existing key names, at catalog prices", () => {
  for (const [kind, credential] of [["claude-code", "ANTHROPIC_API_KEY"], ["codex", "OPENAI_API_KEY"]] as const)
    for (const id of ["claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-1", "haiku", "gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-luna"]) {
      const base = agentModel(kind, id);
      if (!base) continue;
      const twin = agentModel(kind, `${id}@api-key`)!;
      assert.equal(base.paid, undefined, id);
      assert.equal(twin.paid?.credential, credential, id);
      assert.equal(twin.model, base.model);
      assert.equal(twin.runs, base.runs);
      assert.match(twin.label, /\(API key\)$/);
    }
  // Claude's cache writes at the one-hour rate, the higher.
  assert.equal(SONNET_KEY.paid!.prices.cacheWritePerMtok, 4);
  assert.equal(expectedKeySource(SONNET_KEY), "ANTHROPIC_API_KEY");
  assert.equal(expectedKeySource(agentModel("claude-code", "claude-sonnet-5")!), "none");
  assert.deepEqual(codexServerArgs(false), ["app-server"]);
  assert.deepEqual(codexServerArgs(true), ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"']);
});

test("an API-key Claude turn is charged from every model's usage; a pricier or unknown model or a web search is not trusted", () => {
  const part = (model: string, input: number, output: number, webSearches = 0) => ({ model, usage: { inputTokens: input, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: output }, webSearches });
  // The window's model and a cheaper Haiku request are summed.
  assert.deepEqual(apiKeyUsage(SONNET_KEY, [part("claude-sonnet-5", 10, 5), part("claude-haiku-4-5-20251001", 20, 2)]), {
    inputTokens: 30,
    cacheReadTokens: 2,
    cacheWriteTokens: 0,
    outputTokens: 7,
  });
  assert.equal(apiKeyUsage(SONNET_KEY, [part("claude-sonnet-5", 10, 5), part("claude-opus-5-5", 1, 1)]), null);
  assert.equal(apiKeyUsage(SONNET_KEY, [part("claude-sonnet-5", 10, 5), part("claude-mystery-9", 1, 1)]), null);
  assert.equal(apiKeyUsage(SONNET_KEY, [part("claude-sonnet-5", 10, 5, 1)]), null);
  assert.equal(apiKeyUsage(SONNET_KEY, []), null);
  assert.equal(apiKeyUsage(SONNET_KEY, [{ model: "claude-sonnet-5", usage: { outputTokens: 5 }, webSearches: 0 }]), null);
});

test("Claude Code's modelUsage is a running total: a turn is charged the change since the last result", () => {
  const part = (model: string, input: number, output: number, webSearches = 0) => ({ model, usage: { inputTokens: input, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: output }, webSearches });
  const first = [part("claude-sonnet-5", 10, 5), part("claude-haiku-4-5-20251001", 20, 2)];
  // A new session: everything so far is this turn's.
  assert.deepEqual(apiKeyTurnUsage(SONNET_KEY, first, []), { inputTokens: 30, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 7 });
  // The next turn's totals carry the first turn too: only the change counts.
  const second = [part("claude-sonnet-5", 25, 9), part("claude-haiku-4-5-20251001", 20, 2)];
  assert.deepEqual(turnModelUsage(second, first), [{ model: "claude-sonnet-5", usage: { inputTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 4 }, webSearches: 0 }]);
  assert.deepEqual(apiKeyTurnUsage(SONNET_KEY, second, first), { inputTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 4 });
  // An earlier helper on a pricier model that did not move is not this turn's.
  const opus = [part("claude-sonnet-5", 10, 5), part("claude-opus-5-5", 1, 1)];
  assert.deepEqual(apiKeyTurnUsage(SONNET_KEY, [part("claude-sonnet-5", 12, 6), part("claude-opus-5-5", 1, 1)], opus), { inputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 });
  // Nothing moved: nothing used.
  assert.deepEqual(apiKeyTurnUsage(SONNET_KEY, first, first), { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  // Unreadable, so the full allowance: no known starting point (a session
  // resumed by a worker that never saw its totals), a total that went down,
  // a model that vanished, a new web search.
  assert.equal(apiKeyTurnUsage(SONNET_KEY, second, null), null);
  assert.equal(apiKeyTurnUsage(SONNET_KEY, [part("claude-sonnet-5", 9, 9), part("claude-haiku-4-5-20251001", 20, 2)], first), null);
  assert.equal(apiKeyTurnUsage(SONNET_KEY, [part("claude-sonnet-5", 25, 9)], first), null);
  assert.equal(apiKeyTurnUsage(SONNET_KEY, [part("claude-sonnet-5", 25, 9, 1), part("claude-haiku-4-5-20251001", 20, 2)], first), null);
});

test("Claude Code on an API key: each turn is charged once, across turns, a restart and a resume, never its history", async (t) => {
  const h = await harness(t, { tabSpendUsd: 1_000 });
  keys(h.keysFile);
  await h.worker.start();
  const paid = h.agent("Paid", "edit", "claude-sonnet-5@api-key");
  await h.ready(paid.id);
  const usage = { inputTokens: 31, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 7 };
  const once = chargeTurn(SONNET_KEY, usage)!.usd;
  // A turn charged its allowance pauses the tab; each is resumed here.
  const run = async (text: string) => {
    const turn = h.send(paid.id, text);
    await h.ended(turn);
    if (h.store.turn(turn)!.costBasis === "allowance") {
      await h.until(() => h.store.tab(h.tab.id)!.paused, "the tab waits");
      runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
    }
    return h.store.turn(turn)!;
  };
  // Two turns in one process: the second result's totals carry the first.
  for (const text of ["hello", "again"]) {
    const row = await run(text);
    assert.equal(row.costBasis, "reported", text);
    assert.equal(row.costUsd, once, text);
  }
  // The process ends; the next resumes the session, whose first result
  // already carries the earlier turns.
  assert.equal((await run("exit")).status, "failed");
  const resumed = await run("hello");
  assert.equal(resumed.costBasis, "reported");
  assert.equal(resumed.costUsd, once);
  // A zeroed report is a total that went down: the full allowance, and the
  // next turn is charged from the totals before it.
  assert.equal((await run("zeroed")).costBasis, "allowance");
  const after = await run("hello");
  assert.equal(after.costBasis, "reported");
  assert.equal(after.costUsd, chargeTurn(SONNET_KEY, { inputTokens: 62, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 14 })!.usd);

  // A new worker resuming the session knows none of its totals: its first
  // turn is charged the allowance, the next only its own usage.
  await h.worker.stop();
  const next = h.newWorker();
  await next.start();
  assert.equal((await run("hello")).costBasis, "allowance");
  const settled = await run("hello");
  assert.equal(settled.costBasis, "reported");
  assert.equal(settled.costUsd, once);
});

test("Claude Code on an API key: only its key crosses, it must report that key, web search is off, and the turn is charged", async (t) => {
  const h = await harness(t);
  keys(h.keysFile);
  await h.worker.start();
  const paid = h.agent("Paid", "edit", "claude-sonnet-5@api-key");
  const sub = h.agent("Sub");
  await h.ready(paid.id, sub.id);
  const turn = h.send(paid.id, "hello");
  await h.ended(turn);
  const row = h.store.turn(turn)!;
  assert.equal(row.status, "done", row.reason ?? "");
  const folder = h.store.agent(paid.id)!.folder;
  const env = JSON.parse(readFileSync(join(folder, "env.json"), "utf8")) as string[];
  assert.ok(env.includes("ANTHROPIC_API_KEY"));
  assert.ok(!env.includes("CLAUDE_CODE_OAUTH_TOKEN"), "the login token crossed to an API-key window");
  const args = JSON.parse(readFileSync(join(folder, "args.jsonl"), "utf8").trim().split("\n")[0]) as string[];
  assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-5");
  assert.ok((JSON.parse(args[args.indexOf("--settings") + 1]).permissions.deny as string[]).includes("WebSearch"));
  // Every model's usage (the window's and the client's own Haiku request).
  const usage = { inputTokens: 31, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 7 };
  assert.equal(row.costBasis, "reported");
  assert.equal(row.costUsd, chargeTurn(SONNET_KEY, usage)!.usd);
  assert.ok(row.costUsd! > 0);

  // A subscription window still gets only the login token and refuses API credentials.
  const free = h.send(sub.id, "hello");
  await h.ended(free);
  assert.equal(h.store.turn(free)!.costUsd, null);
  const subEnv = JSON.parse(readFileSync(join(h.store.agent(sub.id)!.folder, "env.json"), "utf8")) as string[];
  assert.ok(subEnv.includes("CLAUDE_CODE_OAUTH_TOKEN") && !subEnv.includes("ANTHROPIC_API_KEY"));
  const api = h.send(sub.id, "apikey");
  await h.ended(api);
  assert.match(h.store.turn(api)!.reason!, /API credentials/);

  // An API-key window whose client ran on the login is stopped. Its prompt
  // was already sent, so it is charged its full allowance and the tab waits.
  const login = h.send(paid.id, "nokey");
  await h.ended(login);
  assert.equal(h.store.turn(login)!.status, "failed");
  assert.match(h.store.turn(login)!.reason!, /did not run on ANTHROPIC_API_KEY/);
  assert.equal(h.store.turn(login)!.costBasis, "allowance");
});

test("Codex on an API key: its own App Server, signed in with the key over stdin and in memory only; the ChatGPT server never sees it", async (t) => {
  const h = await harness(t, {}, false, { codex: {} });
  keys(h.keysFile);
  await h.worker.start();
  const paid = h.agent("Paid", "edit", "gpt-5.6-sol@api-key", "codex");
  const sub = h.codexAgent("Sub");
  await h.ready(paid.id, sub.id);
  const turn = h.send(paid.id, "hello");
  await h.ended(turn);
  const row = h.store.turn(turn)!;
  assert.equal(row.status, "done", row.reason ?? "");
  // Two requests' usage, charged at the catalog's rates.
  assert.equal(row.costBasis, "reported");
  assert.equal(row.costUsd, chargeTurn(SOL_KEY, { inputTokens: 20, cacheReadTokens: 15, cacheWriteTokens: 2, outputTokens: 7 })!.usd);
  const free = h.send(sub.id, "hello");
  await h.ended(free);
  assert.equal(h.store.turn(free)!.status, "done", h.store.turn(free)!.reason ?? "");
  assert.equal(h.store.turn(free)!.costUsd, null);

  const starts = readFileSync(join(h.agentHome, "codex-starts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { pid: number; argv: string[]; keys: string[] });
  assert.equal(starts.length, 2);
  // No key in any server's environment or on its command line.
  for (const s of starts) {
    assert.deepEqual(s.keys, []);
    assert.ok(!s.argv.join(" ").includes(OPENAI));
  }
  const keyed = starts.find((s) => s.argv.includes('cli_auth_credentials_store="ephemeral"'))!;
  const chatgpt = starts.find((s) => s !== keyed)!;
  assert.deepEqual(chatgpt.argv, ["app-server"]);
  const calls = readFileSync(join(h.agentHome, "codex-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { pid: number; method: string; params: Record<string, unknown> });
  const of = (pid: number) => calls.filter((c) => c.pid === pid);
  assert.deepEqual(of(keyed.pid).map((c) => c.method).slice(0, 4), ["initialize", "initialized", "account/login/start", "account/read"]);
  assert.deepEqual(of(keyed.pid)[2].params, { type: "apiKey", apiKey: OPENAI });
  assert.ok(!of(chatgpt.pid).some((c) => c.method === "account/login/start"));
  // Each window's thread is on its own login's server; web search is off on the key.
  const thread = (pid: number) => of(pid).find((c) => c.method === "thread/start")!.params as { cwd: string; config: Record<string, unknown> };
  assert.equal(thread(keyed.pid).cwd, h.store.agent(paid.id)!.folder);
  assert.equal(thread(keyed.pid).config.web_search, "disabled");
  assert.equal(thread(chatgpt.pid).cwd, h.store.agent(sub.id)!.folder);
  assert.equal(thread(chatgpt.pid).config.web_search, undefined);
});

test("a replaced OpenAI key's Codex server is ended once no window is on it; one a window still uses keeps running", async (t) => {
  const h = await harness(t, {}, false, { codex: {} });
  keys(h.keysFile);
  await h.worker.start();
  const one = h.agent("One", "edit", "gpt-5.6-sol@api-key", "codex");
  const two = h.agent("Two", "edit", "gpt-5.6-sol@api-key", "codex");
  await h.ready(one.id, two.id);
  const run = async (id: string) => {
    const turn = h.send(id, "hello");
    await h.ended(turn);
    assert.equal(h.store.turn(turn)!.status, "done", h.store.turn(turn)!.reason ?? "");
  };
  // Each server's pid, by the key it signed in with.
  const logins = () =>
    readFileSync(join(h.agentHome, "codex-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { pid: number; method: string; params: Record<string, unknown> })
      .filter((c) => c.method === "account/login/start");
  const server = (key: string) => logins().find((c) => c.params.apiKey === key)!.pid;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  await run(one.id);
  await run(two.id);
  const keyB = OPENAI.replace("ABCD", "BBBB");
  const keyC = OPENAI.replace("ABCD", "CCCC");
  for (const [old, next] of [[OPENAI, keyB], [keyB, keyC]]) {
    const pid = server(old);
    keys(h.keysFile, next);
    // One moves to the new key; Two's window is still on the old one, so
    // its server keeps running.
    await run(one.id);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(alive(pid), "the old key's server, still in use, keeps running");
    await run(two.id);
    await h.until(() => !alive(pid), "the old key's server ends");
  }
  assert.ok(alive(server(keyC)));
  assert.equal(new Set(logins().map((c) => c.pid)).size, 3);
});

test("an API-key Codex server that does not report the API key runs no turn", async (t) => {
  const h = await harness(t, {}, false, { codex: { loginAs: "chatgpt" } });
  keys(h.keysFile);
  await h.worker.start();
  const paid = h.agent("Paid", "edit", "gpt-5.6-sol@api-key", "codex");
  await h.ready(paid.id);
  const turn = h.send(paid.id, "hello");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "failed");
  assert.match(h.store.turn(turn)!.reason!, /did not sign in with the OpenAI API key/);
  assert.ok(!h.codexCalls().some((c) => c.method === "thread/start"));
});

test("a stopped Codex API-key turn is charged its reported request plus one sized by its largest input, and its tab waits", async (t) => {
  const h = await harness(t, {}, false, { codex: {} });
  keys(h.keysFile);
  await h.worker.start();
  const paid = h.agent("Paid", "edit", "gpt-5.6-sol@api-key", "codex");
  await h.ready(paid.id);
  const turn = h.send(paid.id, "partial");
  // Its request's usage is kept with the turn while it runs.
  const kept = () => readRunning(JSON.parse(String(h.store.get("SELECT running FROM console_turns WHERE id = ?", turn)?.running ?? "null")));
  await h.until(() => kept().reported === 1, "usage kept");
  runCommand(h.store, { action: "stop", agentId: paid.id });
  await h.ended(turn);
  const row = h.store.turn(turn)!;
  assert.equal(row.status, "stopped", row.reason ?? "");
  const request = { inputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 0, outputTokens: 5 };
  const running = requestUsage(requestGauged(NO_REQUESTS, 40), request, SOL_KEY);
  const at = new Date(row.startedAt!);
  assert.equal(row.costBasis, "allowance");
  assert.equal(row.costUsd, chargeTurn(SOL_KEY, request, at, running, false, true)!.usd);
  assert.ok(row.costUsd! > chargeTurn(SOL_KEY, request, at, running)!.usd);
  assert.ok(row.costUsd! < chargeTurn(SOL_KEY, request, at, running, false)!.usd);
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Usage not reported: .*was stopped mid-request, so it was charged the usage it reported plus one more request of 40 input tokens/);
});

test("a stopped Claude Code API-key turn's unreported request is sized by its largest input, unless a helper ran", async (t) => {
  const h = await harness(t);
  keys(h.keysFile);
  await h.worker.start();
  const paid = h.agent("Paid", "edit", "claude-sonnet-5@api-key");
  await h.ready(paid.id);
  const stop = async (word: string) => {
    const turn = h.send(paid.id, word);
    await h.until(() => h.store.turn(turn)?.status === "running", "running");
    await new Promise((r) => setTimeout(r, 300));
    runCommand(h.store, { action: "stop", agentId: paid.id });
    await h.ended(turn);
    const row = h.store.turn(turn)!;
    assert.equal(row.status, "stopped", row.reason ?? "");
    assert.equal(row.costBasis, "allowance");
    const reason = h.store.tab(h.tab.id)!.pauseReason ?? "";
    runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
    return { usd: row.costUsd!, reason };
  };
  const sized = await stop("measuredhang");
  assert.match(sized.reason, /was stopped mid-request, so it was charged the usage it reported plus one more request of 1,000 input tokens/);
  const helped = await stop("measuredhelperhang");
  assert.match(helped.reason, /the full allowance for a request/);
  assert.ok(sized.usd < helped.usd);
});

test("a turn a dead worker left is charged from what its client had reported, at the prices it started with, even once its model has left the catalog", async (t) => {
  const h = await harness(t, {}, false, { codex: {} });
  keys(h.keysFile);
  const paid = h.agent("Paid", "edit", "gpt-5.6-sol@api-key", "codex");
  const turn = h.send(paid.id, "hello");
  const dead = h.store.takeLease("dead-worker", Date.now())!;
  const billed = { id: SOL_KEY.id, label: SOL_KEY.label, model: SOL_KEY.model, paid: SOL_KEY.paid };
  assert.ok(h.store.startTurn(dead, turn, { model: billed, key: { scope: "global", print: "abc" } }));
  h.store.markPrompted(dead, turn);
  // Two requests reported, a third begun (the gauge saw it), then the worker died.
  const request = { inputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 };
  let running = requestUsage(requestGauged(NO_REQUESTS, 1_000), request, SOL_KEY);
  running = requestGauged(requestUsage(requestGauged(running, 2_000), request, SOL_KEY), 3_000);
  h.store.setRunning(dead, turn, running);
  h.store.releaseLease(dead);
  // The model leaves the catalog before the next start.
  h.store.run("UPDATE console_agents SET model = 'gpt-retired@api-key' WHERE id = ?", paid.id);
  await h.worker.start();
  const row = h.store.turn(turn)!;
  assert.equal(row.status, "interrupted");
  assert.equal(row.costBasis, "allowance");
  const at = new Date(row.startedAt!);
  assert.equal(row.costUsd, chargeTurn(billed, null, at, running)!.usd);
  assert.equal(row.costUsd, chargeTurn(billed, running.usage, at, running)!.usd + chargeTurn(billed, null, at)!.usd);
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Usage not reported: /);
});
