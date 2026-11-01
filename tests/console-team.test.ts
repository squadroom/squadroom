import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../src/lib/console/commands.ts";
import { needsView, projectView, workerView } from "../src/lib/console/views.ts";
import {
  commitMessage,
  firstSentence,
  resendNote,
  TeamError,
  teamPrompt,
} from "../src/lib/console/team.ts";
import { transcript } from "../src/lib/console/transcript.ts";
import { harness } from "./helpers/console-harness.ts";

// team tools and the mailbox, limits and Pause, the
// reviewer's refresh and commit messages. Fakes only: no model, no
// network.

type H = Awaited<ReturnType<typeof harness>>;
const timeline = (h: H) => projectView(h.store, h.project.id)!.tabs[0].timeline;
const lastTurn = (h: H, agentId: string) =>
  Math.max(...h.events(agentId).map((e) => e.turnId));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
    } as Record<string, string> as NodeJS.ProcessEnv,
  }).trim();

test("prompts, Re-send notes and commit messages", () => {
  const base = {
    tabId: "t",
    to: "b",
    turnId: null,
    fromTurn: 1,
    instructionId: 1,
    resendAfter: null,
    createdAt: 0,
    state: "queued" as const,
  };
  const prompt = teamPrompt([
    {
      ...base,
      id: 1,
      from: "a",
      fromName: "Lead",
      kind: "ask",
      correlationId: "c0123456789ab",
      body: "Review this.",
    },
    {
      ...base,
      id: 2,
      from: "a",
      fromName: "Lead",
      kind: "send",
      correlationId: null,
      body: "Also: tests pass.",
    },
  ]);
  assert.equal(
    prompt,
    "Messages from your team (2):\n\n[1] From Lead (an ask, correlation id c0123456789ab):\nReview this.\n\n[2] From Lead:\nAlso: tests pass.\n\nAnswer each ask with team_reply(correlation_id, message); an ask you do not answer that way is answered with your final message.",
  );
  assert.equal(
    resendNote([]),
    "Your previous attempt was interrupted before it used any team tool. Start again.\n\n",
  );
  assert.match(
    resendNote([
      {
        turnId: 1,
        tool: "team_send",
        summary: "team_send to Lead: noted",
        result: "Sent to Lead.",
      },
    ]),
    /after these actions:\n- team_send to Lead: noted → Sent to Lead\.\nDo not repeat them/,
  );
  // The subject: the agent's summary, else the request's first sentence,
  // cut on a word; the body keeps the whole request and names the agent.
  assert.equal(
    firstSentence("Fix the login page. Then run the tests."),
    "Fix the login page",
  );
  assert.equal(
    firstSentence(
      "Please refactor the authentication module so that every route checks the session before it reads",
    ),
    "Please refactor the authentication module so that every route checks…",
  );
  const message = commitMessage({
    request: "Fix the login page. Then run the tests.",
    summary: null,
    agentName: "Lead",
    agentId: "a0123456789ab",
    turnId: 7,
  });
  assert.equal(
    message,
    "Fix the login page\n\nRequest:\nFix the login page. Then run the tests.\n\nAgent: Lead (a0123456789ab)\nConsole-Turn: 7",
  );
  // The whole request, however long (it is already bounded).
  const long = "word ".repeat(2000).trim();
  assert.ok(commitMessage({ request: long, summary: null, agentName: "Lead", agentId: "a0123456789ab", turnId: 9 }).includes(`Request:\n${long}\n`));
  assert.match(
    commitMessage({
      request: "x",
      summary: "Added the retry. It waits 2 s between attempts.",
      agentName: "Lead",
      agentId: "a0123456789ab",
      turnId: 8,
    }),
    /^Added the retry\n\nRequest:\nx\n\nSummary:\nAdded the retry\. It waits 2 s between attempts\.\n\nAgent:/,
  );
});

