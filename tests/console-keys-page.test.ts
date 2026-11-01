import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyFor, readKeyFile, writeKeyFile } from "../src/lib/console/keys.ts";
import { CREDENTIALS, KeyCommandError, keysView, runKeyCommand } from "../src/lib/console/keys-page.ts";
import { codexLogin, connectionPanels, kindCredentials, parseVersion, probeConnection } from "../src/lib/console/connections.ts";
import { needsFreshCode, runCommand, runKeysCommand } from "../src/lib/console/commands.ts";
import { keysPageView } from "../src/lib/console/views.ts";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { Redactor } from "../src/lib/console/redact.ts";
import type { Launcher, RunResult } from "../src/lib/console/launcher.ts";
import { AGENT_KINDS, agentModel } from "../src/lib/console/agents.ts";
import { chargeTurn, pricedAt } from "../src/lib/console/spend.ts";
import { harness, TOKEN } from "./helpers/console-harness.ts";

// The Keys page and connection panels:
// writes the key file at 0600 by temporary file and rename, caps
// required for paid API keys only, a stored value never shown again, every
// write behind a fresh code, a new key masked without a worker restart, and
// Check connection running status probes only. No sudo, network or model.

const OPENAI = "sk-proj-FAKE-keys-page-openai-000000000001";
const GEMINI = "AIzaSyFAKE-keys-page-gemini-00000000000002";
const CAP = { usd: 20, url: "https://platform.openai.com/settings/organization/limits", checkedAt: "2026-10-20" };
const NOW = Date.parse("2026-10-21T12:00:00Z");

function folder(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "console-keys-page-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "keys", "console-keys.json") };
}
const set = (path: string, input: Record<string, unknown>, projects: string[] = []) =>
  runKeyCommand(path, { action: "setKey", ...input }, (id) => projects.includes(id), NOW);

test("adding a paid key needs its cap; the file is written 0600 in a 0700 folder with no temporary file left", (t) => {
  const { dir, path } = folder(t);
  assert.throws(() => set(path, { name: "OPENAI_API_KEY", value: OPENAI }), /needs its monthly cap/);
  assert.throws(() => set(path, { name: "OPENAI_API_KEY", value: OPENAI, cap: { ...CAP, url: "http://x" } }), /https link/);
  assert.throws(() => set(path, { name: "OPENAI_API_KEY", value: OPENAI, cap: { ...CAP, usd: 0 } }), /above 0/);
  assert.throws(() => set(path, { name: "OPENAI_API_KEY", value: OPENAI, cap: { ...CAP, checkedAt: "2026-12-01" } }), /in the future/);
  const saved = set(path, { name: "OPENAI_API_KEY", value: OPENAI, cap: CAP });
  assert.deepEqual(saved, { saved: true, name: "OPENAI_API_KEY", scope: "global", last4: "0001" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "keys")).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(join(dir, "keys")), ["console-keys.json"]);
  // The key file, read by the worker's own reader.
  assert.deepEqual(readKeyFile(path), { keys: { OPENAI_API_KEY: { value: OPENAI, cap: CAP } }, projects: {} });
  assert.deepEqual(keyFor(path, "OPENAI_API_KEY", "p1"), { value: OPENAI, cap: CAP, scope: "global" });
});

test("a login or the Git token carries no cap; a key too short to be masked, or with spaces, is refused", (t) => {
  const { path } = folder(t);
  assert.throws(() => set(path, { name: "CLAUDE_CODE_OAUTH_TOKEN", value: TOKEN, cap: CAP }), /no monthly cap/);
  set(path, { name: "CLAUDE_CODE_OAUTH_TOKEN", value: TOKEN });
  assert.deepEqual(keyFor(path, "CLAUDE_CODE_OAUTH_TOKEN", null), { value: TOKEN, cap: null, scope: "global" });
  assert.throws(() => set(path, { name: "XAI_API_KEY", value: "xai-short", cap: CAP }), /at least 12/);
  assert.throws(() => set(path, { name: "XAI_API_KEY", value: "xai-abc def-0000000000", cap: CAP }), /no spaces/);
  assert.throws(() => set(path, { name: "SOME_OTHER_KEY", value: OPENAI }), /listed credentials/);
  assert.throws(() => runKeyCommand(path, { action: "dropAll", name: "OPENAI_API_KEY" }, () => true), /Unknown key command/);
});

