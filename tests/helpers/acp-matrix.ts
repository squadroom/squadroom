import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentKind, agentModel, type AgentKind } from "../../src/lib/console/agents.ts";
import { runCommand } from "../../src/lib/console/commands.ts";
import { Launcher } from "../../src/lib/console/launcher.ts";
import { chargeTurn } from "../../src/lib/console/spend.ts";
import { GIT_TOKEN, harness, TOKEN } from "./console-harness.ts";

// The ACP conformance matrix for one more
// ACP kind, as OpenCode passes it (tests/console-acp-sessions.test.ts):
// its own start command, an end-to-end turn, model confirmation, credential
// mode, usage (repeated, late, missing), partial owner waits, cancellation,
// an unknown start, a resumed session and a restart. Against the scripted
// fake agent (fake-acp.mjs): no sudo, no network, no model call. A paid kind
// is charged at catalog prices and in full without usage; a membership kind
// (its login in the agent account) is never charged and no key crosses.

export interface AcpVendor {
  kind: AgentKind;
  label: string;
  /** The model the session must confirm (its registry id). */
  model: string;
  /** Another model a session may start on (model confirmation). */
  other: string;
  /** The arguments that start its agent mode. */
  args: string[];
  /** It reports its model as a session config option (Kimi Code 2.x),
   * switched with session/set_config_option. */
  configOptions?: boolean;
  /** The authenticate method that selects the key in its environment
   * (Grok Build's `xai.api_key`). */
  keyAuth?: string;
  /** How it reports usage other than plain ACP: in session/prompt's
   * `_meta.usage` with xAI's meaning (Grok Build), or in its `usage` with
   * Gemini's meaning (Gemini CLI). */
  usage?: "xai" | "gemini";
  /** Offered in New agent and the team setup. */
  offered?: boolean;
  /** A paid kind's key, by its credential name; null for a membership. */
  key: { name: string; value: string; cap: { usd: number; url: string; checkedAt: string } } | null;
}

