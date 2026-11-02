// A scripted stand-in for `codex app-server` 0.155.1 (-3 tests). It
// runs in the agent home (the launcher's cwd), records every call in
// codex-calls.jsonl there, reads its setup from fake-codex.json there
// ({ account, profile }), and acts on each turn's first word:
//   hello      streams text, runs a command (its output carries a token)
//   write P    proposes a file change to P, writes it if accepted
//   net        asks to run a command with network access
//   ask        asks the owner a question (request_user_input)
//   elicit     asks to call a tool on the console server and on another one
//   hang       waits; an interrupt ends the turn
//   partial    reports one request's usage, then waits; an interrupt ends it
//   deaf       waits and ignores interrupts
//   lateack    accepts the turn but never answers turn/start: after a
//              moment it reports usage, streams, asks to write a file
//              (its argument) and waits; an interrupt ends it
//   silent     accepts the turn, never answers turn/start, never says
//              anything (only ending the server ends it)
//   earlyack   sends turn/started at once, never answers turn/start, then
//              waits; an interrupt ends it
//   laterefuse answers turn/start with an error, late (after 400 ms)
//   reroute    reports a model reroute, then waits
//   plan       reports its plan twice (the second replaces the first), and
//              one malformed update
//   team_ask NAME TEXT, team_send NAME TEXT  calls a team tool (after the
//              elicitation Codex sends for every MCP tool call)
// A team prompt is answered by echoing it.
import fs from "node:fs";
import readline from "node:readline";

const setup = fs.existsSync("fake-codex.json") ? JSON.parse(fs.readFileSync("fake-codex.json", "utf8")) : {};
const send = (x) => process.stdout.write(JSON.stringify(x) + "\n");
const log = (x) => fs.appendFileSync("codex-calls.jsonl", JSON.stringify({ pid: process.pid, ...x }) + "\n");
// Setup `ignoreTerm`: the server survives TERM (only KILL ends it).
if (setup.ignoreTerm) process.on("SIGTERM", () => {});
// A server keeping its login in memory only (an API-key server) starts with
// none; it records how it was started, and which keys its environment has.
const ephemeral = process.argv.includes('cli_auth_credentials_store="ephemeral"');
let account = ephemeral ? null : (setup.account ?? "chatgpt");
fs.appendFileSync("codex-starts.jsonl", JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), keys: Object.keys(process.env).filter((k) => k.endsWith("_API_KEY")) }) + "\n");
const threads = new Map(); // id -> { cwd, model, config }
/** The prompt without the Console's notes before it (as fake-claude). */
const body = (text) => text.replace(/^Step \d+ of \d+: [\s\S]*?\n\n/, "").replace(/^Your folder now has your teammates' [\s\S]*?\n\n/, "").replace(/^These teammates' commits could not be checked out[\s\S]*?\n\n/, "");
const turns = new Map(); // threadId -> { id, hang }
const pending = new Map(); // server request id -> resolve
let nextRequest = 1000;
let nextThread = 1;
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextRequest++;
    pending.set(id, resolve);
    send({ id, method, params });
  });

function threadResult(id, params) {
  const config = params.config ?? {};
  return {
    thread: { id, cwd: params.cwd, status: { type: "idle" } },
    model: params.model,
    cwd: params.cwd,
    approvalPolicy: params.approvalPolicy,
    activePermissionProfile:
      setup.profile === false
        ? null
        : { id: config.default_permissions, extends: setup.extendsAs ?? config.permissions?.[config.default_permissions]?.extends },
  };
}

// Each thread's cumulative usage, and its latest request's (`last`).
const usages = new Map(); // threadId -> { total, last }
function usage(threadId, note, last) {
  const u = usages.get(threadId) ?? { total: 0, last: null };
  u.total += last.inputTokens + last.outputTokens;
  u.last = last;
  usages.set(threadId, u);
  note("thread/tokenUsage/updated", { tokenUsage: { last, total: { totalTokens: u.total }, modelContextWindow: 400000 } });
}
/** A rate-limit update: the latest request's usage again, the total unchanged. */
function repeatUsage(threadId, note) {
  const u = usages.get(threadId);
  if (u?.last) note("thread/tokenUsage/updated", { tokenUsage: { last: u.last, total: { totalTokens: u.total } } });
}