test("the page sees names, last four characters and caps, never a stored value", (t) => {
  const { path } = folder(t);
  set(path, { name: "OPENAI_API_KEY", value: OPENAI, cap: CAP });
  set(path, { name: "CLAUDE_CODE_OAUTH_TOKEN", value: TOKEN });
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), projects: { p1abcdef012345: { GEMINI_API_KEY: { value: GEMINI } } } }), { mode: 0o600 });
  const view = keysView(path);
  const shown = JSON.stringify(view);
  for (const secret of [OPENAI, TOKEN, GEMINI]) assert.ok(!shown.includes(secret));
  assert.deepEqual(
    view.global.map((r) => [r.name, r.last4, r.needsCap]),
    [
      ["CLAUDE_CODE_OAUTH_TOKEN", "ABCD", false],
      ["OPENAI_API_KEY", "0001", false],
    ],
  );
  // A paid key written by hand without a cap is flagged; no agent gets it.
  assert.deepEqual(view.projects.p1abcdef012345.map((r) => [r.name, r.needsCap, r.limitUrl]), [["GEMINI_API_KEY", true, "https://aistudio.google.com/"]]);
  // A file it cannot read is reported, not overwritten.
  chmodSync(path, 0o644);
  assert.match(keysView(path).problem ?? "", /mode 0600/);
  const before = readFileSync(path, "utf8");
  assert.throws(() => set(path, { name: "CLAUDE_CODE_OAUTH_TOKEN", value: TOKEN }), /does not overwrite a file it cannot read/);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(keysView(join(path, "..", "none.json")).exists, false);
});

test("a cap changes without the key; a project overrides and removes its own entry; unknown projects are refused", (t) => {
  const { path } = folder(t);
  const P = "pabcdef012345";
  set(path, { name: "OPENAI_API_KEY", value: OPENAI, cap: CAP });
  set(path, { name: "OPENAI_API_KEY", cap: { ...CAP, usd: 15 } });
  assert.deepEqual(readKeyFile(path).keys.OPENAI_API_KEY, { value: OPENAI, cap: { ...CAP, usd: 15 } });
  assert.throws(() => set(path, { name: "GEMINI_API_KEY", cap: CAP }), /Paste the key/);
  assert.throws(() => set(path, { name: "OPENAI_API_KEY", value: OPENAI, cap: CAP, projectId: "pffffffffffff" }, [P]), /does not exist/);
  const OWN = "sk-proj-FAKE-keys-page-project-0000000009";
  assert.equal(set(path, { name: "OPENAI_API_KEY", value: OWN, cap: { ...CAP, usd: 5 }, projectId: P }, [P]).scope, "project");
  assert.deepEqual(keyFor(path, "OPENAI_API_KEY", P), { value: OWN, cap: { ...CAP, usd: 5 }, scope: "project" });
  assert.equal(keyFor(path, "OPENAI_API_KEY", "pother0000000").value, OPENAI);
  runKeyCommand(path, { action: "removeKey", name: "OPENAI_API_KEY", projectId: P }, (id) => id === P);
  assert.deepEqual(readKeyFile(path).projects, {});
  assert.equal(keyFor(path, "OPENAI_API_KEY", P).scope, "global");
  runKeyCommand(path, { action: "removeKey", name: "OPENAI_API_KEY" }, () => false);
  assert.throws(() => keyFor(path, "OPENAI_API_KEY", null), /has no OPENAI_API_KEY/);
  assert.throws(() => runKeyCommand(path, { action: "removeKey", name: "OPENAI_API_KEY" }, () => false), KeyCommandError);
  // A stored name no longer listed (written by hand) can still be removed,
  // never added or changed.
  const file = readKeyFile(path);
  file.keys.OLD_VENDOR_KEY = { value: "old-vendor-key-000000000000" };
  writeKeyFile(path, file);
  assert.equal(keysView(path).global.find((r) => r.name === "OLD_VENDOR_KEY")!.kind, "unknown");
  assert.throws(() => set(path, { name: "OLD_VENDOR_KEY", value: "old-vendor-key-111111111111" }), /listed credentials/);
  runKeyCommand(path, { action: "removeKey", name: "OLD_VENDOR_KEY" }, () => false);
  assert.equal(readKeyFile(path).keys.OLD_VENDOR_KEY, undefined);
});

