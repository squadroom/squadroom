// A scripted stand-in for an ACP agent program (`opencode acp`) for
// the conformance matrix (tests/console-acp.test.ts). It runs in its agent's
// folder (the launcher's cwd), records every message it gets in
// acp-calls.jsonl in the agent home ($HOME), reads its setup from
// fake-acp.json there, and acts on each prompt's first word:
//   hello      streams text, reads a file (a tool call), reports usage
//   env        says which credential names reached it
//   tools      lists the Console's team tools it was offered
//   team_send NAME TEXT   calls a team tool
//   nousage    ends without usage
//   slownousage  ends without usage after half a second
//   badusage   ends with a total smaller than its parts
//   repeat     reports its context twice, then usage once
//   late       ends, then sends more updates (text, context) afterwards
//   hang       waits; a cancel ends it (stopReason cancelled)
//   deaf       waits and ignores cancel
//   ask        asks to run a command, says the answer
//   ask2       asks two things at once, says both answers
//   askhang    asks, then waits; a cancel must answer the ask "cancelled"
//   edit P     asks to edit P, says the answer
//   refuse     answers the prompt with an error, having said nothing
//   error      says something, then answers with an error
// Setup: { models: null | {current, available}, setModelFails, loadSession,
// http, protocolVersion, authRequired, ignoreTerm, keyAuth }. `keyAuth`
// (Grok Build): the method advertised for the key in the environment, and
// no session opens until it is selected with authenticate.
import fs from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

// Check connection runs `--version` only: answer and exit.
if (process.argv[2] === "--version") {
  process.stdout.write("fake-acp 1.2.3\n");
  process.exit(0);
}
const home = process.env.HOME;
const setupPath = join(home, "fake-acp.json");
const setup = fs.existsSync(setupPath) ? JSON.parse(fs.readFileSync(setupPath, "utf8")) : {};
const send = (x) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...x }) + "\n");
const log = (x) => fs.appendFileSync(join(home, "acp-calls.jsonl"), JSON.stringify({ pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2), ...x }) + "\n");
// `crash`: print it on stderr and exit 1 at once (OpenCode's start failing
// in the sandbox, live check 2026-11-01).
if (setup.crash) {
  process.stderr.write(setup.crash);
  process.exit(1);
}
if (setup.ignoreTerm) process.on("SIGTERM", () => {});
const sessions = new Map(); // id -> { mcp, model, history: [] }
const pending = new Map(); // our request id -> resolve
const prompts = new Map(); // session id -> { id, cancelled, resolveCancel }
let nextRequest = 500;
let nextSession = 1;
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextRequest++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const say = (sessionId, text) => {
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  sessions.get(sessionId)?.history.push(text);
};
const usage = { inputTokens: 1000, outputTokens: 200, cachedReadTokens: 400, cachedWriteTokens: 100, thoughtTokens: 50, totalTokens: 1750 };
// `configOptions: true` answers in the protocol's session config options
// (Kimi Code 2.x): the model is a select option of category "model".
let chosen = null;
let keyAuthenticated = false;
const configModel = (current, available) => ({
  configOptions: [
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] },
    { id: "model", name: "Model", category: "model", type: "select", currentValue: current, options: [{ group: "all", name: "All", options: available.map((value) => ({ value, name: value })) }] },
  ],
});
const models = (current) =>
  setup.models === null
    ? {}
    : setup.configOptions
      ? configModel(chosen ?? setup.models?.current ?? current, setup.models?.available ?? [current])
      : { models: { currentModelId: setup.models?.current ?? current, availableModels: (setup.models?.available ?? [current]).map((modelId) => ({ modelId, name: modelId })) } };

