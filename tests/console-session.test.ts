import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { runCommand } from "../src/lib/console/commands.ts";
import type { AgentDriver, AgentSession, DriverHost, PromptResult, SessionContext, TurnRequest } from "../src/lib/console/session.ts";
import { GIT_TOKEN, harness, TOKEN } from "./helpers/console-harness.ts";

// The driver seam: a third driver, in the test, runs
// turns through the worker's scheduler, limits, store and Needs you without
// the worker knowing which client it is. An unknown start and a
// shared process ended for one window are its conformance cases here;
// parallel requests are tests/console-lifecycle's and tests/console-acp's.

const CAP = { usd: 10, url: "https://platform.openai.com/settings/organization/limits", checkedAt: "2026-10-20" };

/** A driver whose sessions share one "process", scripted by prompt. */
class StubDriver implements AgentDriver {
  readonly label = "Stub";
  readonly ownProcess = false;
  readonly permissionTool = false;
  readonly folderScope = null;
  readonly stopMs = { grace: 200, force: 0, violation: 0 };
  sessions = new Set<StubSession>();
  terminated: string[] = [];
  /** Run just before a prompt is handed over; the turns actually sent. */
  beforeSend: (() => void) | null = null;
  sent: number[] = [];
  opened = 0;
  shut = false;
  host: DriverHost;
  constructor(host: DriverHost) {
    this.host = host;
  }
  open(ctx: SessionContext): AgentSession {
    this.opened++;
    const s = new StubSession(this, ctx);
    this.sessions.add(s);
    return s;
  }
  refusal() {
    return null;
  }
  waiting() {
    return false;
  }
  retiring() {
    return 0;
  }
  usesFolder() {
    return false;
  }
  tick() {}
  async shutdown() {
    this.shut = true;
  }
}
class StubSession implements AgentSession {
  exited = false;
  turn: TurnRequest | null = null;
  driver: StubDriver;
  ctx: SessionContext;
  constructor(driver: StubDriver, ctx: SessionContext) {
    this.driver = driver;
    this.ctx = ctx;
  }
  stale() {
    return false;
  }
  async prompt(turn: TurnRequest): Promise<PromptResult> {
    this.turn = turn;
    const emit = this.ctx.emit;
    emit({ kind: "validated", sessionId: `stub-${this.ctx.agent.id}` });
    const word = turn.text.trim().split(/\s+/)[0];
    if (word === "unknown") return { outcome: "unknown" };
    if (word === "refuse") return { outcome: "refused", reason: "Stub refused." };
    this.driver.beforeSend?.();
    turn.sending();
    this.driver.sent.push(turn.id);
    turn.delivered();
    // The turn's end reported before prompt() returns (as a replayed early
    // completion is): still a paid turn.
    if (word === "instant") {
      emit({ kind: "usage", usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 } });
      emit({ kind: "completed", outcome: "done", error: null });
    }
    if (word === "hello")
      setTimeout(() => {
        emit({ kind: "delta", stream: "text", text: "Hi from the stub." });
        emit({ kind: "message", stream: "text", text: "Hi from the stub." });
        emit({ kind: "tool", id: "x1", name: "read", summary: "a file" });
        emit({ kind: "tool_result", id: "x1", text: "ok", error: false });
        emit({ kind: "usage", usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 } });
        emit({ kind: "completed", outcome: "done", error: null });
      }, 30);
    return { outcome: "started" };
  }
  interrupt() {}
  /** The shared process ends: every other session with a turn is told. */
  async terminate(reason: string) {
    this.driver.terminated.push(this.ctx.agent.id);
    const collateral = [...this.driver.sessions].filter((s) => s !== this && s.turn).map((s) => s.ctx.agent.id);
    for (const s of this.driver.sessions) {
      s.exited = true;
      if (!s.turn) continue;
      s.ctx.emit(
        s === this
          ? { kind: "ended", status: "failed", reason: "The stub ended." }
          : { kind: "ended", status: "interrupted", reason: `Interrupted: the stub was ended to stop ${this.ctx.agent.name}'s turn (${reason}).` },
      );
    }
    this.driver.sessions.clear();
    return { contained: true, collateral };
  }
  endTurn() {
    this.turn = null;
  }
  close() {
    this.exited = true;
    this.driver.sessions.delete(this);
  }
}

async function stubbed(t: Parameters<typeof harness>[0]) {
  let driver!: StubDriver;
  const h = await harness(t, {}, false, {
    drivers: (host) => ({ opencode: (driver = new StubDriver(host)) }),
  });
  writeFileSync(
    h.keysFile,
    JSON.stringify({ keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN }, CONSOLE_GIT_TOKEN: { value: GIT_TOKEN }, OPENAI_API_KEY: { value: "sk-proj-FAKE-stub-key-000000000000000000", cap: CAP } }, projects: {} }),
    { mode: 0o600 },
  );
  await h.worker.start();
  return { h, driver: () => driver };
}

