import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { reportData, runReport, type ReportData } from "../src/lib/console/report.ts";
import { markdownFileName } from "../src/lib/console/ui.ts";
import { Redactor } from "../src/lib/console/redact.ts";

// The run report and Markdown export: from the stored record
// only, no model call.

test("a tab's run as Markdown: summary, agents, each message and reply, commits and problems", () => {
  let clock = Date.UTC(2026, 9, 25, 9, 0);
  const store = new ConsoleStore(":memory:", () => (clock += 60_000));
  const epoch = store.takeLease("w1", clock)!;
  const project = store.createProject("Site", "folder");
  const tab = store.tabs(project.id)[0];
  const dev = store.createAgent({ tabId: tab.id, name: "Dev", role: "", kind: "claude-code", model: "haiku", effort: null, permission: "edit", askFirst: false });
  store.setAgentFolder(epoch, dev.id, "/work/dev");
  const one = store.queueTurn(dev.id, "# Fix the build\nIt fails on CI.");
  store.startTurn(epoch, one.id);
  store.finishTurn(epoch, one.id, "done", null, null, "Fixed: the import path was wrong.");
  store.addCommit(epoch, { turnId: one.id, agentId: dev.id, sha: "d".repeat(40), stat: "", patch: "", files: ["src/a.ts"] });
  const two = store.queueTurn(dev.id, "Now the tests");
  store.startTurn(epoch, two.id);
  store.finishTurn(epoch, two.id, "failed", "Claude Code ended the turn.");
  const withdrawn = store.queueTurn(dev.id, "never mind");
  store.withdrawQueued(withdrawn.id);

  const md = runReport(reportData(store, tab.id, clock)!);
  assert.match(md, /^# Site › Main: run report/);
  assert.match(md, /- Turns: 2 \(1 done, 1 failed, 0 interrupted, 0 stopped\)/);
  assert.match(md, /\| Dev \| Claude Code, Haiku \| Edits its folder \|/);
  // A message's own heading stays inside its quotation.
  assert.match(md, /The owner:\n\n> # Fix the build\n> It fails on CI\./);
  assert.match(md, /Dev:\n\n> Fixed: the import path was wrong\./);
  assert.match(md, /Commit `dddddddddddd`: `src\/a\.ts`/);
  assert.match(md, /turn \d+ · failed[\s\S]*Ended:\n\n> Claude Code ended the turn\./);
  assert.doesNotMatch(md, /never mind/);
  assert.equal(reportData(store, "t000000000000", clock), null);
});

test("the download's file name keeps only plain characters", () => {
  assert.equal(markdownFileName("Site - Main"), "Site - Main.md");
  assert.equal(markdownFileName("a/b:c*?"), "a-b-c-.md");
  assert.equal(markdownFileName("///"), "-.md");
  assert.equal(markdownFileName(""), "report.md");
});

test("stored text cannot change the report's structure, and every commit of a turn is listed", () => {
  const d: ReportData = {
    project: "Site",
    tab: "Main",
    generatedAt: 0,
    steps: null,
    agents: [{ name: "Dev | x\n\n# Injected", ai: "Claude Code, Haiku", access: "Edits its folder", approval: null }],
    turns: [
      {
        id: 1, agentId: "a", agentName: "Dev", trigger: "owner", prompt: "hello\r\r## Forged summary\rnot quoted", status: "failed",
        reason: "line one\n# heading", createdAt: 0, endedAt: 1, finalText: null, costUsd: null,
        commits: [{ sha: "a".repeat(40), files: ["x`y.md"] }, { sha: "b".repeat(40), files: ["z.md"] }],
      },
    ],
  };
  const md = runReport(d);
  assert.match(md, /\| Dev \\\| x # Injected \| Claude Code, Haiku \|/);
  assert.doesNotMatch(md, /^#+ (Injected|Forged|heading)/m);
  assert.match(md, /> hello\n> \n> ## Forged summary\n> not quoted/);
  assert.match(md, /Ended:\n\n> line one\n> # heading/);
  assert.match(md, /Commit `aaaaaaaaaaaa`: `x'y\.md`[\s\S]*Commit `bbbbbbbbbbbb`: `z\.md`/);
  // Names are not redacted when saved: the route passes the whole report
  // through the key-shape redactor, as here.
  const key = `sk-proj-${"Ab3".repeat(10)}`;
  assert.ok(runReport({ ...d, project: key }).includes(key));
  assert.ok(!new Redactor().text(runReport({ ...d, project: key })).includes(key));
});
