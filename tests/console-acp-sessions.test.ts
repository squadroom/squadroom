import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentKind } from "../src/lib/console/agents.ts";
import { ACP_CLIENTS } from "../src/lib/console/clients.ts";
import { needsFreshCode, runCommand } from "../src/lib/console/commands.ts";
import { Launcher } from "../src/lib/console/launcher.ts";
import { chargeTurn } from "../src/lib/console/spend.ts";
import { harness, TOKEN } from "./helpers/console-harness.ts";
import { acp, CAP, HELLO_USAGE, keys, LUNA, OPENAI, prompted, resumeAfterStop, said } from "./helpers/acp-harness.ts";

// The first ACP client (OpenCode) through the conformance
// matrix the review asks of every driver: its start,
// usage (delayed, repeated, missing), partial owner waits, credential mode,
// model confirmation, cancellation, a resumed session and a restart. Against
// a scripted fake agent (fake-acp.mjs): no sudo, no network, no model call.
// OpenCode runs at Code edit or Code analysis.

test("OpenCode is offered at Code edit and Code analysis; at Code edit an edit in its folder is committed, one outside it refused", async (t) => {
  const h = await acp(t);
  // The owner's commands make it at either level.
  h.agent("Scout2", "look", "openai/gpt-5.6-luna", "opencode");
  h.agent("Editor2", "edit", "openai/gpt-5.6-luna", "opencode");
  assert.equal(agentKind("opencode")!.offered, true);
  assert.equal(agentKind("opencode")!.version, ACP_CLIENTS.opencode.version);
  const editor = h.acpAgent("Editor", "openai/gpt-5.6-luna", "edit");
  await h.ready(editor.id);
  const folder = h.store.agent(editor.id)!.folder;
  const turn = h.send(editor.id, `edit ${join(folder, "notes.txt")}`);
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "done", h.store.turn(turn)!.reason ?? "");
  assert.match(said(h, editor.id), /decision: yes/);
  assert.match(h.log(), /^sandbox --sandbox edit$/m);
  await h.until(() => !!h.store.turn(turn)!.commitAfter, "turn committed");
  assert.equal(execFileSync("git", ["-C", folder, "show", "HEAD:notes.txt"], { encoding: "utf8" }), "edited\n");
  const outside = join(h.root, "outside.txt");
  await h.ended(h.send(editor.id, `edit ${outside}`));
  assert.match(said(h, editor.id), /decision: no/);
  assert.equal(existsSync(outside), false);
});

test("a turn end to end: sandboxed at Code analysis, network off, the model confirmed, only its key crosses, streamed, charged at catalog prices", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const turn = h.send(scout.id, "hello");
  await h.ended(turn);
  const row = h.store.turn(turn)!;
  assert.equal(row.status, "done", row.reason ?? "");
  assert.match(said(h, scout.id), /Hello from the fake agent\. Done\./);
  assert.deepEqual(row.usage, HELLO_USAGE);
  assert.equal(row.costBasis, "reported");
  assert.equal(row.costUsd, chargeTurn(LUNA, HELLO_USAGE)!.usd);
  assert.ok(row.costUsd! > 0);
  // The launcher's sandbox profile: Code analysis, no network, the Console's port.
  assert.match(h.log(), /^sandbox --sandbox look$/m);
  assert.match(h.log(), /^sandbox --net off$/m);
  assert.match(h.log(), /^sandbox --port \d+$/m);
  // The tool call and the plan reached the window and the task list.
  assert.ok(h.events(scout.id).some((e) => e.kind === "tool" && (e.body as { summary: string }).summary === "Read README.md"));
  // The session id was kept for resume, the model was the one asked for.
  assert.match(h.store.session(scout.id) ?? "", /^ses_/);
  assert.ok(!h.acpCalls().some((c) => c.method === "session/set_model"));
  // Credential mode: only the selected key crossed, and it is redacted.
  const env = h.send(scout.id, "env");
  await h.ended(env);
  assert.match(said(h, scout.id), /env: OPENAI_API_KEY(?!,)/);
  assert.ok(!JSON.stringify(h.events(scout.id)).includes(OPENAI));
});

