// A scripted stand-in for Claude Code 2.1.282 in stream-json mode (-2
// tests). It records its arguments and environment names in its working
// folder, and acts on each prompt's first word:
//   hello      streams text, runs a tool whose output contains its token
//   apikey     reports API credentials in its init event
//   nokey      reports no API credentials (the login) in its init event
//   wrongmodel reports another model
//   approve P  asks the Console's permission tool to Write P, says the answer
//   network    asks the host for network access, says the answer
//   hang       waits; an interrupt ends the turn as Claude does
//   deaf       waits and ignores interrupts (only a signal ends it)
//   flood      prints a lot of tool output
//   exit       exits mid-turn
//   limited    reports the account's usage limit
//   noinit     answers without an init event
//   stopapprove P  waits; on an interrupt asks to Write P, then stops
//   write NAME writes NAME in its folder (a change to commit)
//   question   asks the owner through AskUserQuestion
//   tool NAME  asks permission for tool NAME
//   bash CMD   asks permission to run CMD with Bash
//   helper     runs a helper (Agent call, a Read inside it, its transcript
//              file, a result naming its agentId)
//   helperhang starts a helper and waits (Stop ends it)
//   gauge      reports a request's usage, a helper's (ignored), a compaction
//              and the model's context window
//   todos      a TodoWrite list, then one the client rejects; a helper's
//              TodoWrite (its private list)
//   tasks      TaskCreate and TaskUpdate, a helper's TaskCreate, a rejected
//              create, an update by the `id` alias, a delete
//   taskhang   a TaskCreate whose result never comes; waits (Stop ends it)
//   parallelwait  two permission requests at once (as two helpers would);
//              the branch answered first writes parallel-resumed and keeps
//              talking while the other still waits
// Team tools over the Console's MCP server:
//   tools      lists the tools its session is offered
//   team_list, team_push
//   team_send NAME TEXT, team_ask NAME TEXT
//   twice NAME TEXT   the same team_send twice in one turn
//   two NAME          team_send "one", then "two"
//   call TOOL JSON    calls any team tool with these arguments
//   put NAME TEXT     writes TEXT into NAME
//   gitcommit NAME    writes NAME and commits it itself (git in a command)
//   ($TOKEN in call and put stands for its own login token, as an agent
//   that read its environment would write it)
//   reply TEXT        team_reply to the ask in this prompt
//   bounce            team_send "bounce" back to the sender
//   bouncewrite       writes a new file (a commit), then bounces "bouncewrite"
//   bouncecommit      commits a new file itself (git), then bounces "bouncecommit"
//   reports           team_report r1, r1 again, r2, r3, r4
//   sendhang NAME TEXT  team_send, then waits (for a crash mid-turn)
// A team prompt's first message is the command; a Re-send that lists
// earlier actions just carries on (it echoes).
import fs from "node:fs";
import readline from "node:readline";

const argv = process.argv.slice(2);
const arg = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
fs.appendFileSync("args.jsonl", JSON.stringify(argv) + "\n");
fs.writeFileSync("env.json", JSON.stringify(Object.keys(process.env).sort()));
const model = arg("--model") === "haiku" ? "claude-haiku-4-5-20251001" : arg("--model");
const session = arg("--resume") ?? `sess-${process.pid}`;
const mcp = JSON.parse(fs.readFileSync(arg("--mcp-config"), "utf8")).mcpServers.console;
const send = (x) => process.stdout.write(JSON.stringify(x) + "\n");
// As Claude Code reports it: the API key when one is in its environment.
const keySource = process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "none";
const init = (extra = {}) => send({ type: "system", subtype: "init", session_id: session, model, apiKeySource: keySource, ...extra });
// On an API key, each model's usage too (the window's model and a small
// Haiku request of the client's own).
const modelUsage = process.env.ANTHROPIC_API_KEY
  ? {
      modelUsage: {
        [model]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 1, cacheCreationInputTokens: 0, webSearchRequests: 0, contextWindow: 200000 },
        ...(model.startsWith("claude-haiku") ? {} : { "claude-haiku-4-5-20251001": { inputTokens: 20, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0 } }),
      },
    }
  : {};