test("the writer never replaces a link and refuses a folder others can write", (t) => {
  const { dir } = folder(t);
  const target = join(dir, "elsewhere.json");
  writeFileSync(target, JSON.stringify({ keys: {}, projects: {} }), { mode: 0o600 });
  const link = join(dir, "link.json");
  symlinkSync(target, link);
  assert.throws(() => writeKeyFile(link, { keys: {}, projects: {} }), /plain file/);
  // a 700 folder; a folder others can read or enter is refused too.
  for (const mode of [0o777, 0o755, 0o711]) {
    const open = join(dir, `open-${mode.toString(8)}`);
    mkdirSync(open);
    chmodSync(open, mode);
    assert.throws(() => writeKeyFile(join(open, "k.json"), { keys: {}, projects: {} }), /mode 0700/);
  }
});

test("every Keys page write needs a fresh code; Check connection does not", () => {
  assert.equal(needsFreshCode({ action: "setKey", name: "OPENAI_API_KEY" }), true);
  assert.equal(needsFreshCode({ action: "removeKey", name: "OPENAI_API_KEY" }), true);
  assert.equal(needsFreshCode({ action: "checkConnection", kind: "codex" }), false);
});

test("the credential catalog is the launcher's list and the sudoers env_keep, plus the Git token and the worker-only Krea key", () => {
  const launcher = readFileSync("scripts/console/console-agent", "utf8");
  const list = launcher.match(/readonly CREDENTIALS=\(([^)]*)\)/)![1].split(/\s+/).filter(Boolean);
  const setup = readFileSync("scripts/console/setup-agent-user.sh", "utf8");
  const keep = setup.match(/env_keep = "([^"]*)"/)![1].split(/\s+/);
  const names = CREDENTIALS.filter((c) => c.kind !== "git" && !c.workerOnly).map((c) => c.name);
  assert.deepEqual([...names].sort(), [...list].sort());
  assert.deepEqual([...names].sort(), [...keep].sort());
  // The Krea key is the worker's own: never in either list, and
  // a paid key with a cap whose hint is the prepaid balance.
  const krea = CREDENTIALS.find((c) => c.name === "KREA_API_KEY")!;
  assert.deepEqual([krea.kind, krea.workerOnly, krea.limitHint], ["api", true, "Prepaid balance, auto top-up off: the balance is the cap."]);
  assert.ok(!list.includes("KREA_API_KEY") && !keep.includes("KREA_API_KEY"));
  for (const c of CREDENTIALS) if (c.kind === "api") assert.match(c.limitUrl ?? "", /^https:\/\//, c.name);
  // Every paid model's key is in the catalog.
  for (const kind of AGENT_KINDS) for (const name of kindCredentials(kind)) assert.ok(CREDENTIALS.some((c) => c.name === name), name);
});