test("a program that ends at once shows its stderr, redacted; OpenCode with network off says to turn it on", async (t) => {
  const h = await acp(t);
  // A client that ends at once: its stderr's tail is the reason, the key
  // it was given and any other key shape masked, colour codes dropped.
  writeFileSync(join(h.agentHome, "fake-acp.json"), JSON.stringify({ crash: `\x1b[91mError:\x1b[0m boot ${OPENAI} sk-other-shaped-key-000000000000\n${"x".repeat(400)}\nServeError\n` }));
  const crashed = h.acpAgent("Crashed");
  await h.ready(crashed.id);
  const turn = h.send(crashed.id, "hello");
  await h.ended(turn);
  const reason = h.store.turn(turn)!.reason!;
  assert.match(reason, /^OpenCode ended unexpectedly \(exit 1\): …x+ ServeError OpenCode needs Network on for this project \(the project's menu, Network…\)\.$/);
  assert.ok(reason.length < 500, reason);
  const short = h.acpAgent("Short");
  writeFileSync(join(h.agentHome, "fake-acp.json"), JSON.stringify({ crash: `Error: boot ${OPENAI} sk-other-shaped-key-000000000000\n` }));
  await h.ready(short.id);
  const second = h.send(short.id, "hello");
  await h.ended(second);
  const told = h.store.turn(second)!.reason!;
  assert.match(told, /^OpenCode ended unexpectedly \(exit 1\): Error: boot \[redacted …ABCD\] \[redacted …0000\] OpenCode needs/);
  assert.ok(!JSON.stringify(h.events(short.id)).includes(OPENAI));
});

test("model confirmation: a session on another model switches to it; one that cannot is refused before any paid request", async (t) => {
  const h = await acp(t, { models: { current: "openai/gpt-6-luna", available: ["openai/gpt-6-luna", "openai/gpt-5.6-luna"] } });
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const ok = h.send(scout.id, "hello");
  await h.ended(ok);
  assert.equal(h.store.turn(ok)!.status, "done", h.store.turn(ok)!.reason ?? "");
  assert.ok(h.acpCalls().some((c) => c.method === "session/set_model" && c.params?.modelId === "openai/gpt-5.6-luna"));
  // Not offered at all: refused, nothing prompted, nothing charged.
  writeFileSync(join(h.agentHome, "fake-acp.json"), JSON.stringify({ models: { current: "openai/gpt-6-luna", available: ["openai/gpt-6-luna"] } }));
  const other = h.acpAgent("Other");
  await h.ready(other.id);
  const refused = h.send(other.id, "hello");
  await h.ended(refused);
  assert.equal(h.store.turn(refused)!.status, "failed");
  assert.match(h.store.turn(refused)!.reason!, /did not offer openai\/gpt-5\.6-luna/);
  assert.equal(h.store.turn(refused)!.costUsd, null);
  assert.ok(!h.acpCalls().some((c) => c.method === "session/prompt" && c.cwd === h.store.agent(other.id)!.folder));
  // A session that reports no model at all cannot be confirmed either.
  writeFileSync(join(h.agentHome, "fake-acp.json"), JSON.stringify({ models: null }));
  const silent = h.acpAgent("Silent");
  await h.ready(silent.id);
  const none = h.send(silent.id, "hello");
  await h.ended(none);
  assert.equal(h.store.turn(none)!.status, "failed");
});

test("credential mode: an agent that asks to sign in is refused, never logged in; a paid key without a cap never crosses", async (t) => {
  const h = await acp(t, { authRequired: true });
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const turn = h.send(scout.id, "hello");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "failed");
  assert.match(h.store.turn(turn)!.reason!, /asked to sign in/);
  assert.ok(!h.acpCalls().some((c) => c.method === "authenticate"));
  // The key without its provider-side cap: refused before any process starts.
  writeFileSync(join(h.agentHome, "fake-acp.json"), "{}");
  writeFileSync(h.keysFile, JSON.stringify({ keys: { OPENAI_API_KEY: { value: OPENAI } }, projects: {} }), { mode: 0o600 });
  const spawned = h.acpCalls().length;
  const capless = h.send(scout.id, "hello");
  await h.ended(capless);
  assert.match(h.store.turn(capless)!.reason!, /no provider-side monthly cap/);
  assert.equal(h.acpCalls().length, spawned);
});

test("usage: repeated context updates are not usage; a late update is not the next turn's; missing or contradictory usage is charged in full and pauses the tab", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const repeat = h.send(scout.id, "repeat");
  await h.ended(repeat);
  assert.deepEqual(h.store.turn(repeat)!.usage, HELLO_USAGE);
  const late = h.send(scout.id, "late");
  await h.ended(late);
  await new Promise((r) => setTimeout(r, 150));
  const next = h.send(scout.id, "hello");
  await h.ended(next);
  assert.deepEqual(h.store.turn(next)!.usage, HELLO_USAGE);
  assert.ok(!said(h, scout.id).includes("LATE TEXT"));
  assert.equal(h.store.tab(h.tab.id)!.paused, false);
  // No usage at all: the full allowance, and the tab waits for the owner.
  const missing = h.send(scout.id, "nousage");
  await h.ended(missing);
  const row = h.store.turn(missing)!;
  assert.equal(row.status, "done");
  assert.equal(row.costBasis, "allowance");
  assert.equal(row.costUsd, chargeTurn(LUNA, null)!.usd);
  assert.ok(row.costUsd! > chargeTurn(LUNA, HELLO_USAGE)!.usd * 100);
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Usage not reported: /);
  const waiting = h.send(scout.id, "badusage");
  await h.passes();
  assert.equal(h.store.turn(waiting)!.status, "queued");
  // Resume lets it run; usage that does not add up is charged the same way.
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.ended(waiting);
  assert.equal(h.store.turn(waiting)!.costBasis, "allowance");
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Usage not reported: /);
});