test("a stub third driver runs a turn end to end through the scheduler: validated, streamed, its usage kept and charged", async (t) => {
  const { h, driver } = await stubbed(t);
  const a = h.acpAgent("A");
  await h.ready(a.id);
  const turn = h.send(a.id, "hello");
  await h.ended(turn);
  const row = h.store.turn(turn)!;
  assert.equal(row.status, "done", row.reason ?? "");
  assert.deepEqual(h.said(a.id), ["Hi from the stub."]);
  assert.ok(h.events(a.id).some((e) => e.kind === "tool_result"));
  assert.deepEqual(row.usage, { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 });
  assert.equal(row.costBasis, "reported");
  assert.equal(h.store.session(a.id), `stub-${a.id}`);
  assert.equal(driver().opened, 1);
  // A refusal fails the turn and nothing was sent, so nothing is charged.
  const refused = h.send(a.id, "refuse");
  await h.ended(refused);
  assert.deepEqual([h.store.turn(refused)!.status, h.store.turn(refused)!.reason], ["failed", "Stub refused."]);
  assert.equal(h.store.turn(refused)!.costUsd, null);
  const instant = h.send(a.id, "instant");
  await h.ended(instant);
  assert.equal(h.store.turn(instant)!.status, "done");
  assert.equal(h.store.turn(instant)!.costBasis, "reported");
  assert.ok(h.store.turn(instant)!.costUsd! > 0);
  await h.worker.stop();
  assert.equal(driver().shut, true);
});

test("an unknown start is contained (the window occupied, the next turn waiting) until terminate confirms it", async (t) => {
  const { h, driver } = await stubbed(t);
  const a = h.acpAgent("A");
  await h.ready(a.id);
  const turn = h.send(a.id, "unknown");
  const next = h.send(a.id, "hello");
  await h.until(() => h.events(a.id).some((e) => e.turnId === turn && e.kind === "error" && /Stub did not acknowledge/.test((e.body as { text: string }).text)), "contained");
  assert.equal(h.store.turn(turn)!.status, "running");
  assert.equal(h.store.turn(next)!.status, "queued");
  await h.ended(turn);
  assert.deepEqual([h.store.turn(turn)!.status, h.store.turn(turn)!.reason], ["interrupted", "Stub did not acknowledge the start."]);
  assert.deepEqual(driver().terminated, [a.id]);
  // Its prompt may have run: charged in full, and the tab waits for the owner.
  assert.equal(h.store.turn(turn)!.costBasis, "allowance");
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.ended(next);
  assert.equal(h.store.turn(next)!.status, "done");
  assert.equal(driver().opened, 2, "a new session after the terminated one");
});

test("ending a shared process for one window interrupts the others' turns, naming the window, for a Re-send", async (t) => {
  const { h, driver } = await stubbed(t);
  const a = h.acpAgent("A");
  const b = h.acpAgent("B");
  await h.ready(a.id, b.id);
  const stuck = h.send(a.id, "wait");
  const other = h.send(b.id, "wait");
  await h.until(() => [stuck, other].every((id) => h.store.turn(id)!.status === "running"), "both running", 30_000);
  // Both prompts handed to the shared process (not a fixed pause), so the
  // other window's session holds a turn when the process is ended.
  await h.until(() => [stuck, other].every((id) => driver().sent.includes(id)), "both prompts delivered", 30_000);
  runCommand(h.store, { action: "stop", agentId: a.id, force: true });
  await h.until(() => ![h.store.turn(stuck)!, h.store.turn(other)!].some((x) => ["queued", "running", "waiting_for_owner"].includes(x.status)), "both turns end", 30_000);
  assert.deepEqual([h.store.turn(stuck)!.status, h.store.turn(stuck)!.reason], ["stopped", "Force stopped by the owner."]);
  assert.equal(h.store.turn(other)!.status, "interrupted");
  assert.match(h.store.turn(other)!.reason!, /ended to stop A's turn \(Force stopped by the owner\.\)/);
  assert.ok(h.store.interruptedTurns().some((x) => x.id === other));
  assert.deepEqual(driver().terminated, [a.id]);
});

test("a prompt whose durable 'prompted' mark cannot be written is never handed to the client", async (t) => {
  const { h, driver } = await stubbed(t);
  let fatal: Error | null = null;
  h.worker.onFatal = (e) => (fatal = e);
  const a = h.acpAgent("A");
  await h.ready(a.id);
  // The lease is lost just before the paid request would go out.
  driver().beforeSend = () => {
    const epoch = h.store.lease()!.epoch;
    h.store.releaseLease(epoch);
    h.store.takeLease("other-worker", Date.now());
  };
  const turn = h.send(a.id, "hello");
  await h.until(() => fatal !== null, "the worker stops");
  assert.ok(!driver().sent.includes(turn), "nothing was sent");
});

test("team setup refuses an access level the chosen kind is not qualified for", async () => {
  const { checkTeamSetup } = await import("../src/lib/console/team-setup.ts");
  const { agentKind } = await import("../src/lib/console/agents.ts");
  const kind = agentKind("opencode")!;
  kind.offered = true;
  try {
    const result = checkTeamSetup(
      {
        orchestrated: false,
        members: [{ name: "Lead", kind: "opencode", model: "openai/gpt-5.6-luna", effort: "default", permission: "edit", roleId: "", prompt: "", note: "" }],
      },
      { roles: [], takenNames: [], codexOff: false },
    );
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result), /OpenCode is qualified for Look only so far/);
  } finally {
    kind.offered = false;
  }
});