test("an ask is answered once by the turn's final message, and the answer comes back to the asker", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  const reviewer = h.agent("Reviewer", "look");
  await h.ready(lead.id, reviewer.id);
  await h.ended(h.send(lead.id, "team_list"));
  assert.match(
    h.said(lead.id).at(-1)!,
    new RegExp(`- Lead \\(id ${lead.id}\\) \\(you\\): Claude Code Haiku, edits its folder, working\\n- Reviewer \\(id ${reviewer.id}\\): Claude Code Haiku, Look only, idle`),
  );
  await h.ended(h.send(lead.id, "team_ask Reviewer please review"));
  assert.match(
    h.said(lead.id).at(-1)!,
    /^team_ask: Asked Reviewer \(correlation id c[0-9a-f]{12}\)/,
  );
  // The Reviewer takes it as a team turn and its final message answers.
  await h.until(
    () => h.said(lead.id).some((s) => s.includes("the answer to your ask")),
    "answer delivered",
  );
  await h.until(() => h.store.openTurns().length === 0, "all idle");
  const [ask, reply] = timeline(h);
  assert.deepEqual(
    [ask.from, ask.to, ask.kind, ask.state],
    ["Lead", "Reviewer", "ask", "answered"],
  );
  assert.deepEqual(
    [reply.from, reply.to, reply.kind, reply.state, reply.correlationId],
    ["Reviewer", "Lead", "reply", "done", ask.correlationId],
  );
  // The Look only Reviewer is first told which of the Lead's commits its
  // folder now shows, then gets the messages.
  assert.match(
    reply.text,
    /^echo: Your folder now has your teammates' latest committed work \(read it with git here, or with team_diff\):\n- Lead's commit [0-9a-f]{12} is checked out in your folder; Lead's branch started at [0-9a-f]{12}, so git diff [0-9a-f]{12} HEAD shows all of its changes\.\n\nMessages from your team \(1\):/,
  );
  assert.equal(timeline(h).length, 2);
  // The Reviewer's window shows who wrote; the Lead's shows the answer.
  assert.ok(
    transcript(h.events(reviewer.id)).some(
      (b) =>
        b.type === "team" &&
        b.messages[0].from === "Lead" &&
        b.messages[0].kind === "ask",
    ),
  );
  assert.match(
    h.said(lead.id).at(-1)!,
    new RegExp(
      `From Reviewer \\(the answer to your ask ${ask.correlationId}\\)`,
    ),
  );
  // Team turns belong to the owner's instruction.
  const leadTurns = h.events(lead.id).map((e) => e.turnId);
  assert.equal(h.store.turn(Math.max(...leadTurns))!.trigger, "team");
});

test("team_reply answers exactly once; a repeated call in one turn does not send twice; team_send is never a reply", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  const reviewer = h.agent("Reviewer");
  await h.ready(lead.id, reviewer.id);
  await h.ended(h.send(lead.id, "team_ask Reviewer reply looks good"));
  await h.until(
    () => timeline(h).some((m) => m.kind === "reply" && m.state === "done"),
    "answered",
  );
  await h.until(() => h.store.openTurns().length === 0, "idle");
  const replies = timeline(h).filter((m) => m.kind === "reply");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "looks good");
  assert.match(h.said(reviewer.id).at(-1)!, /^replied: Answered Lead\./);
  // An answered ask cannot be answered again, by anyone.
  const ask = timeline(h).find((m) => m.kind === "ask")!;
  const turn = lastTurn(h, reviewer.id);
  assert.throws(
    () =>
      h.store.replyTeamMessage(h.worker.epoch!, {
        turnId: turn,
        from: h.store.agent(reviewer.id)!,
        correlationId: ask.correlationId!,
        body: "again",
        key: "k",
        summary: "s",
      }),
    (e: unknown) =>
      e instanceof TeamError && /already answered/.test((e as Error).message),
  );
  // The same call twice in one turn: one message, the first result twice.
  await h.ended(h.send(lead.id, "twice Reviewer hi"));
  const [first, second] = h
    .said(lead.id)
    .at(-1)!
    .replace("twice: ", "")
    .split(" | ");
  assert.equal(first, second);
  await h.until(
    () =>
      h.store.openTurns().length === 0 &&
      !h.store.queuedMessages(reviewer.id).length,
    "delivered",
  );
  assert.equal(timeline(h).filter((m) => m.text === "hi").length, 1);
  // A teammate that does not exist, or yourself, is refused.
  await h.ended(h.send(lead.id, "team_send Nobody hi"));
  assert.match(h.said(lead.id).at(-1)!, /error: No teammate called "Nobody"/);
  await h.ended(h.send(lead.id, "team_send Lead hi"));
  assert.match(h.said(lead.id).at(-1)!, /error: No teammate called "Lead"/);
  // Two teammates of one name: the name is refused, the id works.
  const twin = h.agent("reviewer");
  await h.ready(twin.id);
  await h.ended(h.send(lead.id, "team_send Reviewer hi"));
  assert.match(h.said(lead.id).at(-1)!, /error: Several teammates are called "Reviewer"; give the id/);
  await h.ended(h.send(lead.id, `team_send ${twin.id} hello twin`));
  assert.match(h.said(lead.id).at(-1)!, /^team_send: Sent to reviewer\./);
  // A closed teammate takes no more messages.
  runCommand(h.store, { action: "close", agentId: twin.id });
  await h.ended(h.send(lead.id, `team_send ${twin.id} again`));
  assert.match(h.said(lead.id).at(-1)!, /error: No teammate called/);
  // A reply without an ask of its own is refused.
  await h.ended(h.send(lead.id, "reply out of nowhere"));
  assert.match(
    h.said(lead.id).at(-1)!,
    /error: No ask with that correlation id was given to you/,
  );
});