test("partial owner waits for ACP: one of two parallel requests answered keeps the whole turn waiting", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const turn = h.send(scout.id, "ask2");
  await h.until(() => h.store.openRequests().filter((r) => r.agentId === scout.id).length === 2, "two requests");
  const [first, second] = h.store.openRequests().filter((r) => r.agentId === scout.id);
  runCommand(h.store, { action: "decide", requestId: first.id, decision: "allow" });
  await h.until(() => existsSync(join(h.store.agent(scout.id)!.folder, "parallel-resumed")), "first branch resumed");
  assert.equal(h.store.turn(turn)!.status, "waiting_for_owner");
  runCommand(h.store, { action: "decide", requestId: second.id, decision: "deny" });
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "done");
  // Allow once and reject once: never a standing grant for the agent.
  assert.match(said(h, scout.id), /decision: yes,no/);
});

test("cancellation: Stop cancels the session and answers a waiting request 'cancelled'; an agent that ignores it is ended", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const hang = h.send(scout.id, "hang");
  await prompted(h, 1);
  runCommand(h.store, { action: "stop", agentId: scout.id });
  await h.ended(hang);
  assert.deepEqual([h.store.turn(hang)!.status, h.store.turn(hang)!.reason], ["stopped", "Stopped by the owner."]);
  assert.ok(h.acpCalls().some((c) => c.method === "session/cancel"));
  resumeAfterStop(h, hang);
  const asking = h.send(scout.id, "askhang");
  await h.until(() => h.store.openRequests().some((r) => r.agentId === scout.id), "a request");
  runCommand(h.store, { action: "stop", agentId: scout.id });
  await h.ended(asking);
  assert.ok(h.acpCalls().some((c) => c.result && JSON.stringify(c.result).includes('"cancelled"')));
  // It may have ended normally after its ask was answered (then nothing
  // pauses); otherwise the tab waits for a Resume.
  if (h.store.tab(h.tab.id)!.paused) resumeAfterStop(h, asking);
  const deaf = h.send(scout.id, "deaf");
  await prompted(h, 3);
  runCommand(h.store, { action: "stop", agentId: scout.id });
  await h.ended(deaf);
  assert.equal(h.store.turn(deaf)!.status, "stopped");
  assert.match(h.log(), /^signal TERM \d+$/m);
});