const result = (text, extra = {}) =>
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: session,
    num_turns: 1,
    duration_ms: 5,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 },
    ...modelUsage,
    ...extra,
  });
const say = (text) => {
  send({ type: "stream_event", event: { type: "message_start", message: { model } } });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
  send({ type: "assistant", message: { model, content: [{ type: "text", text }] } });
};
let waiting = null; // "hang" | "deaf"
async function approve(path, tool = "Write", input = { file_path: path, content: "x" }) {
  const response = await fetch(mcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: mcp.headers.Authorization },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "approve", arguments: { tool_name: tool, input } } }),
  });
  return JSON.parse((await response.json()).result.content[0].text);
}
async function teamTool(name, args) {
  const response = await fetch(mcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: mcp.headers.Authorization },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  const r = (await response.json()).result;
  return `${r.isError ? "error: " : ""}${r.content[0].text}`;
}
/** A team prompt's first message is the command (with its sender). */
function command(content) {
  let text = content.replace(/^The owner uploaded [\s\S]*?\n\n/, "");
  text = text.replace(/^Your folder now has your teammates' [\s\S]*?\n\n/, "");
  text = text.replace(/^These teammates' commits could not be checked out[\s\S]*?\n\n/, "");
  if (/^Your previous attempt was interrupted after/.test(text)) return { text: "resumed", from: null, cid: null };
  text = text.replace(/^Your previous attempt was interrupted[\s\S]*?\n\n/, "");
  text = text.replace(/^Your merge of [\s\S]*?\n\n/, "");
  const team = /^Messages from your team \(\d+\):\n\n\[1\] From ([^\n(:]+?)(?: \([^\n]*?(c[0-9a-f]{12})\))?:\n([\s\S]*?)(?:\n\n\[2\]|\n\nAnswer each ask|$)/.exec(text);
  return team ? { text: team[3], from: team[1].trim(), cid: team[2] ?? null } : { text, from: null, cid: null };
}
// Like a real client, it takes a moment to exit after TERM.
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 600));
const controls = new Map();

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const q = JSON.parse(line);
  if (q.type === "control_request" && q.request?.subtype === "interrupt") {
    if (waiting === "hang") {
      waiting = null;
      result("", { subtype: "error_during_execution", is_error: true });
    }
    if (waiting?.startsWith("stopapprove ")) {
      // Asks for a tool after being told to stop, then stops.
      const decision = await approve(waiting.slice(12));
      waiting = null;
      say(`decision: ${decision.behavior}`);
      result("", { subtype: "error_during_execution", is_error: true });
    }
    return;
  }
  if (q.type === "control_response") {
    controls.get(q.response.request_id)?.(q.response.response);
    return;
  }
  if (q.type !== "user") return;
  // A Console upload notice comes first; the owner's own words follow it.
  const cmd = command(q.message.content);
  const asked = cmd.text;
  const [word, rest] = [asked.split(" ")[0], asked.split(" ").slice(1).join(" ")];
  if (word === "apikey") {
    init({ apiKeySource: "ANTHROPIC_API_KEY" });
    say("should not be kept");
    return result("x");
  }
  if (word === "nokey") {
    init({ apiKeySource: "none" });
    say("should not be kept");
    return result("x");
  }
  if (word === "wrongmodel") {
    send({ type: "system", subtype: "init", session_id: session, model: "claude-opus-5-5", apiKeySource: "none" });
    say("should not be kept");
    return result("x");
  }
  if (word === "noinit") return result("done without init");
  if (word === "preapprove") {
    // Asks the permission tool before its init event.
    const decision = await approve(rest);
    init();
    say(`decision: ${decision.behavior}`);
    return result(decision.behavior);
  }
  init();
  if (word === "parallelwait") {
    const first = approve("", "ParallelOne", {}).then(() => {
      fs.writeFileSync("parallel-resumed", "yes");
      const ticker = setInterval(() => say("helper work continues"), 100);
      setTimeout(() => clearInterval(ticker), 4000);
    });
    const second = approve("", "ParallelTwo", {});
    await Promise.all([first, second]);
    return result("both answers returned");
  }
  if (word === "tools") {
    const response = await fetch(mcp.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: mcp.headers.Authorization },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }),
    });
    const listed = (await response.json()).result.tools.map((t) => t.name).join(",");
    say(`tools: ${listed}`);
    return result(`tools: ${listed}`);
  }
  if (word === "hello") {
    send({ type: "stream_event", event: { type: "message_start", message: { model } } });
    send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Let me look." } } });
    for (const part of ["Hi ", "there."])
      send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: part } } });
    send({ type: "assistant", message: { model, content: [{ type: "text", text: "Hi there." }] } });
    send({ type: "assistant", message: { model, content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "env" } }] } });
    send({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: `TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN} MCP=${mcp.headers.Authorization}`, is_error: false },
        ],
      },
    });
    return result("Hi there.");
  }
  if (word === "leak") {
    fs.writeFileSync(rest, `debug: ${process.env.CLAUDE_CODE_OAUTH_TOKEN}\n`);
    say(`wrote ${rest}`);
    return result("ok");
  }
  if (word === "team_list" || word === "team_push") {
    const out = await teamTool(word, {});
    say(`${word}: ${out}`);
    return result("ok");
  }
  if (word === "team_send" || word === "team_ask" || word === "twice" || word === "sendhang") {
    const [to, ...message] = rest.split(" ");
    const tool = word === "team_ask" ? "team_ask" : "team_send";
    const outs = [await teamTool(tool, { to, message: message.join(" ") })];
    if (word === "twice") outs.push(await teamTool(tool, { to, message: message.join(" ") }));
    if (word === "sendhang") {
      waiting = "hang";
      return;
    }
    say(`${word}: ${outs.join(" | ")}`);
    return result("ok");
  }
  const own = (s) => s.split("$TOKEN").join(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "");
  if (word === "call") {
    const [tool, ...json] = own(rest).split(" ");
    const out = await teamTool(tool, JSON.parse(json.join(" ") || "{}"));
    say(`${tool}: ${out}`);
    return result("ok");
  }
  if (word === "put") {
    const [name, ...text] = own(rest).split(" ");
    fs.writeFileSync(name, `${text.join(" ")}\n`);
    say(`put ${name}`);
    return result("ok");
  }
  if (word === "gitcommit") {
    const { execFileSync } = await import("node:child_process");
    fs.writeFileSync(rest, "committed by the agent\n");
    const env = { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["add", rest], { env });
    execFileSync("git", ["-c", "user.name=Agent", "-c", "user.email=a@x", "commit", "-q", "-m", "agent commit", "--", rest], { env });
    say(`committed ${rest}`);
    return result("ok");
  }
  if (word === "two") {
    const outs = [await teamTool("team_send", { to: rest, message: "one" }), await teamTool("team_send", { to: rest, message: "two" })];
    say(`two: ${outs.join(" | ")}`);
    return result("ok");
  }
  if (word === "reply") {
    const out = await teamTool("team_reply", { correlation_id: cmd.cid ?? "c000000000000", message: rest });
    say(`replied: ${out}`);
    return result("ok");
  }
  if (word === "bouncewrite") {
    fs.writeFileSync(`work-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`, "progress\n");
    const out = await teamTool("team_send", { to: cmd.from, message: "bouncewrite" });
    say(`bounced: ${out}`);
    return result("ok");
  }
  if (word === "bouncecommit") {
    const { execFileSync } = await import("node:child_process");
    const name = `own-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
    fs.writeFileSync(name, "committed by the agent\n");
    const env = { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["add", "-A"], { env });
    execFileSync("git", ["-c", "user.name=Agent", "-c", "user.email=a@x", "commit", "-q", "-m", "agent commit"], { env });
    const out = await teamTool("team_send", { to: cmd.from, message: "bouncecommit" });
    say(`bounced: ${out}`);
    return result("ok");
  }
  if (word === "reports") {
    const outs = [];
    for (const m of ["r1", "r1", "r2", "r3", "r4"]) outs.push(await teamTool("team_report", { message: m }));
    say(`reports: ${outs.join(" | ")}`);
    return result("ok");
  }
  if (word === "bounce") {
    const out = await teamTool("team_send", { to: cmd.from, message: "bounce" });
    say(`bounced: ${out}`);
    return result("ok");
  }
  if (word === "write") {
    fs.writeFileSync(rest, `written by claude ${Date.now()}\n`);
    say(`wrote ${rest}`);
    return result("ok");
  }
  if (word === "question") {
    const decision = await approve("", "AskUserQuestion", { questions: [{ question: "Which colour?", header: "Colour", options: [{ label: "Red" }, { label: "Blue" }] }] });
    say(`question: ${decision.message ?? decision.behavior}`);
    return result("ok");
  }
  if (word === "helper" || word === "helperhang") {
    send({ type: "assistant", message: { model, content: [{ type: "tool_use", id: "toolu_agent1", name: "Agent", input: { description: "Look around", subagent_type: "Explore", prompt: "x" } }] } });
    // Claude Code writes the helper's transcript and its metadata (which
    // names the call that started it) as the helper runs.
    const dir = `${process.env.HOME}/.claude/projects/${process.cwd().replace(/[^A-Za-z0-9]/g, "-")}/${session}/subagents`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/agent-a1234567890abcdef.jsonl`, JSON.stringify({ type: "user", message: { content: "helper transcript line" } }) + "\n");
    fs.writeFileSync(`${dir}/agent-a1234567890abcdef.meta.json`, JSON.stringify({ agentType: "Explore", description: "Look around", toolUseId: "toolu_agent1" }));
    send({ type: "assistant", parent_tool_use_id: "toolu_agent1", message: { model, content: [{ type: "tool_use", id: "toolu_sub1", name: "Read", input: { file_path: "README.md" } }] } });
    if (word === "helperhang") {
      waiting = "hang";
      return;
    }
    send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_agent1", content: "Done.\nagentId: a1234567890abcdef (use SendMessage to continue)" }] } });
    return result("ok");
  }
  if (word === "gauge") {
    send({ type: "assistant", message: { model, content: [{ type: "text", text: "Measuring." }], usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 3 } } });
    // A helper's request has its own context: never the window's gauge.
    send({ type: "assistant", parent_tool_use_id: "toolu_helper", message: { model, content: [{ type: "text", text: "x" }], usage: { input_tokens: 50000, output_tokens: 1 } } });
    send({ type: "system", subtype: "compact_boundary", session_id: session, compact_metadata: { trigger: "auto", pre_tokens: 150000 } });
    return result("Measured.", { modelUsage: { [model]: { inputTokens: 100, cacheReadInputTokens: 900, cacheCreationInputTokens: 0, outputTokens: 3, contextWindow: 200000 }, "claude-other-model": { inputTokens: 5, contextWindow: 1000 } } });
  }
  if (word === "todos") {
    const call = (id, todos, parent) =>
      send({ type: "assistant", ...(parent ? { parent_tool_use_id: parent } : {}), message: { model, content: [{ type: "tool_use", id, name: "TodoWrite", input: { todos } }] } });
    const ok = (id, content = "Todos have been modified successfully.", extra = {}) =>
      send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] } });
    call("todo1", [
      { content: "Read the code", status: "completed", activeForm: "Reading the code" },
      { content: `Fix it ${process.env.CLAUDE_CODE_OAUTH_TOKEN}`, status: "in_progress", activeForm: "Fixing it" },
      { content: "Run the tests", status: "pending", activeForm: "Running the tests" },
    ]);
    ok("todo1");
    call("todo2", [{ content: "Rejected", status: "pending", activeForm: "x" }]);
    ok("todo2", "InputValidationError", { is_error: true });
    call("todo3", [{ content: "Helper's own", status: "pending", activeForm: "x" }], "toolu_helper");
    send({ type: "user", parent_tool_use_id: "toolu_helper", message: { content: [{ type: "tool_result", tool_use_id: "todo3", content: "Todos have been modified successfully." }] } });
    return result("listed");
  }
  if (word === "tasks") {
    const call = (id, name, input, parent) =>
      send({ type: "assistant", ...(parent ? { parent_tool_use_id: parent } : {}), message: { model, content: [{ type: "tool_use", id, name, input }] } });
    const res = (id, content, parent, error) =>
      send({ type: "user", ...(parent ? { parent_tool_use_id: parent } : {}), message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(error ? { is_error: true } : {}) }] } });
    call("tc1", "TaskCreate", { subject: "Plan the change", description: "x" });
    res("tc1", "Task #1 created successfully: Plan the change");
    call("tc2", "TaskCreate", { subject: "Write the code", description: "x", activeForm: "Writing" });
    res("tc2", "Task #2 created successfully: Write the code");
    call("tu1", "TaskUpdate", { taskId: "1", status: "completed" });
    res("tu1", "Updated task #1 status");
    call("tc3", "TaskCreate", { subject: "Helper's check", description: "x" }, "toolu_helper");
    res("tc3", "Task #3 created successfully: Helper's check", "toolu_helper");
    call("tc4", "TaskCreate", { subject: "Rejected", description: "x" });
    res("tc4", "Error: rejected", null, true);
    call("tu2", "TaskUpdate", { id: "2", status: "in_progress", subject: "Write the fix" });
    res("tu2", "Updated task #2 subject, status");
    call("tu3", "TaskUpdate", { taskId: "3", status: "deleted" });
    res("tu3", "Updated task #3 deleted");
    return result("tasked");
  }
  if (word === "taskhang") {
    send({ type: "assistant", message: { model, content: [{ type: "tool_use", id: "tch", name: "TaskCreate", input: { subject: "Never settled", description: "x" } }] } });
    waiting = "hang";
    return;
  }
  if (word === "bash") {
    const decision = await approve("", "Bash", { command: rest });
    say(`bash: ${decision.behavior}`);
    return result("ok");
  }
  if (word === "tool") {
    const decision = await approve("", rest, { url: "https://example.com" });
    say(`tool: ${decision.behavior}`);
    return result("ok");
  }
  if (word === "approve") {
    const decision = await approve(rest);
    say(`decision: ${decision.behavior}`);
    return result(decision.behavior);
  }
  if (word === "network") {
    const id = `req-${Date.now()}`;
    const answer = new Promise((resolve) => controls.set(id, resolve));
    send({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "SandboxNetworkAccess", input: { host: "example.com" } } });
    const response = await answer;
    say(`network: ${response.behavior}`);
    return result(response.behavior);
  }
  if (word === "stopapprove") {
    waiting = `stopapprove ${rest}`;
    return;
  }
  if (word === "hang" || word === "deaf") {
    waiting = word;
    return;
  }
  if (word === "flood") {
    for (let i = 0; i < 40; i++)
      send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `f${i}`, content: "y".repeat(100_000) }] } });
    return result("flooded");
  }
  if (word === "exit") process.exit(3);
  if (word === "limited") {
    send({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
    return result("", { subtype: "error_during_execution", is_error: true });
  }
  say(`echo: ${q.message.content}`);
  result("ok");
});