test("queued messages are delivered together when the agent is free, one instruction per batch, after the sending turn ends", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  const reviewer = h.agent("Reviewer");
  await h.ready(lead.id, reviewer.id);
  const busy = h.send(reviewer.id, "hang");
  await h.started(busy);
  await h.ended(h.send(lead.id, "two Reviewer"));
  await h.ended(h.send(lead.id, "team_send Reviewer three"));
  assert.deepEqual(timeline(h).map((m) => m.state), ["queued", "queued", "queued"]);
  runCommand(h.store, { action: "stop", agentId: reviewer.id });
  await h.ended(busy);
  await h.until(() => timeline(h).every((m) => m.state === "done"), "all delivered");
  // One turn for the first instruction's two messages, one for the next.
  const prompts = h.said(reviewer.id).filter((s) => s.startsWith("echo: Messages from your team"));
  assert.deepEqual(prompts, [
    "echo: Messages from your team (2):\n\n[1] From Lead:\none\n\n[2] From Lead:\ntwo",
    "echo: Messages from your team (1):\n\n[1] From Lead:\nthree",
  ]);
  // A message waits while the turn that sent it is still running (its
  // commit comes first), and is delivered once it ends.
  const sending = h.send(lead.id, "sendhang Reviewer later");
  await h.until(() => timeline(h).some((m) => m.text === "later"), "queued");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(timeline(h).find((m) => m.text === "later")!.state, "queued");
  runCommand(h.store, { action: "stop", agentId: lead.id });
  await h.ended(sending);
  await h.until(() => timeline(h).find((m) => m.text === "later")!.state === "done", "delivered after the sender's turn");
});

test("a paused agent's queued turn is never claimed; a creating agent that fails sends its mail to Needs you", async (t) => {
  const h = await harness(t);
  const epoch = h.store.takeLease("test", Date.now())!;
  const lead = h.agent("Lead");
  const other = h.agent("Other");
  h.store.setAgentFolder(epoch, lead.id, h.root);
  const queued = h.send(lead.id, "hello");
  h.store.setPaused("tab", h.tab.id, true, "Paused by the owner.");
  assert.equal(h.store.startTurn(epoch, queued), false);
  h.store.setPaused("tab", h.tab.id, false);
  assert.equal(h.store.startTurn(epoch, queued), true);
  // Mail queued to Other while it is set up, then its setup fails.
  h.store.sendTeamMessage(epoch, { turnId: queued, from: h.store.agent(lead.id)!, to: h.store.agent(other.id)!, kind: "send", body: "hi", key: "k", summary: "s" });
  h.store.setAgentError(epoch, other.id, "no disk");
  assert.deepEqual(needsView(h.store).messages.map((m) => [m.to, m.text]), [["Other", "hi"]]);
  h.store.releaseLease(epoch);
});