async function team(sessionId, name, args) {
  const server = sessions.get(sessionId).mcp.find((s) => s.name === "console");
  const auth = server.headers.find((h) => h.name === "Authorization").value;
  const response = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: name === "tools/list" ? "tools/list" : "tools/call", params: name === "tools/list" ? {} : { name, arguments: args } }),
  });
  return (await response.json()).result;
}

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const text = params.prompt.map((p) => p.text).join("\n");
  const [word, ...rest] = text.replace(/^[\s\S]*\n\n(?=\S)/, "").trim().split(/\s+/);
  const turn = { id, cancelled: false, resolveCancel: null };
  prompts.set(sessionId, turn);
  const cancelled = () => new Promise((resolve) => (turn.resolveCancel = resolve));
  // `xaiUsage` (Grok Build): usage in `_meta.usage` with xAI's meaning
  // (input includes the cache, reasoning beside output, total = input +
  // output), the same tokens as ACP's `usage` above.
  const xai = (u) => {
    if (u.totalTokens === 10) return { inputTokens: 1000, outputTokens: 200, totalTokens: 10 };
    const input = u.inputTokens + (u.cachedReadTokens ?? 0) + (u.cachedWriteTokens ?? 0);
    return { inputTokens: input, outputTokens: u.outputTokens, cachedReadTokens: u.cachedReadTokens, cacheCreationTokens: u.cachedWriteTokens, reasoningTokens: u.thoughtTokens, totalTokens: input + u.outputTokens };
  };
  const end = (stopReason, extra = {}) => {
    if (prompts.get(sessionId) === turn) prompts.delete(sessionId);
    const shaped = setup.xaiUsage && extra.usage ? { _meta: { usage: xai(extra.usage) } } : extra;
    send({ id, result: { stopReason, ...shaped } });
  };
  switch (word) {
    case "hello":
      say(sessionId, "Hello from the fake agent.");
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read README.md", kind: "read", status: "pending", locations: [{ path: `${process.cwd()}/README.md` }] });
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "the file" } }] });
      update(sessionId, { sessionUpdate: "plan", entries: [{ content: "Say hello", status: "completed", priority: "high" }] });
      say(sessionId, " Done.");
      return end("end_turn", { usage });
    case "env":
      say(sessionId, `env: ${Object.keys(process.env).filter((k) => /KEY|TOKEN/.test(k)).sort().join(",")}`);
      return end("end_turn", { usage });
    case "tools": {
      const r = await team(sessionId, "tools/list");
      say(sessionId, `tools: ${r.tools.map((t) => t.name).join(",")}`);
      return end("end_turn", { usage });
    }
    case "team_send": {
      const r = await team(sessionId, "team_send", { to: rest[0], message: rest.slice(1).join(" ") });
      say(sessionId, `team_send: ${r.content[0].text}`);
      return end("end_turn", { usage });
    }
    case "nousage":
      say(sessionId, "No usage this time.");
      return end("end_turn");
    case "slownousage":
      say(sessionId, "Slowly, and no usage.");
      await new Promise((r) => setTimeout(r, 500));
      return end("end_turn");
    case "badusage":
      say(sessionId, "Usage that does not add up.");
      return end("end_turn", { usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 10 } });
    case "repeat":
      update(sessionId, { sessionUpdate: "usage_update", used: 1500, size: 200000 });
      update(sessionId, { sessionUpdate: "usage_update", used: 1500, size: 200000 });
      say(sessionId, "Repeated.");
      return end("end_turn", { usage });
    case "late":
      say(sessionId, "Ending early.");
      end("end_turn", { usage });
      setTimeout(() => {
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LATE TEXT" } });
        update(sessionId, { sessionUpdate: "usage_update", used: 99999, size: 200000 });
      }, 50);
      return;
    case "sametick":
      // The answer and a later update in one write to stdout.
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage } }) +
          "\n" +
          JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "AFTER THE ANSWER" } } } }) +
          "\n",
      );
      if (prompts.get(sessionId) === turn) prompts.delete(sessionId);
      return;
    case "deep": {
      // A permission request whose input nests deeper than a stack allows.
      const n = 60_000;
      const raw = '{"a":'.repeat(n) + "1" + "}".repeat(n);
      const rid = nextRequest++;
      const answered = new Promise((resolve) => pending.set(rid, resolve));
      process.stdout.write(
        `{"jsonrpc":"2.0","id":${rid},"method":"session/request_permission","params":{"sessionId":${JSON.stringify(sessionId)},"toolCall":{"toolCallId":"d1","title":"Deep","kind":"execute","rawInput":${raw}},"options":[{"optionId":"yes","kind":"allow_once"}]}}\n`,
      );
      const r = await answered;
      say(sessionId, `deep: ${JSON.stringify(r)}`);
      return end("end_turn", { usage });
    }
    case "hugeline":
      // One complete notification line past the protocol's line limit.
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "current_mode_update", pad: "x".repeat(9 * 1024 * 1024) } } }) + "\n",
      );
      await new Promise(() => {});
      return;
    case "hang":
      say(sessionId, "Waiting.");
      await cancelled();
      return end("cancelled", { usage });
    case "deaf":
      say(sessionId, "Not listening.");
      await new Promise(() => {});
      return;
    case "ask":
    case "ask2":
    case "askhang":
    case "edit": {
      const asks =
        word === "edit"
          ? [{ toolCallId: "e1", title: `Edit ${rest[0]}`, kind: "edit", locations: [{ path: rest[0] }], rawInput: { path: rest[0] } }]
          : word === "ask2"
            ? [
                { toolCallId: "a1", title: "Run ls", kind: "execute", rawInput: { command: "ls" } },
                { toolCallId: "a2", title: "Fetch example.com", kind: "fetch", rawInput: { url: "https://example.com" } },
              ]
            : [{ toolCallId: "a1", title: "Run ls", kind: "execute", rawInput: { command: "ls" } }];
      const options = [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ];
      const answers = asks.map((toolCall) => request("session/request_permission", { sessionId, toolCall, options }));
      if (word === "askhang") {
        const [a] = await Promise.all(answers);
        say(sessionId, `answer: ${JSON.stringify(a.outcome)}`);
        return end(turn.cancelled ? "cancelled" : "end_turn", { usage });
      }
      const got = [];
      for (const a of answers) {
        const r = await a;
        got.push(r.outcome.outcome === "selected" ? r.outcome.optionId : r.outcome.outcome);
        if (word === "ask2" && got.length === 1) {
          fs.writeFileSync("parallel-resumed", "");
          for (let i = 0; i < 8; i++) say(sessionId, ` working ${i}`);
        }
      }
      say(sessionId, `decision: ${got.join(",")}`);
      return end("end_turn", { usage });
    }
    case "refuse":
      prompts.delete(sessionId);
      return send({ id, error: { code: -32603, message: "the model is not available" } });
    case "error":
      say(sessionId, "Trying.");
      prompts.delete(sessionId);
      return send({ id, error: { code: -32603, message: "provider error" } });
    default: {
      say(sessionId, `echo: ${text.slice(0, 80)}`);
      return end("end_turn", { usage });
    }
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  log({ method: m.method ?? null, id: m.id ?? null, params: m.params ?? null, result: m.result ?? null });
  if (m.method === undefined && m.id !== undefined) {
    const resolve = pending.get(m.id);
    pending.delete(m.id);
    return resolve?.(m.result ?? (m.error ? { error: m.error.message } : {}));
  }
  switch (m.method) {
    case "initialize": {
      // `badProtocolOnce`: the first program speaks another version.
      const marker = join(home, ".acp-bad-protocol-done");
      const bad = setup.badProtocolOnce && !fs.existsSync(marker);
      if (bad) fs.writeFileSync(marker, "");
      return send({
        id: m.id,
        result: {
          protocolVersion: bad ? 2 : (setup.protocolVersion ?? 1),
          agentCapabilities: { loadSession: setup.loadSession ?? true, mcpCapabilities: { http: setup.http ?? true } },
          authMethods: setup.keyAuth ? [{ id: setup.keyAuth, name: setup.keyAuth }, { id: "browser.login", name: "Sign in" }] : [],
        },
      });
    }
    case "authenticate":
      if (setup.keyAuth && m.params.methodId === setup.keyAuth) {
        keyAuthenticated = true;
        return send({ id: m.id, result: {} });
      }
      return send({ id: m.id, error: { code: -32000, message: "Sign-in is not available here" } });
    case "session/new": {
      if (setup.authRequired || (setup.keyAuth && !keyAuthenticated)) return send({ id: m.id, error: { code: -32000, message: "Authentication required" } });
      const id = `ses_${process.pid}_${nextSession++}`;
      sessions.set(id, { mcp: m.params.mcpServers, history: [] });
      send({ id: m.id, result: { sessionId: id, ...models(setup.defaultModel ?? "openai/gpt-5.6-luna") } });
      return;
    }
    case "session/load": {
      const id = m.params.sessionId;
      sessions.set(id, { mcp: m.params.mcpServers, history: [] });
      // The history is replayed as updates before the answer.
      update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED HISTORY" } });
      return send({ id: m.id, result: { ...models(setup.defaultModel ?? "openai/gpt-5.6-luna") } });
    }
    case "session/set_model":
      if (setup.setModelFails) return send({ id: m.id, error: { code: -32602, message: "unknown model" } });
      return send({ id: m.id, result: {} });
    case "session/set_config_option":
      if (!setup.configOptions || m.params.configId !== "model") return send({ id: m.id, error: { code: -32602, message: "unknown option" } });
      if (!setup.ignoreConfig) chosen = m.params.value;
      return send({ id: m.id, result: models(setup.defaultModel ?? "openai/gpt-5.6-luna") });
    case "session/prompt":
      return void prompt(m.id, m.params);
    case "session/cancel": {
      const turn = prompts.get(m.params.sessionId);
      if (turn) {
        turn.cancelled = true;
        turn.resolveCancel?.();
      }
      return;
    }
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: "Method not found" } });
  }
});
setInterval(() => {}, 1 << 30);