test("connection panels: versions, logins, and which keys are present", () => {
  assert.equal(parseVersion("2.1.282 (Claude Code)"), "2.1.282");
  assert.equal(parseVersion("codex-cli 0.155.1"), "0.155.1");
  assert.equal(parseVersion("2.1.282-beta"), null);
  assert.equal(codexLogin(0, "Logged in using ChatGPT\n"), "connected");
  assert.equal(codexLogin(0, "Logged in using an API key - sk-…"), "wrong_account");
  assert.equal(codexLogin(1, "Not logged in"), "signed_out");
  const panels = connectionPanels(
    {
      exists: true,
      problem: null,
      credentials: CREDENTIALS,
      global: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", label: "", kind: "login", last4: "ABCD", cap: null, needsCap: false, limitUrl: null, limitHint: null }],
      projects: { p1: [{ name: "OPENAI_API_KEY", label: "", kind: "api", last4: "0001", cap: null, needsCap: true, limitUrl: null, limitHint: null }] },
    },
    new Map(),
  );
  const claude = panels.find((p) => p.kind === "claude-code")!;
  // Its login token, and the Anthropic key its API-key models use.
  assert.deepEqual(claude.credentials, [
    { name: "CLAUDE_CODE_OAUTH_TOKEN", global: true, projects: 0, needsCap: false },
    { name: "ANTHROPIC_API_KEY", global: false, projects: 0, needsCap: false },
  ]);
  const codex = panels.find((p) => p.kind === "codex")!;
  assert.equal(codex.accountLogin, true);
  assert.deepEqual(codex.credentials, [{ name: "OPENAI_API_KEY", global: false, projects: 1, needsCap: true }]);
  const open = panels.find((p) => p.kind === "opencode")!;
  assert.deepEqual(open.credentials.find((c) => c.name === "OPENAI_API_KEY"), { name: "OPENAI_API_KEY", global: false, projects: 1, needsCap: true });
  assert.equal(open.pinned, "unpinned");
});

test("Check connection runs only --version (and Codex's login status), as agent, with no credential", async () => {
  const calls: { cwd: string; program: string; args: string[] }[] = [];
  const result = (code: number, stdout: string, stderr = ""): RunResult => ({ code, stdout, stderr, truncated: false, bytes: Buffer.from(stdout) });
  const fake = (answers: RunResult[]) =>
    ({
      runIn: async (cwd: string, program: string, args: string[]) => {
        calls.push({ cwd, program, args });
        return answers.shift()!;
      },
    }) as unknown as Launcher;
  const codex = await probeConnection(fake([result(0, "codex-cli 0.155.1"), result(0, "", "Logged in using ChatGPT")]), "/Users/agent", "codex", "/opt/c/codex", new Redactor(), () => 7);
  assert.deepEqual(codex, { installed: "0.155.1", missing: false, login: "connected", note: null, checkedAt: 7 });
  assert.deepEqual(calls.map((c) => c.args), [["--version"], ["login", "status"]]);
  calls.length = 0;
  const gone = await probeConnection(fake([result(127, "", "No such file sk-ant-oat01-should-be-masked-000000")]), "/Users/agent", "opencode", "/opt/c/opencode", new Redactor());
  assert.equal(gone.missing, true);
  assert.ok(!gone.note!.includes("should-be-masked"));
  assert.deepEqual(calls.map((c) => c.args), [["--version"]]);
  // Kimi Code's membership login has no status command: version only, and
  // the panel says when the login is checked.
  calls.length = 0;
  const kimi = await probeConnection(fake([result(0, "kimi 2.3.0")]), "/Users/agent", "kimi-code", "/opt/c/kimi", new Redactor());
  assert.deepEqual([kimi.installed, kimi.login], ["2.3.0", null]);
  assert.match(kimi.note!, /checked when its first turn starts/);
  assert.deepEqual(calls.map((c) => c.args), [["--version"]]);
});