async function runTurn(threadId, turnId, text) {
  const thread = threads.get(threadId);
  const note = (method, params) => send({ method, params: { threadId, turnId, ...params } });
  const say = (t) => {
    note("item/agentMessage/delta", { itemId: "m1", delta: t });
    note("item/completed", { item: { type: "agentMessage", id: "m1", text: t } });
  };
  const done = (status = "completed") => {
    turns.delete(threadId);
    note("turn/completed", { turn: { id: turnId, status } });
  };
  if (text.startsWith("Messages from your team")) {
    say(`echo: ${text}`);
    return done();
  }
  const [word, ...rest] = text.split(" ");
  const arg = rest.join(" ");
  if (word === "team_ask" || word === "team_send") {
    const accepted = await request("mcpServer/elicitation/request", { threadId, turnId, serverName: "console" });
    if (accepted.action !== "accept") {
      say("declined");
      return done();
    }
    const server = thread.config.mcp_servers.console;
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: server.http_headers.Authorization },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: word, arguments: { to: rest[0], message: rest.slice(1).join(" ") } } }),
    });
    const r = (await response.json()).result;
    say(`${word}: ${r.content[0].text}`);
    return done();
  }
  if (word === "hello") {
    // A later turn may open with a rate-limit update, attributed to it.
    repeatUsage(threadId, note);
    note("item/reasoning/textDelta", { itemId: "r1", delta: "Thinking it over." });
    say("Hi from Codex.");
    note("item/started", { item: { type: "commandExecution", id: "c1", command: "env" } });
    note("item/completed", {
      item: { type: "commandExecution", id: "c1", command: "env", aggregatedOutput: `MCP=${thread.config.mcp_servers.console.http_headers.Authorization}`, exitCode: 0, status: "completed" },
    });
    // Two model requests in this turn; the thread total also counts earlier
    // turns. A rate-limit update repeats the last request's usage.
    usage(threadId, note, { inputTokens: 12, cachedInputTokens: 9, cacheWriteInputTokens: 2, outputTokens: 4 });
    usage(threadId, note, { inputTokens: 8, cachedInputTokens: 6, outputTokens: 3 });
    repeatUsage(threadId, note);
    return done();
  }
  if (word === "write") {
    note("item/started", { item: { type: "fileChange", id: "f1", changes: [{ path: arg }], status: "inProgress" } });
    const answer = await request("item/fileChange/requestApproval", { threadId, turnId, itemId: "f1", startedAtMs: Date.now() });
    if (answer.decision === "accept") fs.writeFileSync(arg, "written by codex\n");
    note("item/completed", { item: { type: "fileChange", id: "f1", changes: [{ path: arg }], status: answer.decision === "accept" ? "completed" : "declined" } });
    say(`file: ${answer.decision}`);
    return done();
  }
  if (word === "plan") {
    note("turn/plan/updated", { explanation: null, plan: [{ step: "Look", status: "completed" }, { step: "Change", status: "pending" }] });
    note("turn/plan/updated", { explanation: "x", plan: [{ step: "Look", status: "completed" }, { step: "Change", status: "inProgress" }, { step: "Test", status: "pending" }] });
    note("turn/plan/updated", { plan: [{ step: "Bad", status: "unknown" }] });
    say("planned");
    return done();
  }
  if (word === "net") {
    const answer = await request("item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId: "n1",
      startedAtMs: Date.now(),
      command: "npm install",
      networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" },
    });
    say(`net: ${answer.decision}`);
    return done();
  }
  if (word === "escalate") {
    const answer = await request("item/commandExecution/requestApproval", { threadId, turnId, itemId: "e1", startedAtMs: Date.now(), command: "rm -r /Users/agent/work/x" });
    say(`escalate: ${answer.decision}`);
    return done();
  }
  if (word === "ask") {
    const answer = await request("item/tool/requestUserInput", {
      threadId,
      turnId,
      itemId: "q1",
      isBlocking: true,
      questions: [
        { id: "q", header: "Choice", question: "Which colour?", options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] },
        { id: "n", header: "Name", question: "Which name?" },
      ],
    });
    say(`answer: ${answer.answers?.q?.answers?.[0] ?? "(none)"} / ${answer.answers?.n?.answers?.[0] ?? "(none)"}`);
    return done();
  }
  if (word === "elicit") {
    const ours = await request("mcpServer/elicitation/request", { threadId, turnId, serverName: "console" });
    const theirs = await request("mcpServer/elicitation/request", { threadId, turnId, serverName: "other" });
    say(`elicit: ${ours.action} ${theirs.action}`);
    return done();
  }
  if (word === "reroute") {
    send({ method: "model/rerouted", params: { threadId, turnId, toModel: "gpt-5.6-luna" } });
    return; // waits for the interrupt
  }
  if (word === "lateack") {
    // The acknowledgement never came, but the turn runs: usage first (it
    // belongs to this turn), then a late write attempt, then a wait.
    await new Promise((r) => setTimeout(r, 400));
    usage(threadId, note, { inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 });
    note("item/agentMessage/delta", { itemId: "m1", delta: "Late but running." });
    note("item/started", { item: { type: "fileChange", id: "f1", changes: [{ path: arg }], status: "inProgress" } });
    const answer = await request("item/fileChange/requestApproval", { threadId, turnId, itemId: "f1", startedAtMs: Date.now() });
    if (answer.decision === "accept") fs.writeFileSync(arg, "written late by codex\n");
    note("item/completed", { item: { type: "fileChange", id: "f1", changes: [{ path: arg }], status: answer.decision === "accept" ? "completed" : "declined" } });
    return; // waits for the interrupt
  }
  if (word === "partial") {
    usage(threadId, note, { inputTokens: 40, cachedInputTokens: 10, outputTokens: 5 });
    return; // waits for the interrupt
  }
  if (word === "deaf") turns.get(threadId).deaf = true;
  // hang, deaf, silent and anything else: wait (deaf ignores interrupts).
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const q = JSON.parse(line);
  if (q.id !== undefined && q.method === undefined) {
    pending.get(q.id)?.(q.result ?? {});
    pending.delete(q.id);
    return;
  }
  log({ method: q.method, params: q.params });
  const reply = (result) => send({ id: q.id, result });
  switch (q.method) {
    case "initialize":
      return reply({ userAgent: "fake" });
    case "initialized":
      return;
    case "account/read":
      return reply({ account: account ? { type: account } : null });
    case "account/login/start":
      // Setup `loginAs`: what the login turns out to be.
      account = setup.loginAs ?? q.params.type;
      return reply({ type: q.params.type });
    case "thread/start": {
      const id = `thread-${process.pid}-${nextThread++}`;
      threads.set(id, q.params);
      return reply(threadResult(id, q.params));
    }
    case "thread/resume": {
      if (!q.params.threadId.startsWith(`thread-${process.pid}-`) && !setup.resumeAny)
        return send({ id: q.id, error: { code: -32600, message: "no rollout found" } });
      threads.set(q.params.threadId, q.params);
      reply(threadResult(q.params.threadId, q.params));
      // A resumed thread replays an earlier turn's usage, here with requests
      // this worker never saw (as after a worker restart), so its total moved.
      const u = usages.get(q.params.threadId);
      if (u?.last) u.total += 1000;
      if (u?.last)
        send({ method: "thread/tokenUsage/updated", params: { threadId: q.params.threadId, turnId: "turn-earlier", tokenUsage: { last: u.last, total: { totalTokens: u.total } } } });
      return;
    }
    case "turn/start": {
      const turnId = `turn-${Date.now()}`;
      const threadId = q.params.threadId;
      if (q.params.input[0].text === "quick") {
        // The reply, the usage and the end in one write, so they arrive together.
        const lines = [JSON.stringify({ id: q.id, result: { turn: { id: turnId, status: "inProgress" } } })];
        const note = (method, params) => lines.push(JSON.stringify({ method, params: { threadId, turnId, ...params } }));
        usage(threadId, note, { inputTokens: 3, cachedInputTokens: 1, outputTokens: 1 });
        note("item/completed", { item: { type: "agentMessage", id: "m1", text: "Quick." } });
        note("turn/completed", { turn: { id: turnId, status: "completed" } });
        process.stdout.write(lines.join("\n") + "\n");
        return;
      }
      turns.set(q.params.threadId, { id: turnId });
      const text = body(q.params.input[0].text);
      const word = text.split(" ")[0];
      // lateack and silent: accepted, but the reply is never written.
      if (word === "laterefuse") {
        turns.delete(threadId);
        setTimeout(() => send({ id: q.id, error: { code: -32000, message: "late refusal" } }), 400);
        return;
      }
      if (word !== "lateack" && word !== "silent" && word !== "earlyack") reply({ turn: { id: turnId, status: "inProgress" } });
      if (word === "earlyack") send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
      void runTurn(q.params.threadId, turnId, text);
      return;
    }
    case "turn/interrupt": {
      reply({});
      const turn = turns.get(q.params.threadId);
      if (turn && !turn.deaf) {
        turns.delete(q.params.threadId);
        send({ method: "turn/completed", params: { threadId: q.params.threadId, turn: { id: turn.id, status: "interrupted" } } });
      }
      return;
    }
    default:
      return send({ id: q.id, error: { code: -32601, message: "not found" } });
  }
});