test("an unknown start: a prompt whose write failed with the program alive is contained, ended and charged; the next turn starts a new program", async (t) => {
  // The prompt's write fails while the program lives on: whether it read
  // the request cannot be known. Every later program writes normally.
  let failed = false;
  class FlakyInput extends Launcher {
    spawn(...args: Parameters<Launcher["spawn"]>) {
      const child = super.spawn(...args);
      if (args[1].endsWith("opencode") && !failed) {
        const write = child.stdin.write.bind(child.stdin) as (chunk: string, cb?: (e?: Error | null) => void) => boolean;
        (child.stdin as unknown as { write: typeof write }).write = (chunk, cb) => {
          if (String(chunk).includes('"session/prompt"')) {
            failed = true;
            queueMicrotask(() => cb?.(new Error("EPIPE")));
            return false;
          }
          return write(chunk, cb);
        };
      }
      return child;
    }
  }
  const h = await harness(t, {}, false, { acp: {}, launcher: (l) => new FlakyInput(l.config) });
  keys(h.keysFile);
  await h.worker.start();
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const turn = h.send(scout.id, "hello");
  const next = h.send(scout.id, "hello");
  await h.until(() => h.events(scout.id).some((e) => e.turnId === turn && e.kind === "error" && /did not acknowledge/.test((e.body as { text: string }).text)), "contained");
  // Stopping, not failed: the window stays occupied and the next turn waits.
  assert.equal(h.store.turn(turn)!.status, "running");
  assert.equal(h.store.turn(next)!.status, "queued");
  await h.ended(turn);
  assert.deepEqual([h.store.turn(turn)!.status, h.store.turn(turn)!.reason], ["interrupted", "OpenCode did not acknowledge the start."]);
  assert.match(h.log(), /^signal (TERM|KILL) \d+$/m);
  // Not a free attempt: the full allowance, and the tab waits for the owner.
  assert.equal(h.store.turn(turn)!.costBasis, "allowance");
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Usage not reported: /);
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.ended(next);
  assert.equal(h.store.turn(next)!.status, "done", h.store.turn(next)!.reason ?? "");
  assert.ok(h.store.turn(next)!.startedAt! >= h.store.turn(turn)!.endedAt!);
  const pids = new Set(h.acpCalls().filter((c) => c.method === "initialize").map((c) => c.pid));
  assert.equal(pids.size, 2);
});

test("a refusal and an error: either way the turn fails, and a prompt that reached the agent is charged", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const refused = h.send(scout.id, "refuse");
  await h.ended(refused);
  assert.equal(h.store.turn(refused)!.status, "failed");
  assert.match(h.store.turn(refused)!.reason!, /the model is not available/);
  assert.equal(h.store.turn(refused)!.costBasis, "allowance");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  const error = h.send(scout.id, "error");
  await h.ended(error);
  assert.match(h.store.turn(error)!.reason!, /provider error/);
  assert.match(said(h, scout.id), /Trying\./);
});

test("a request the provider turns away as unauthorized before the agent says anything costs nothing; after it has, the allowance", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const forbidden = h.send(scout.id, "forbidden");
  await h.ended(forbidden);
  assert.equal(h.store.turn(forbidden)!.status, "failed");
  assert.match(h.store.turn(forbidden)!.reason!, /blocked/);
  assert.equal(h.store.turn(forbidden)!.costBasis, "reported");
  assert.equal(h.store.turn(forbidden)!.costUsd, 0);
  assert.equal(h.store.tab(h.tab.id)!.pauseReason, null);
  const late = h.send(scout.id, "lateforbidden");
  await h.ended(late);
  assert.equal(h.store.turn(late)!.costBasis, "allowance");
});

test("a resumed session and a restart: a new program loads the saved session, its replayed history is not shown again", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const first = h.send(scout.id, "hello");
  await h.ended(first);
  const saved = h.store.session(scout.id);
  // A restart in the middle of a turn: interrupted, never replayed.
  const hang = h.send(scout.id, "hang");
  await prompted(h, 2);
  await h.worker.stop();
  assert.equal(h.store.turn(hang)!.status, "interrupted");
  // Its prompt reached the agent and no usage came back: charged in full,
  // and the tab waits for the owner.
  assert.equal(h.store.turn(hang)!.costBasis, "allowance");
  assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Usage not reported: /);
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  const next = h.newWorker();
  await next.start();
  const after = h.send(scout.id, "hello");
  await h.ended(after);
  assert.equal(h.store.turn(after)!.status, "done", h.store.turn(after)!.reason ?? "");
  const loads = h.acpCalls().filter((c) => c.method === "session/load");
  assert.equal(loads.at(-1)?.params?.sessionId, saved);
  assert.ok(!said(h, scout.id).includes("REPLAYED HISTORY"));
  // An agent that cannot load sessions starts a new one instead.
  writeFileSync(join(h.agentHome, "fake-acp.json"), JSON.stringify({ loadSession: false }));
  runCommand(h.store, { action: "fresh", agentId: scout.id });
  const fresh = h.send(scout.id, "hello");
  await h.ended(fresh);
  assert.equal(h.store.turn(fresh)!.status, "done");
});

