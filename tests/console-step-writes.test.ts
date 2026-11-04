import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../src/lib/console/commands.ts";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { git, GIT_TOKEN, harness, TOKEN } from "./helpers/console-harness.ts";

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
  const h = await stepped(t, { acp: {} });
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

test("Codex in a tab with steps: its sandbox writes in its folder without asking; another file than the step's is put back after the turn", async (t) => {
  const h = await stepped(t, { codex: {} });
  const coder = h.codexAgent();
  await h.ready(coder.id);
  const folder = h.store.agent(coder.id)!.folder;
  await h.ended(h.send(coder.id, `write ${join(folder, "notes.md")}`));
  assert.equal(h.said(coder.id).at(-1), "file: accept");
  await h.ended(h.send(coder.id, `write ${join(folder, "brief.md")}`));
  await h.until(() => h.store.notices().some((n) => n.agentId === coder.id && n.text.includes("brief.md")), "a notice");
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

// What an agent can do with Git itself mid-turn (a command): each of these
// must still leave nothing outside the step on its branch (review #279).
const onBranch = (folder: string, branch: string, path: string) => {
  try {
    execFileSync("git", ["-C", folder, "cat-file", "-e", `refs/heads/${branch}:${path}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
/** A turn of the Lead that hangs while `act` changes its folder, then ends
 * by Stop (so the worker commits it). */
async function midTurn(h: Awaited<ReturnType<typeof stepped>>, lead: { id: string }, act: (folder: string) => void) {
  const turn = h.send(lead.id, "hang");
  await h.started(turn);
  act(h.store.agent(lead.id)!.folder);
  runCommand(h.store, { action: "stop", agentId: lead.id });
  await h.ended(turn);
  await h.until(() => h.store.settlingAgents().length === 0 && h.store.turn(turn)!.commitAfter !== undefined, "turn settled");
  await new Promise((r) => setTimeout(r, 300));
  return turn;
}

test("an outside commit on its branch, then a switch to another branch: the agent's branch keeps nothing outside the step, and it is back on it", async (t) => {
  const h = await stepped(t);
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  const branch = h.store.agentBase(lead.id).branch!;
  await midTurn(h, lead, (folder) => {
    writeFileSync(join(folder, "brief.md"), "forbidden\n");
    writeFileSync(join(folder, "notes.md"), "allowed\n");
    git(folder, "add", "-A");
    git(folder, "commit", "-q", "-m", "outside");
    git(folder, "checkout", "-q", "-b", "elsewhere");
  });
  const folder = h.store.agent(lead.id)!.folder;
  assert.equal(git(folder, "symbolic-ref", "--short", "HEAD"), branch);
  assert.equal(onBranch(folder, branch, "brief.md"), false);
  assert.equal(onBranch(folder, branch, "notes.md"), true);
});

test("an outside .gitignore that hides an outside file: neither is committed", async (t) => {
  const h = await stepped(t);
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  await midTurn(h, lead, (folder) => {
    writeFileSync(join(folder, ".gitignore"), "secret.txt\n");
    writeFileSync(join(folder, "secret.txt"), "hidden\n");
    writeFileSync(join(folder, "notes.md"), "allowed\n");
  });
  const folder = h.store.agent(lead.id)!.folder;
  assert.equal(committed(folder, "secret.txt"), false);
  assert.equal(committed(folder, ".gitignore"), false);
  assert.equal(committed(folder, "notes.md"), true);
});

test("a turn cut off by a worker stop: its outside commit is checked against where that turn began, before the next turn", async (t) => {
  const h = await stepped(t);
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  const turn = h.send(lead.id, "hang");
  await h.started(turn);
  const folder = h.store.agent(lead.id)!.folder;
  writeFileSync(join(folder, "brief.md"), "forbidden\n");
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", "outside");
  await h.worker.stop();
  assert.equal(h.store.turn(turn)!.status, "interrupted");
  const next = h.newWorker();
  await next.start();
  const after = h.send(lead.id, "hello");
  await h.ended(after);
  assert.equal(committed(folder, "brief.md"), false);
  assert.equal(existsSync(join(folder, "brief.md")), false);
});

test("a tracked outside file deleted (and the deletion committed) is put back, and later turns still commit", async (t) => {
  const h = await stepped(t);
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  const folder = h.store.agent(lead.id)!.folder;
  // Already in the folder before the turn: part of where it begins.
  writeFileSync(join(folder, "other.md"), "approved\n");
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", "earlier");
  await midTurn(h, lead, (f) => {
    git(f, "rm", "-q", "other.md");
    git(f, "commit", "-q", "-m", "delete");
  });
  assert.equal(committed(folder, "other.md"), true);
  assert.equal(existsSync(join(folder, "other.md")), true);
  const next = h.send(lead.id, "write notes.md");
  await h.ended(next);
  await h.until(() => !!h.store.turn(next)!.commitAfter, "next turn committed");
  assert.ok(!h.events(lead.id).some((e) => e.kind === "error"), JSON.stringify(h.events(lead.id).filter((e) => e.kind === "error")));
});

test("Send next reorders turns: leftovers are checked from the turn that ran last, never an older one by id", () => {
  let clock = 1_000;
  const store = new ConsoleStore(":memory:", () => clock++);
  const epoch = store.takeLease("w1", clock)!;
  const project = runCommand(store, { action: "createProject", name: "Docs", source: "folder" }).project as { id: string };
  const tab = store.tabs(project.id)[0];
  const lead = runCommand(store, { action: "createAgent", tabId: tab.id, name: "Lead", kind: "claude-code", model: "haiku", permission: "edit" }).agent as { id: string };
  const ran = (id: number, before: string, after: string | null) => {
    store.startTurn(epoch, id);
    store.setTurnCommit(epoch, id, "before", before);
    if (after) store.setTurnCommit(epoch, id, "after", after);
    store.finishTurn(epoch, id, "done", null, null, "ok");
  };
  const first = store.queueTurn(lead.id, "one").id;
  ran(first, "a".repeat(40), "b".repeat(40));
  const later = store.queueTurn(lead.id, "two").id;
  const sooner = store.queueTurn(lead.id, "three").id;
  store.sendNext(sooner);
  ran(sooner, "b".repeat(40), "c".repeat(40));
  store.startTurn(epoch, later);
  assert.equal(store.stepBaseline(lead.id, later), "c".repeat(40));
  // Cut off before its commit: where it began.
  const cut = store.queueTurn(lead.id, "four").id;
  store.startTurn(epoch, cut);
  store.setTurnCommit(epoch, cut, "before", "d".repeat(40));
  store.finishTurn(epoch, cut, "interrupted", "Worker stopped.", null, null);
  const next = store.queueTurn(lead.id, "five").id;
  assert.equal(store.stepBaseline(lead.id, next), "d".repeat(40));
});

test("a new outside file staged and then changed again is still put back, and later turns commit", async (t) => {
  const h = await stepped(t);
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  await midTurn(h, lead, (folder) => {
    writeFileSync(join(folder, "new.md"), "one\n");
    git(folder, "add", "new.md");
    writeFileSync(join(folder, "new.md"), "two\n");
  });
  const folder = h.store.agent(lead.id)!.folder;
  assert.equal(existsSync(join(folder, "new.md")), false);
  assert.equal(committed(folder, "new.md"), false);
  assert.ok(!h.events(lead.id).some((e) => e.kind === "error"), JSON.stringify(h.events(lead.id).filter((e) => e.kind === "error")));
});

test("a merge left open (--no-commit) does not make an outside commit a parent of the Console's commit", async (t) => {
  const h = await stepped(t);
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  const branch = h.store.agentBase(lead.id).branch!;
  await midTurn(h, lead, (folder) => {
    git(folder, "checkout", "-q", "-b", "side");
    writeFileSync(join(folder, "brief.md"), "forbidden\n");
    git(folder, "add", "-A");
    git(folder, "commit", "-q", "-m", "outside");
    git(folder, "checkout", "-q", branch);
    writeFileSync(join(folder, "notes.md"), "allowed\n");
    git(folder, "merge", "-q", "--no-commit", "--no-ff", "side");
  });
  const folder = h.store.agent(lead.id)!.folder;
  const parents = git(folder, "rev-list", "--parents", "-n", "1", `refs/heads/${branch}`).split(" ");
  assert.equal(parents.length, 2, "one parent");
  assert.equal(onBranch(folder, branch, "brief.md"), false);
  assert.equal(onBranch(folder, branch, "notes.md"), true);
});

test("a merge left open with a conflict in an allowed file: its markers are not committed", async (t) => {
  const h = await stepped(t);
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  const branch = h.store.agentBase(lead.id).branch!;
  const folder = h.store.agent(lead.id)!.folder;
  writeFileSync(join(folder, "notes.md"), "base\n");
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", "earlier");
  const turn = await midTurn(h, lead, (f) => {
    git(f, "checkout", "-q", "-b", "side");
    writeFileSync(join(f, "notes.md"), "theirs\n");
    git(f, "commit", "-q", "-am", "side");
    git(f, "checkout", "-q", branch);
    writeFileSync(join(f, "notes.md"), "ours\n");
    git(f, "commit", "-q", "-am", "ours");
    try {
      git(f, "merge", "-q", "side");
    } catch {
      // Stopped with a conflict, as wanted.
    }
  });
  assert.doesNotMatch(git(folder, "show", `refs/heads/${branch}:notes.md`), /<<<<<<<|>>>>>>>/);
  assert.ok(h.events(lead.id).some((e) => e.turnId === turn && e.kind === "error" && /Conflict markers remain in notes\.md/.test(JSON.stringify(e.body))));
});

test("a restart while a turn was being committed: a stray outside-step commit at HEAD is not recorded, so it is never pushed", async (t) => {
  const h = await stepped(t);
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  await h.ended(h.send(lead.id, "hello"));
  const recorded = h.store.diff(lead.id)?.head ?? null;
  const folder = h.store.agent(lead.id)!.folder;
  await h.worker.stop();
  // The earlier worker died mid-commit (settling still set) while a program
  // the agent left running committed a file outside the step.
  writeFileSync(join(folder, "brief.md"), "forbidden\n");
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", "stray");
  const stray = git(folder, "rev-parse", "HEAD");
  h.store.setSettling(h.store.lease()!.epoch, lead.id, 1);
  const next = h.newWorker();
  await next.start();
  assert.deepEqual(h.store.settlingAgents(), []);
  assert.notEqual(h.store.diff(lead.id)?.head ?? null, stray);
  assert.equal(h.store.diff(lead.id)?.head ?? null, recorded);
});