test("a crash mid-turn: messages wait in Needs you; Re-send lists what was already done and repeats nothing", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  const reviewer = h.agent("Reviewer");
  await h.ready(lead.id, reviewer.id);
  await h.ended(h.send(lead.id, "team_ask Reviewer sendhang Lead noted"));
  // The Reviewer sends "noted", then hangs; the worker goes away.
  await h.until(
    () => timeline(h).some((m) => m.text === "noted"),
    "sent before the crash",
  );
  await h.worker.stop();
  const ask = timeline(h).find((m) => m.kind === "ask")!;
  assert.equal(ask.state, "interrupted");
  const { ConsoleWorker } = await import("../src/lib/console/worker.ts");
  const { Launcher } = await import("../src/lib/console/launcher.ts");
  const next = new ConsoleWorker({
    store: h.store,
    launcher: new Launcher({ command: [join(h.root, "launcher")] }),
    paths: { agentHome: h.agentHome, shared: h.shared },
    keysFile: join(h.root, "keys.json"),
    binary: () => join(h.root, "claude"),
    tickMs: 25,
    stopGraceMs: 300,
    log: () => {},
  });
  await next.start();
  try {
    // Never replayed by itself; shown in Needs you.
    const waiting = needsView(h.store).messages.find((m) => m.id === ask.id)!;
    assert.deepEqual(
      [waiting.from, waiting.to, waiting.kind],
      ["Lead", "Reviewer", "ask"],
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      h.store.timeline(h.tab.id).find((m) => m.id === ask.id)!.state,
      "interrupted",
    );
    runCommand(h.store, { action: "resendMessage", messageId: ask.id });
    await h.until(
      () =>
        h.store.timeline(h.tab.id).find((m) => m.id === ask.id)!.state ===
        "answered",
      "answered after Re-send",
    );
    // The new attempt was told what the first one did, and did not repeat it.
    const resent = h.store.turn(lastTurn(h, reviewer.id))!;
    assert.equal(resent.resendOf !== null, true);
    assert.match(
      h.said(reviewer.id).at(-1)!,
      /^echo: Your previous attempt was interrupted after these actions:\n- team_send to Lead: noted → Sent to Lead\./,
    );
    assert.equal(
      h.store.timeline(h.tab.id).filter((m) => m.body === "noted").length,
      1,
    );
    // Discard clears one; it is never delivered.
    assert.throws(
      () =>
        runCommand(h.store, { action: "discardMessage", messageId: ask.id }),
      /no longer waiting/,
    );
  } finally {
    await next.stop();
  }
});

test("the stall check pauses a tab whose agents are all idle while an ask is open", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  const reviewer = h.agent("Reviewer");
  await h.ready(lead.id, reviewer.id);
  const busy = h.send(reviewer.id, "hang");
  await h.started(busy);
  await h.ended(h.send(lead.id, "team_ask Reviewer anything"));
  // The Reviewer can no longer take messages (set up failed, say).
  (
    h.store as unknown as {
      db: { prepare: (s: string) => { run: (...a: unknown[]) => void } };
    }
  ).db
    .prepare(
      "UPDATE console_agents SET state = 'error', error = 'gone' WHERE id = ?",
    )
    .run(reviewer.id);
  runCommand(h.store, { action: "stop", agentId: reviewer.id });
  await h.ended(busy);
  await h.until(() => h.store.pauseReason("tab", h.tab.id) !== null, "paused");
  assert.match(
    h.store.pauseReason("tab", h.tab.id)!,
    /^Waiting on an answer that is not coming/,
  );
  assert.ok(
    needsView(h.store).paused.some(
      (p) => p.scope === "tab" && p.id === h.tab.id,
    ),
  );
});

test("the turn limit per instruction pauses the tab; Resume lets the team continue", async (t) => {
  const h = await harness(t, { turnsPerInstruction: 3 });
  await h.worker.start();
  const lead = h.agent("Lead");
  const reviewer = h.agent("Reviewer");
  await h.ready(lead.id, reviewer.id);
  // Lead → Reviewer → Lead → … for ever, but for the limit.
  await h.ended(h.send(lead.id, "team_send Reviewer bounce"));
  await h.until(
    () => h.store.pauseReason("tab", h.tab.id) !== null,
    "paused at the limit",
  );
  assert.match(
    h.store.pauseReason("tab", h.tab.id)!,
    /^Limit reached: one instruction caused 3 agent turns \(the limit is 3\)/,
  );
  await h.until(() => h.store.openTurns().length === 0, "idle");
  assert.equal(
    h.store.instructionUse(
      h.store.turn(lastTurn(h, lead.id))!.instructionId!,
      h.tab.id,
    ).turns,
    3,
  );
  // One message waits for Resume.
  assert.equal(timeline(h).filter((m) => m.state === "queued").length, 1);
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.until(
    () => timeline(h).filter((m) => m.state === "done").length >= 4,
    "continued",
  );
  await h.until(
    () => h.store.pauseReason("tab", h.tab.id) !== null,
    "paused again",
  );
  runCommand(h.store, {
    action: "pause",
    scope: "tab",
    id: h.tab.id,
    mode: "now",
  });
});

