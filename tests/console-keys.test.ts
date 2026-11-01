import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialValues, keyFor, readKeyFile } from "../src/lib/console/keys.ts";
import { GIT_TOKEN, harness, TOKEN } from "./helpers/console-harness.ts";

// the key file's shape (an older flat one
// refused), keys per project with caps per key, and what the
// redactor loads. No sudo, no network, no model call.

const CAP = { usd: 20, url: "https://platform.openai.com/settings/organization/limits", checkedAt: "2026-10-20" };
const OPENAI = "sk-proj-FAKE-global-openai-key-000000000000";
const OVERRIDE = "sk-proj-FAKE-project-openai-key-11111111111";

function file(t: TestContext, content: unknown, mode = 0o600) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "console-keys-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "console-keys.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content), { mode });
  return { dir, path };
}

test("the Claude and Git tokens are found with no cap; an older flat file is refused", (t) => {
  const { path } = file(t, { keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN }, CONSOLE_GIT_TOKEN: { value: GIT_TOKEN } } });
  assert.deepEqual(keyFor(path, "CLAUDE_CODE_OAUTH_TOKEN", "p1"), { value: TOKEN, cap: null, scope: "global" });
  assert.deepEqual(keyFor(path, "CONSOLE_GIT_TOKEN", null), { value: GIT_TOKEN, cap: null, scope: "global" });
  const flat = file(t, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  const before = readFileSync(flat.path, "utf8");
  assert.throws(() => keyFor(flat.path, "CLAUDE_CODE_OAUTH_TOKEN", null), /re-save it from the Keys page/);
  assert.throws(() => credentialValues(flat.path), /re-save it from the Keys page/);
  assert.equal(readFileSync(flat.path, "utf8"), before);
  // The file's own checks.
  const open = file(t, { keys: {} }, 0o644);
  assert.throws(() => readKeyFile(open.path), /mode 0600/);
});

test("a project's override beats the global key; each paid key carries its own cap, and one without is refused", (t) => {
  const { path } = file(t, {
    keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN }, OPENAI_API_KEY: { value: OPENAI, cap: CAP }, GEMINI_API_KEY: { value: "AIzaSyFAKE-gemini-key-0000000000000000000" } },
    projects: { p2: { OPENAI_API_KEY: { value: OVERRIDE, cap: { ...CAP, usd: 5 } } } },
  });
  assert.deepEqual(keyFor(path, "OPENAI_API_KEY", "p1"), { value: OPENAI, cap: CAP, scope: "global" });
  assert.deepEqual(keyFor(path, "OPENAI_API_KEY", "p2"), { value: OVERRIDE, cap: { ...CAP, usd: 5 }, scope: "project" });
  // A paid API key without a provider-side cap is never handed out (D-005).
  assert.throws(() => keyFor(path, "GEMINI_API_KEY", "p1"), /no provider-side monthly cap/);
  assert.throws(() => keyFor(path, "XAI_API_KEY", "p1"), /has no XAI_API_KEY/);
  // A cap must say how much, where it is set and when it was checked.
  const bad = file(t, { keys: { OPENAI_API_KEY: { value: OPENAI, cap: { usd: 20, url: "http://x" } } } });
  assert.throws(() => keyFor(bad.path, "OPENAI_API_KEY", null), /cap without usd, an https url and checkedAt/);
});

test("the redactor and push scan load every credential value, global and per project, and never a cap's fields", (t) => {
  const { path } = file(t, {
    keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN }, OPENAI_API_KEY: { value: OPENAI, cap: CAP } },
    projects: { p2: { OPENAI_API_KEY: { value: OVERRIDE, cap: CAP } } },
  });
  const values = credentialValues(path);
  assert.deepEqual(values.sort(), [OPENAI, OVERRIDE, TOKEN].sort());
  for (const v of values) assert.ok(!v.includes("platform.openai.com") && v !== "2026-10-20" && v !== "20");
});

test("a login token changed in the key file gives the window a new process, never the old token's", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  await h.ended(h.send(lead.id, "hello"));
  const NEW = "sk-ant-oat01-fake-rotated-token-111111111WXYZ";
  writeFileSync(join(h.root, "keys.json"), JSON.stringify({ keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: NEW }, CONSOLE_GIT_TOKEN: { value: GIT_TOKEN } }, projects: {} }), { mode: 0o600 });
  const turn = h.send(lead.id, "hello");
  await h.ended(turn);
  assert.equal(h.store.turn(turn)!.status, "done", h.store.turn(turn)!.reason ?? "");
  const launches = readFileSync(join(h.store.agent(lead.id)!.folder, "args.jsonl"), "utf8").trim().split("\n");
  assert.equal(launches.length, 2);
  assert.ok(launches[1].includes("--resume"), "the new process resumes the session");
});