test("the project's network switch: behind a fresh code, waits for running ACP turns, restarts the sessions, then shows as changed", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  assert.equal(h.store.project(h.project.id)!.acpNetwork, false);
  assert.equal(needsFreshCode({ action: "setAcpNetwork", projectId: h.project.id, on: true }), true);
  const hang = h.send(scout.id, "hang");
  await prompted(h, 1);
  runCommand(h.store, { action: "setAcpNetwork", projectId: h.project.id, on: true });
  await h.passes();
  // Still off while the ACP turn runs; a queued one waits.
  assert.deepEqual([h.store.project(h.project.id)!.acpNetwork, h.store.project(h.project.id)!.acpNetworkPending], [false, true]);
  const queued = h.send(scout.id, "hello");
  await h.passes();
  assert.equal(h.store.turn(queued)!.status, "queued");
  // Stop now: the running turn is stopped, the session restarts, then on.
  runCommand(h.store, { action: "setAcpNetwork", projectId: h.project.id, on: true, mode: "now" });
  await h.ended(hang);
  resumeAfterStop(h, hang);
  await h.until(() => h.store.project(h.project.id)!.acpNetwork, "network on");
  assert.equal(h.store.project(h.project.id)!.acpNetworkPending, null);
  await h.ended(queued);
  assert.match(h.log(), /^sandbox --net on$/m);
  assert.equal(new Set(h.acpCalls().filter((c) => c.method === "initialize").map((c) => c.pid)).size, 2);
});

test("a new clone in the project waits for its ACP turns; the session then restarts with the new teammate denied", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const hang = h.send(scout.id, "hang");
  await prompted(h, 1);
  const mate = h.agent("Mate");
  await h.passes();
  assert.equal(h.store.agent(mate.id)!.state, "creating");
  runCommand(h.store, { action: "stop", agentId: scout.id });
  await h.ended(hang);
  resumeAfterStop(h, hang);
  await h.ready(mate.id);
  const after = h.send(scout.id, "hello");
  await h.ended(after);
  const folder = h.store.agent(mate.id)!.folder;
  assert.ok(h.log().split("\n").includes(`sandbox --deny ${folder}`));
  assert.equal(new Set(h.acpCalls().filter((c) => c.method === "initialize").map((c) => c.pid)).size, 2);
});

test("an idle ACP program of the project is ended before a new clone is made, and restarts with it denied", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  await h.ended(h.send(scout.id, "hello"));
  const first = h.acpCalls().find((c) => c.method === "initialize")!.pid;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive(first), "idle, still running");
  const mate = h.agent("Mate", "look");
  await h.ready(mate.id);
  // By the time the clone exists, the idle program that did not know it is gone.
  assert.equal(alive(first), false);
  await h.ended(h.send(scout.id, "hello"));
  assert.ok(h.log().split("\n").includes(`sandbox --deny ${h.store.agent(mate.id)!.folder}`));
});

test("a changed key gives the window a new program: its requests never count against another key's login", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  await h.ended(h.send(scout.id, "env"));
  // The owner gives the project a key of its own between turns.
  const OWN = "sk-proj-FAKE-project-own-key-33333333333333";
  writeFileSync(
    h.keysFile,
    JSON.stringify({ keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN }, OPENAI_API_KEY: { value: OPENAI, cap: CAP } }, projects: { [h.project.id]: { OPENAI_API_KEY: { value: OWN, cap: CAP } } } }),
    { mode: 0o600 },
  );
  const turn = h.send(scout.id, "env");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "done", h.store.turn(turn)!.reason ?? "");
  assert.equal(new Set(h.acpCalls().filter((c) => c.method === "initialize").map((c) => c.pid)).size, 2);
  assert.ok(!JSON.stringify(h.events(scout.id)).includes(OWN));
});