export function acpConformance(v: AcpVendor) {
  // Gemini reports no cache writes: the fake counts them as plain input.
  const HELLO_USAGE = { inputTokens: 1500, cacheReadTokens: 400, cacheWriteTokens: v.usage === "gemini" ? 0 : 100, outputTokens: 250 };
  const model = agentModel(v.kind, v.model)!;
  /** The fake agent's setup for this kind, with any test-specific parts. */
  const base = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ defaultModel: v.model, configOptions: !!v.configOptions, ...(v.keyAuth ? { keyAuth: v.keyAuth } : {}), ...(v.usage ? { usage: v.usage } : {}), ...extra });
  const paid = !!v.key;
  function keys(path: string, key: Record<string, unknown> | null = v.key ? { value: v.key.value, cap: v.key.cap } : null) {
    const extra = v.key && key ? { [v.key.name]: key } : {};
    writeFileSync(path, JSON.stringify({ keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN }, CONSOLE_GIT_TOKEN: { value: GIT_TOKEN }, ...extra }, projects: {} }), { mode: 0o600 });
  }
  async function acp(t: Parameters<typeof harness>[0], setup: Record<string, unknown> = {}, extra: Parameters<typeof harness>[3] = {}) {
    // The tab's spend limit is raised: a full allowance (Grok's is about $8)
    // would otherwise reach the $5 default and pause for spend, which the
    // OpenCode matrix tests on its own; this one checks the usage pause.
    const h = await harness(t, { tabSpendUsd: 1_000 }, false, { acp: JSON.parse(base(setup)), ...extra });
    keys(h.keysFile);
    await h.worker.start();
    return h;
  }
  type H = Awaited<ReturnType<typeof acp>>;
  const agent = (h: H, name = "Scout") => h.acpAgent(name, v.model, "look", v.kind);
  const said = (h: H, id: string) => h.said(id).join("");
  const prompted = (h: H, n: number) => h.until(() => h.acpCalls().filter((c) => c.method === "session/prompt").length >= n, `prompt ${n} reached the agent`);
  /** A turn whose prompt reached the agent without usage: a paid kind is
   * charged its full allowance and its tab waits; a membership is free. */
  function chargedInFull(h: H, turnId: number) {
    const row = h.store.turn(turnId)!;
    if (paid) {
      assert.equal(row.costBasis, "allowance");
      assert.equal(row.costUsd, chargeTurn(model, null, new Date(row.startedAt ?? Date.now()))!.usd);
      assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Usage not reported: /);
      runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
    } else {
      assert.equal(row.costUsd, null);
      assert.equal(h.store.tab(h.tab.id)!.paused, false);
    }
  }

  test(`${v.label}: ${v.offered ? "offered at Code edit and Code analysis" : "not offered"}; started with its own ACP command`, async (t) => {
    const kind = agentKind(v.kind)!;
    assert.deepEqual([kind.offered, kind.acpArgs], [!!v.offered, v.args]);
    assert.equal(!!model.paid, paid);
    if (v.key) assert.equal(model.paid!.credential, v.key.name);
    const h = await acp(t);
    // Not offered: New agent refuses it. Offered: at either level.
    if (v.offered) {
      h.agent("Offered", "look", v.model, v.kind);
      h.agent("Editor2", "edit", v.model, v.kind);
    } else assert.throws(() => h.agent("Scout", "look", v.model, v.kind), /Choose an agent/);
    const scout = agent(h);
    await h.ready(scout.id);
    await h.ended(h.send(scout.id, "hello"));
    assert.deepEqual(h.acpCalls().find((c) => c.method === "initialize")!.argv, v.args);
  });

  test(`${v.label}: at Code edit, sandboxed for edit; an edit in its folder is allowed and committed, one outside it refused`, async (t) => {
    const h = await acp(t);
    const editor = h.acpAgent("Editor", v.model, "edit", v.kind);
    await h.ready(editor.id);
    const folder = h.store.agent(editor.id)!.folder;
    const turn = h.send(editor.id, `edit ${join(folder, "notes.txt")}`);
    await h.ended(turn);
    assert.equal(h.store.turn(turn)!.status, "done", h.store.turn(turn)!.reason ?? "");
    assert.match(said(h, editor.id), /decision: yes/);
    assert.match(h.log(), /^sandbox --sandbox edit$/m);
    await h.until(() => !!h.store.turn(turn)!.commitAfter, "turn committed");
    assert.notEqual(h.store.turn(turn)!.commitAfter, h.store.turn(turn)!.commitBefore);
    assert.equal(execFileSync("git", ["-C", folder, "show", "HEAD:notes.txt"], { encoding: "utf8" }), "edited\n");
    // Outside its folder: refused without asking the owner, nothing written.
    const outside = join(h.root, "outside.txt");
    const out = h.send(editor.id, `edit ${outside}`);
    await h.ended(out);
    assert.match(said(h, editor.id), /decision: no/);
    assert.equal(existsSync(outside), false);
    // At Code analysis, even its own folder is refused.
    const scout = agent(h);
    await h.ready(scout.id);
    const own = join(h.store.agent(scout.id)!.folder, "look.txt");
    const look = h.send(scout.id, `edit ${own}`);
    await h.ended(look);
    assert.match(said(h, scout.id), /decision: no/);
    assert.equal(existsSync(own), false);
  });

  test(`${v.label}: a turn end to end, sandboxed at Look only, its model confirmed, only its own key crossing`, async (t) => {
    const h = await acp(t);
    const scout = agent(h);
    await h.ready(scout.id);
    const turn = h.send(scout.id, "hello");
    await h.ended(turn);
    const row = h.store.turn(turn)!;
    assert.equal(row.status, "done", row.reason ?? "");
    assert.match(said(h, scout.id), /Hello from the fake agent\. Done\./);
    assert.deepEqual(row.usage, HELLO_USAGE);
    if (paid) {
      assert.equal(row.costBasis, "reported");
      assert.equal(row.costUsd, chargeTurn(model, HELLO_USAGE, new Date(row.startedAt ?? Date.now()))!.usd);
      assert.ok(row.costUsd! > 0);
    } else assert.equal(row.costUsd, null);
    assert.match(h.log(), /^sandbox --sandbox look$/m);
    assert.match(h.log(), /^sandbox --net off$/m);
    // Only Kimi Code reads its membership login.
    if (v.kind === "kimi-code") assert.match(h.log(), /^sandbox --login kimi$/m);
    else assert.doesNotMatch(h.log(), /^sandbox --login/m);
    assert.ok(!h.acpCalls().some((c) => c.method === "session/set_model"));
    // A kind that must be told to use its key is told so, with that method only.
    const auths = h.acpCalls().filter((c) => c.method === "authenticate").map((c) => c.params?.methodId);
    if (v.keyAuth) assert.deepEqual([...new Set(auths)], [v.keyAuth]);
    else assert.deepEqual(auths, []);
    const env = h.send(scout.id, "env");
    await h.ended(env);
    // Only its own key (none for a membership); the owner's ambient key never.
    if (v.key) assert.match(said(h, scout.id), new RegExp(`env: ${v.key.name}(?!,)`));
    else assert.match(said(h, scout.id), /env: (?![A-Z])/);
    if (v.key) assert.ok(!JSON.stringify(h.events(scout.id)).includes(v.key.value));
  });

  test(`${v.label}: model confirmation, switched to when offered, refused before any prompt when not`, async (t) => {
    const h = await acp(t, { models: { current: v.other, available: [v.other, v.model] } });
    const scout = agent(h);
    await h.ready(scout.id);
    const ok = h.send(scout.id, "hello");
    await h.ended(ok);
    assert.equal(h.store.turn(ok)!.status, "done", h.store.turn(ok)!.reason ?? "");
    if (v.configOptions) assert.ok(h.acpCalls().some((c) => c.method === "session/set_config_option" && c.params?.configId === "model" && c.params?.value === v.model));
    else assert.ok(h.acpCalls().some((c) => c.method === "session/set_model" && c.params?.modelId === v.model));
    if (v.configOptions) {
      // A switch the agent answers without taking it is refused.
      writeFileSync(join(h.agentHome, "fake-acp.json"), base({ ignoreConfig: true, models: { current: v.other, available: [v.other, v.model] } }));
      const stuck = agent(h, "Stuck");
      await h.ready(stuck.id);
      const no = h.send(stuck.id, "hello");
      await h.ended(no);
      assert.equal(h.store.turn(no)!.status, "failed");
      assert.ok(h.store.turn(no)!.reason!.includes(`did not switch to ${v.model}`), h.store.turn(no)!.reason!);
    }
    writeFileSync(join(h.agentHome, "fake-acp.json"), base({ models: { current: v.other, available: [v.other] } }));
    const other = agent(h, "Other");
    await h.ready(other.id);
    const refused = h.send(other.id, "hello");
    await h.ended(refused);
    assert.equal(h.store.turn(refused)!.status, "failed");
    assert.ok(h.store.turn(refused)!.reason!.includes(`did not offer ${v.model}`), h.store.turn(refused)!.reason!);
    assert.equal(h.store.turn(refused)!.costUsd, null);
    assert.ok(!h.acpCalls().some((c) => c.method === "session/prompt" && c.cwd === h.store.agent(other.id)!.folder));
  });

  test(`${v.label}: credential mode, an agent that asks to sign in is refused and never logged in${paid ? "; a key without its cap never crosses" : ""}`, async (t) => {
    const h = await acp(t, { authRequired: true });
    const scout = agent(h);
    await h.ready(scout.id);
    const turn = h.send(scout.id, "hello");
    await h.ended(turn);
    assert.equal(h.store.turn(turn)!.status, "failed");
    assert.match(h.store.turn(turn)!.reason!, /asked to sign in/);
    // Never a sign-in: at most the method that selects its own key.
    assert.ok(!h.acpCalls().some((c) => c.method === "authenticate" && c.params?.methodId !== v.keyAuth));
    if (!v.key) return;
    writeFileSync(join(h.agentHome, "fake-acp.json"), base());
    keys(h.keysFile, { value: v.key.value });
    const spawned = h.acpCalls().length;
    const capless = h.send(scout.id, "hello");
    await h.ended(capless);
    assert.match(h.store.turn(capless)!.reason!, /no provider-side monthly cap/);
    assert.equal(h.acpCalls().length, spawned);
  });

  test(`${v.label}: usage, repeated and late updates are not usage; missing or contradictory usage is ${paid ? "charged in full and pauses the tab" : "never charged"}`, async (t) => {
    const h = await acp(t);
    const scout = agent(h);
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
    const missing = h.send(scout.id, "nousage");
    await h.ended(missing);
    assert.equal(h.store.turn(missing)!.status, "done");
    chargedInFull(h, missing);
    const bad = h.send(scout.id, "badusage");
    await h.ended(bad);
    chargedInFull(h, bad);
  });

  test(`${v.label}: partial owner waits, one of two parallel requests answered keeps the turn waiting`, async (t) => {
    const h = await acp(t);
    const scout = agent(h);
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
    assert.match(said(h, scout.id), /decision: yes,no/);
  });

  test(`${v.label}: cancellation, Stop cancels and answers a waiting request 'cancelled'; one that ignores it is ended`, async (t) => {
    const h = await acp(t);
    const scout = agent(h);
    await h.ready(scout.id);
    const hang = h.send(scout.id, "hang");
    await prompted(h, 1);
    runCommand(h.store, { action: "stop", agentId: scout.id });
    await h.ended(hang);
    assert.deepEqual([h.store.turn(hang)!.status, h.store.turn(hang)!.reason], ["stopped", "Stopped by the owner."]);
    assert.ok(h.acpCalls().some((c) => c.method === "session/cancel"));
    // A paid turn stopped mid-way: its usage plus the allowance, and its
    // tab waits for a Resume.
    const resume = () => {
      if (!h.store.tab(h.tab.id)!.paused) return;
      assert.match(h.store.tab(h.tab.id)!.pauseReason ?? "", /^Usage not reported: /);
      runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
    };
    if (paid) assert.equal(h.store.turn(hang)!.costBasis, "allowance");
    resume();
    const asking = h.send(scout.id, "askhang");
    await h.until(() => h.store.openRequests().some((r) => r.agentId === scout.id), "a request");
    runCommand(h.store, { action: "stop", agentId: scout.id });
    await h.ended(asking);
    assert.ok(h.acpCalls().some((c) => c.result && JSON.stringify(c.result).includes('"cancelled"')));
    resume();
    const deaf = h.send(scout.id, "deaf");
    await prompted(h, 3);
    runCommand(h.store, { action: "stop", agentId: scout.id });
    await h.ended(deaf);
    assert.equal(h.store.turn(deaf)!.status, "stopped");
    assert.match(h.log(), /^signal TERM \d+$/m);
  });

  test(`${v.label}: an unknown start, a prompt whose write failed is contained, ended${paid ? " and charged" : ""}; the next turn starts a new program`, async (t) => {
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
    const h = await acp(t, {}, { launcher: (l) => new FlakyInput(l.config) });
    const scout = agent(h);
    await h.ready(scout.id);
    const turn = h.send(scout.id, "hello");
    const next = h.send(scout.id, "hello");
    await h.ended(turn);
    assert.deepEqual([h.store.turn(turn)!.status, h.store.turn(turn)!.reason], ["interrupted", `${v.label} did not acknowledge the start.`]);
    chargedInFull(h, turn);
    await h.ended(next);
    assert.equal(h.store.turn(next)!.status, "done", h.store.turn(next)!.reason ?? "");
    assert.equal(new Set(h.acpCalls().filter((c) => c.method === "initialize").map((c) => c.pid)).size, 2);
  });

  test(`${v.label}: a resumed session and a restart, a new program loads the saved session without replaying it`, async (t) => {
    const h = await acp(t);
    const scout = agent(h);
    await h.ready(scout.id);
    await h.ended(h.send(scout.id, "hello"));
    const saved = h.store.session(scout.id);
    const hang = h.send(scout.id, "hang");
    await prompted(h, 2);
    await h.worker.stop();
    assert.equal(h.store.turn(hang)!.status, "interrupted");
    chargedInFull(h, hang);
    const next = h.newWorker();
    await next.start();
    const after = h.send(scout.id, "hello");
    await h.ended(after);
    assert.equal(h.store.turn(after)!.status, "done", h.store.turn(after)!.reason ?? "");
    assert.equal(h.acpCalls().filter((c) => c.method === "session/load").at(-1)?.params?.sessionId, saved);
    assert.ok(!said(h, scout.id).includes("REPLAYED HISTORY"));
  });
}
