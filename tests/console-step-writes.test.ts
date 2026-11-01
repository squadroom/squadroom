import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GIT_TOKEN, harness, TOKEN } from "./helpers/console-harness.ts";

// A tab with steps: any agent kind may edit, on any login, and
// writes stay inside the current step's files for every kind: refused when
// the client asks, put back after the turn when it did not.

const STEPS = [{ name: "Notes", files: ["notes.md", "parking-lot.md"] }];
const OPENAI = "sk-proj-FAKE-openai-key-for-steps-000000000ABCD";
const CAP = { usd: 10, url: "https://platform.openai.com/settings/organization/limits", checkedAt: "2026-10-20" };

async function stepped(t: Parameters<typeof harness>[0], extra: Parameters<typeof harness>[3] = {}) {
  const h = await harness(t, { tabSpendUsd: 1_000 }, false, extra);
  writeFileSync(h.keysFile, JSON.stringify({ keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN }, CONSOLE_GIT_TOKEN: { value: GIT_TOKEN }, OPENAI_API_KEY: { value: OPENAI, cap: CAP } }, projects: {} }), { mode: 0o600 });
  h.store.setTabSteps(h.tab.id, STEPS);
  await h.worker.start();
  return h;
}
const committed = (folder: string, path: string) => {
  try {
    execFileSync("git", ["-C", folder, "cat-file", "-e", `HEAD:${path}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

test("ACP on an API key in a tab with steps: the step's file is written, committed and charged; another file is refused", async (t) => {
  const h = await stepped(t, { acp: {}, acpCallMs: 1_000 });
  // Made by the owner's command: neither Edit nor a paid model is refused.
  const editor = h.agent("Writer", "edit", "openai/gpt-5.6-luna", "opencode");
  await h.ready(editor.id);
  const folder = h.store.agent(editor.id)!.folder;
  const ok = h.send(editor.id, `edit ${join(folder, "notes.md")}`);
  await h.ended(ok);
  assert.equal(h.store.turn(ok)!.status, "done", h.store.turn(ok)!.reason ?? "");
  assert.match(h.said(editor.id).join(""), /decision: yes/);
  await h.until(() => !!h.store.turn(ok)!.commitAfter, "turn committed");
  assert.ok(committed(folder, "notes.md"));
  assert.ok(h.store.turn(ok)!.costUsd! > 0);
  const no = h.send(editor.id, `edit ${join(folder, "brief.md")}`);
  await h.ended(no);
  assert.match(h.said(editor.id).join(""), /decision: no/);
  assert.equal(existsSync(join(folder, "brief.md")), false);
});

test("Codex in a tab with steps: a change to the step's file is accepted; another file is declined", async (t) => {
  const h = await stepped(t, { codex: {} });
  const coder = h.codexAgent();
  await h.ready(coder.id);
  const folder = h.store.agent(coder.id)!.folder;
  await h.ended(h.send(coder.id, `write ${join(folder, "notes.md")}`));
  assert.equal(h.said(coder.id).at(-1), "file: accept");
  await h.ended(h.send(coder.id, `write ${join(folder, "brief.md")}`));
  assert.equal(h.said(coder.id).at(-1), "file: decline");
  assert.equal(existsSync(join(folder, "brief.md")), false);
});

test("a write that never asked: outside the step's files it is put back after the turn and named in Needs you; the step's file is committed", async (t) => {
  const h = await stepped(t);
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  const folder = h.store.agent(lead.id)!.folder;
  // Claude's fake writes without asking, as a client tool or a command could.
  const turn = h.send(lead.id, "write brief.md");
  await h.ended(turn);
  await h.until(() => h.store.notices().some((n) => n.agentId === lead.id), "a notice");
  // The fake's own files (its arguments and environment) are put back too.
  assert.match(h.store.notices().find((n) => n.agentId === lead.id)!.text, /^Lead changed (\S+, )*brief\.md(, \S+)* outside this step; the Console put them back\. This step may change only: notes\.md, parking-lot\.md\.$/);
  assert.equal(existsSync(join(folder, "brief.md")), false);
  assert.equal(committed(folder, "brief.md"), false);
  const next = h.send(lead.id, "write notes.md");
  await h.ended(next);
  await h.until(() => !!h.store.turn(next)!.commitAfter, "turn committed");
  assert.ok(committed(folder, "notes.md"));
});