test("a new ACP conversation opens with the window's instructions; a loaded one is not told again", async (t) => {
  const h = await acp(t);
  const scout = h.acpAgent();
  await h.ready(scout.id);
  await h.ended(h.send(scout.id, "hello"));
  await h.ended(h.send(scout.id, "hello"));
  const prompts = h.acpCalls().filter((c) => c.method === "session/prompt").map((c) => JSON.stringify(c.params?.prompt));
  assert.match(prompts[0], /Your instructions for this conversation/);
  assert.match(prompts[0], /You are \\"Scout\\"/);
  assert.doesNotMatch(prompts[1], /Your instructions for this conversation/);
});

test("a program whose setup failed is unusable at once: the next turn starts a new one, even while the old one is still ending", async (t) => {
  const h = await acp(t, { badProtocolOnce: true, ignoreTerm: true });
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const first = h.send(scout.id, "hello");
  const second = h.send(scout.id, "hello");
  await h.ended(first);
  assert.match(h.store.turn(first)!.reason!, /speaks ACP version 2/);
  await h.ended(second);
  assert.equal(h.store.turn(second)!.status, "done", h.store.turn(second)!.reason ?? "");
  assert.equal(new Set(h.acpCalls().filter((c) => c.method === "initialize").map((c) => c.pid)).size, 2);
});

test("a paid prompt is recorded as prompted before it is written, so no crash after that point leaves it uncharged", async (t) => {
  // The prompt's write never completes: neither its callback nor the agent
  // says anything, as when the worker dies at that moment.
  class Swallow extends Launcher {
    spawn(...args: Parameters<Launcher["spawn"]>) {
      const child = super.spawn(...args);
      if (args[1].endsWith("opencode")) {
        const write = child.stdin.write.bind(child.stdin) as (chunk: string, cb?: (e?: Error | null) => void) => boolean;
        (child.stdin as unknown as { write: typeof write }).write = (chunk, cb) => (String(chunk).includes('"session/prompt"') ? true : write(chunk, cb));
      }
      return child;
    }
  }
  const h = await harness(t, {}, false, { acp: {}, launcher: (l) => new Swallow(l.config) });
  keys(h.keysFile);
  await h.worker.start();
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const turn = h.send(scout.id, "hello");
  await h.until(() => h.store.get("SELECT prompted FROM console_turns WHERE id = ?", turn)?.prompted === 1, "recorded as prompted");
  assert.equal(h.store.turn(turn)!.status, "running");
});

test("a new conversation whose instructed first prompt never reached the agent is not resumed: the next one is new and told again", async (t) => {
  let failed = false;
  class FailFirstPrompt extends Launcher {
    spawn(...args: Parameters<Launcher["spawn"]>) {
      const child = super.spawn(...args);
      if (args[1].endsWith("opencode") && !failed) {
        const write = child.stdin.write.bind(child.stdin) as (chunk: string, cb?: (e?: Error | null) => void) => boolean;
        (child.stdin as unknown as { write: typeof write }).write = (chunk, cb) => {
          if (String(chunk).includes('"session/prompt"')) {
            failed = true;
            queueMicrotask(() => cb?.(new Error("EPIPE")));
            return false;
          }
          return write(chunk, cb);
        };
      }
      return child;
    }
  }
  const h = await harness(t, {}, false, { acp: {}, launcher: (l) => new FailFirstPrompt(l.config) });
  keys(h.keysFile);
  await h.worker.start();
  const scout = h.acpAgent();
  await h.ready(scout.id);
  const first = h.send(scout.id, "hello");
  await h.ended(first);
  assert.equal(h.store.session(scout.id), null, "the uninstructed conversation was not kept");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.ended(h.send(scout.id, "hello"));
  assert.ok(!h.acpCalls().some((c) => c.method === "session/load"));
  const prompts = h.acpCalls().filter((c) => c.method === "session/prompt").map((c) => JSON.stringify(c.params?.prompt));
  assert.match(prompts.at(-1)!, /Your instructions for this conversation/);
});

test("a key file that exists but cannot be read whole stops the worker's start", async (t) => {
  const h = await harness(t);
  writeFileSync(h.keysFile, JSON.stringify({ keys: { OPENAI_API_KEY: { value: OPENAI, cap: { usd: "ten" } } }, projects: {} }), { mode: 0o600 });
  await assert.rejects(h.worker.start(), /cap without usd/);
  assert.doesNotMatch(h.log(), /^sweep$/m);
});