test("Pause after current turns, Stop now and Resume, for a tab, a project and everything", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  // After current turns: the running turn finishes; nothing new starts.
  const running = h.send(lead.id, "hang");
  await h.started(running);
  runCommand(h.store, { action: "pause", scope: "tab", id: h.tab.id });
  const held = h.send(lead.id, "hello");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.store.turn(running)!.status, "running");
  // Stop now: the running turn stops; the queued one stays for Resume.
  assert.equal(
    (
      runCommand(h.store, {
        action: "pause",
        scope: "project",
        id: h.project.id,
        mode: "now",
      }) as { stopped: number }
    ).stopped,
    1,
  );
  await h.ended(running);
  assert.equal(h.store.turn(running)!.status, "stopped");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(h.store.turn(held)!.status, "queued");
  assert.match(
    projectView(h.store, h.project.id)!.project.pauseReason!,
    /Stopped by the owner/,
  );
  // Everything: paused until Resume all.
  runCommand(h.store, { action: "pause", scope: "all" });
  assert.equal(
    workerView(h.store, Date.now()).pausedAll,
    "Paused by the owner.",
  );
  runCommand(h.store, { action: "resume", scope: "project", id: h.project.id });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(h.store.turn(held)!.status, "queued");
  runCommand(h.store, { action: "resume", scope: "all" });
  await h.ended(held);
  assert.equal(h.store.turn(held)!.status, "done");
  assert.equal(needsView(h.store).paused.length, 0);
});

test("Codex uses the team tools (its elicitation is accepted) and gets the answer", async (t) => {
  const h = await harness(t, {}, false, { codex: { account: "chatgpt" } });
  await h.worker.start();
  const coder = h.codexAgent("Coder");
  const reviewer = h.agent("Reviewer", "look");
  await h.ready(coder.id, reviewer.id);
  await h.ended(h.send(coder.id, "team_ask Reviewer check my work"));
  assert.match(h.said(coder.id).at(-1)!, /^team_ask: Asked Reviewer/);
  await h.until(
    () =>
      h
        .said(coder.id)
        .some((s) => s.startsWith("echo: Messages from your team")),
    "answer reached Codex",
  );
  assert.ok(
    h
      .codexCalls()
      .some(
        (c) =>
          c.method === "turn/start" &&
          JSON.stringify(c.params).includes("the answer to your ask"),
      ),
  );
  // The Console's own server waits a day for a tool call (Needs you).
  const start = h.codexCalls().find((c) => c.method === "thread/start")!;
  assert.equal(
    (
      start.params.config as {
        mcp_servers: { console: { tool_timeout_sec: number } };
      }
    ).mcp_servers.console.tool_timeout_sec,
    86_400,
  );
});

test("a Look only reviewer is shown each finished commit of its tab, detached; team_push needs GitHub", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  const reviewer = h.agent("Reviewer", "look");
  await h.ready(lead.id, reviewer.id);
  const turn = h.send(lead.id, "write notes.txt");
  await h.ended(turn);
  await h.until(() => !!h.store.turn(turn)!.commitAfter, "committed");
  const sha = h.store.turn(turn)!.commitAfter!;
  const folder = h.store.agent(reviewer.id)!.folder;
  await h.until(
    () => git(folder, "rev-parse", "HEAD") === sha,
    "reviewer refreshed",
  );
  assert.equal(git(folder, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
  assert.ok(existsSync(join(folder, "notes.txt")));
  await h.until(
    () =>
      transcript(h.events(reviewer.id)).some(
        (b) => b.type === "note" && b.text.includes(sha.slice(0, 8)),
      ),
    "noted",
  );
  // Its next turn starts from that commit.
  const look = h.send(reviewer.id, "hello");
  await h.ended(look);
  assert.equal(h.store.turn(look)!.commitBefore, sha);
  // A project without GitHub keeps its work on the Mac.
  await h.ended(h.send(lead.id, "team_push"));
  assert.match(
    h.said(lead.id).at(-1)!,
    /error: Only a GitHub project's agents push branches/,
  );
});