test("ACP kinds: Gemini and Grok on paid keys, Kimi Code on the agent account's membership; Gemini's 2027 rates apply from their date", () => {
  const panels = connectionPanels({ exists: false, problem: null, credentials: CREDENTIALS, global: [], projects: {} }, new Map());
  assert.deepEqual(panels.find((p) => p.kind === "gemini-cli")!.credentials.map((c) => c.name), ["GEMINI_API_KEY"]);
  assert.deepEqual(panels.find((p) => p.kind === "grok-build")!.credentials.map((c) => c.name), ["XAI_API_KEY"]);
  const kimi = panels.find((p) => p.kind === "kimi-code")!;
  assert.deepEqual([kimi.credentials, kimi.accountLogin, kimi.pinned], [[], true, "2.3.0"]);
  const gemini = agentModel("gemini-cli", "gemini-3.8-flash")!;
  const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };
  const now = chargeTurn(gemini, usage, new Date("2026-10-21T00:00:00Z"))!.usd;
  const later = chargeTurn(gemini, usage, new Date("2027-01-02T00:00:00Z"))!.usd;
  assert.equal(now, 0.75 + 0.375);
  assert.equal(later, 1.5 + 0.75);
  assert.equal(agentModel("kimi-code", "kimi-code/kimi-for-coding")!.paid, undefined);
  // A turn is priced when it started, even when charged after the change.
  const started = Date.parse("2026-12-31T23:50:00Z");
  assert.equal(chargeTurn(gemini, usage, pricedAt({ startedAt: started }, Date.parse("2027-01-03T00:00:00Z")))!.usd, now);
  assert.equal(pricedAt(undefined, started).getTime(), started);
});

test("the store keeps one waiting check per kind and the page reads the latest; keys go through their own command", (t) => {
  const { dir, path } = folder(t);
  const store = new ConsoleStore(join(dir, "console.sqlite"));
  t.after(() => store.close());
  const first = runCommand(store, { action: "checkConnection", kind: "codex" }).checkId;
  assert.equal(runCommand(store, { action: "checkConnection", kind: "codex" }).checkId, first);
  assert.throws(() => runCommand(store, { action: "checkConnection", kind: "nope" }), /does not exist/);
  const project = store.createProject("P", "folder");
  runKeysCommand(store, path, { action: "setKey", name: "CLAUDE_CODE_OAUTH_TOKEN", value: TOKEN, projectId: project.id });
  const view = keysPageView(store, path);
  assert.equal(view.connections.find((c) => c.kind === "codex")!.check!.state, "pending");
  assert.deepEqual(view.keys.projects[project.id].map((r) => r.last4), ["ABCD"]);
  assert.deepEqual(view.projects, [{ id: project.id, name: "P", archived: false }]);
  assert.throws(() => runKeysCommand(store, path, { action: "setKey", name: "CLAUDE_CODE_OAUTH_TOKEN", value: TOKEN, projectId: "pffffffffffff" }), /does not exist/);
});

test("the worker masks a key added after its start without a restart, and runs Check connection", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const redactor = (h.worker as unknown as { redactor: Redactor }).redactor;
  const NEW = "sk-proj-FAKE-added-later-key-0000000000QRST".replace("sk-proj-", "zz-");
  assert.equal(redactor.text(NEW), NEW);
  const file = readKeyFile(h.keysFile);
  file.keys.OPENAI_API_KEY = { value: NEW, cap: CAP };
  writeKeyFile(h.keysFile, file);
  await h.until(() => redactor.text(NEW) !== NEW, "the new key is masked");
  assert.equal(redactor.text(NEW), "[redacted …QRST]");
  const id = runCommand(h.store, { action: "checkConnection", kind: "opencode" }).checkId as number;
  await h.until(() => h.store.latestChecks().some((c) => c.id === id && c.state === "done"), "the check ends");
  const check = h.store.latestChecks().find((c) => c.id === id)!.result as { installed: string; missing: boolean };
  assert.equal(check.installed, "1.2.3");
  assert.equal(check.missing, false);
});
