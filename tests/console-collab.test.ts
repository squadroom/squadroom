import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../src/lib/console/commands.ts";
import { needsView, projectView } from "../src/lib/console/views.ts";
import { claimCovers, claimPattern, claimsOverlap, holdCycle } from "../src/lib/console/team.ts";
import { transcript } from "../src/lib/console/transcript.ts";
import { harness, TOKEN } from "./helpers/console-harness.ts";

// coding agents working on the same
// code — team_pull with conflicts and abort, claims (enforced for Claude,
// flagged after a turn for everyone), holds with their timeout, cycles and
// the stall check, and the team template. Fakes only.

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null" } as Record<string, string> as NodeJS.ProcessEnv }).trim();
const call = (tool: string, args: Record<string, unknown> = {}) => `call ${tool} ${JSON.stringify(args)}`;

test("claim patterns and hold cycles", () => {
  assert.ok(claimCovers("src/auth/**", "src/auth/login.ts"));
  assert.ok(claimCovers("docs", "docs/a.md"));
  assert.ok(!claimCovers("src/*.ts", "src/x/a.ts"));
  assert.ok(!claimsOverlap("src/a.ts", "src/b.ts"));
  assert.ok(claimsOverlap("src/**", "src/a.ts"));
  assert.ok(!claimsOverlap("src/auth/**", "src/api/**"));
  // Conservative: a pattern with no fixed folder overlaps everything.
  assert.ok(claimsOverlap("*.md", "docs/x.md"));
  // The Mac ignores case in paths, so claims do too.
  assert.ok(claimsOverlap("src/**", "SRC/**"));
  assert.ok(claimCovers("src/New.ts", "src/new.ts"));
  assert.ok(claimCovers("..config", "..config"));
  // "." components are dropped; "." alone claims everything.
  assert.equal(claimPattern("src/."), "src");
  assert.equal(claimPattern("./src/./a.ts"), "src/a.ts");
  assert.equal(claimPattern("."), "**");
  assert.deepEqual(holdCycle([{ holder: "a", held: "b" }], "b", "a"), ["b", "a", "b"]);
  assert.equal(holdCycle([{ holder: "a", held: "b" }], "a", "c"), null);
});

test("review N1: a pattern full of ** or * is matched fast, with the same meaning", () => {
  const deep = "a/b/c/d/e/f/g/h/i/j/k.ts";
  const started = performance.now();
  // Within the 200-character limit; each took seconds as a regular expression.
  assert.equal(claimCovers(`${"**/".repeat(66)}zz`, deep), false);
  assert.equal(claimCovers(`${"**/".repeat(66)}k.ts`, deep), true);
  assert.equal(claimCovers("**/a/".repeat(40), `${Array(60).fill("a").join("/")}/x`), false);
  assert.equal(claimCovers(`${"*a".repeat(99)}b`, "a".repeat(255)), false);
  assert.ok(performance.now() - started < 200, `${performance.now() - started} ms`);
  // What each form of ** meant before.
  for (const [pattern, path, covered] of [
    ["**", "a/b/c", true],
    ["**/x.ts", "x.ts", true],
    ["**/x.ts", "a/b/x.ts", true],
    ["**/x.ts", "a/bx.ts", false],
    ["src/**", "src", true],
    ["src/**", "src/a/b", true],
    ["src/**", "srcx/a", false],
    ["src/**/a.ts", "src/a.ts", true],
    ["src/**/a.ts", "src/x/y/a.ts", true],
    ["src/**/**", "src/x", true],
    ["src/**/**", "src", false],
    ["s?c/*.ts", "src/a.ts", true],
    ["s?c/*.ts", "s/c/a.ts", false],
    ["docs/*.md", "docs/a.md/old", true],
    ["a.b", "axb", false],
    ["**/x", "a\nb/x", false],
  ] as const)
    assert.equal(claimCovers(pattern, path), covered, `${pattern} ${JSON.stringify(path)}`);
});

test("team_pull: a clean merge, never the teammate's uncommitted work; conflicts resolved in a later turn; abort", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const a = h.agent("Lead A");
  const b = h.agent("Lead B");
  await h.ready(a.id, b.id);
  const aFolder = h.store.agent(a.id)!.folder;
  const bFolder = h.store.agent(b.id)!.folder;
  // The fake client's own record files are not part of the work.
  for (const f of [aFolder, bFolder]) writeFileSync(join(f, ".git", "info", "exclude"), "args.jsonl\nenv.json\n");
  await h.ended(h.send(a.id, "write g.txt"));
  await h.until(() => h.store.commits(a.id).some((c) => c.files.includes("g.txt")), "A committed");
  // Uncommitted work in A's folder never comes along.
  writeFileSync(join(aFolder, "draft.txt"), "not committed\n");
  await h.ended(h.send(b.id, call("team_pull", { from: "Lead A" })));
  assert.match(h.said(b.id).at(-1)!, /^team_pull: Merged Lead A's work into your branch/);
  assert.equal(readFileSync(join(bFolder, "g.txt"), "utf8"), readFileSync(join(aFolder, "g.txt"), "utf8"));
  assert.equal(existsSync(join(bFolder, "draft.txt")), false);
  assert.equal(git(bFolder, "rev-parse", "--abbrev-ref", "HEAD"), h.store.agentBase(b.id).branch);
  // The teammate's branch is only read.
  assert.equal(git(aFolder, "rev-parse", "--abbrev-ref", "HEAD"), h.store.agentBase(a.id).branch);
  // Pulling again: nothing new.
  await h.ended(h.send(b.id, call("team_pull", { from: "Lead A" })));
  assert.match(h.said(b.id).at(-1)!, /already has all of Lead A's committed work/);

  // Both change f.txt: a conflict.
  await h.ended(h.send(a.id, "put f.txt from A"));
  await h.ended(h.send(b.id, "put f.txt from B"));
  await h.until(() => h.store.commits(b.id).some((c) => c.files.includes("f.txt")), "B committed");
  const before = git(bFolder, "rev-parse", "HEAD");
  await h.ended(h.send(b.id, call("team_pull", { from: "Lead A" })));
  assert.match(h.said(b.id).at(-1)!, /^team_pull: The merge of Lead A's work has conflicts in: f\.txt\./);
  assert.deepEqual(h.store.merging(b.id), { from: a.id, fromName: "Lead A", files: ["f.txt"] });
  assert.match(readFileSync(join(bFolder, "f.txt"), "utf8"), /^<<<<<<< /m);
  // Ending the turn with the markers still there commits nothing.
  await h.until(() => transcript(h.events(b.id)).some((x) => x.type === "error" && /merge is not finished: conflict markers remain in f\.txt/.test(x.text)), "not committed");
  assert.equal(git(bFolder, "rev-parse", "HEAD"), before);
  // Staging the file with its markers still in it changes nothing.
  git(bFolder, "add", "f.txt");
  await h.ended(h.send(b.id, "hello"));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(git(bFolder, "rev-parse", "HEAD"), before);
  assert.ok(h.store.merging(b.id));
  // The next turn is told, resolves it, and the merge is committed.
  const fix = h.send(b.id, "put f.txt resolved");
  await h.ended(fix);
  await h.until(() => h.store.merging(b.id) === null, "merge committed");
  assert.equal(readFileSync(join(bFolder, "f.txt"), "utf8"), "resolved\n");
  assert.equal(git(bFolder, "rev-list", "--parents", "-1", "HEAD").split(" ").length, 3);
  assert.equal(git(bFolder, "status", "--porcelain", "--", "f.txt"), "");

  // Another conflict, abandoned: the branch goes back.
  await h.ended(h.send(a.id, "put f.txt from A again"));
  await h.ended(h.send(b.id, "put f.txt from B again"));
  await h.until(() => !!h.store.turn(Math.max(...h.events(b.id).map((e) => e.turnId)))!.commitAfter, "B committed");
  const kept = git(bFolder, "rev-parse", "HEAD");
  await h.ended(h.send(b.id, call("team_pull", { from: "Lead A" })));
  assert.ok(h.store.merging(b.id));
  await h.ended(h.send(b.id, call("team_pull_abort")));
  assert.match(h.said(b.id).at(-1)!, /^team_pull_abort: The merge was abandoned/);
  assert.equal(h.store.merging(b.id), null);
  assert.equal(git(bFolder, "rev-parse", "HEAD"), kept);
  assert.equal(readFileSync(join(bFolder, "f.txt"), "utf8"), "from B again\n");
  await h.ended(h.send(b.id, call("team_pull_abort")));
  assert.match(h.said(b.id).at(-1)!, /error: No merge is in progress/);
  // A Look only agent cannot pull.
  const look = h.agent("Reviewer", "look");
  await h.ready(look.id);
  await h.ended(h.send(look.id, call("team_pull", { from: "Lead A" })));
  assert.match(h.said(look.id).at(-1)!, /error: Only an agent that edits its folder can pull/);
});

test("claims: Claude's writes are refused inside a teammate's claim; overlapping claims are refused; release opens them", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const a = h.agent("Lead A");
  const b = h.agent("Lead B");
  await h.ready(a.id, b.id);
  await h.ended(h.send(b.id, call("team_claim", { paths: ["src/**"], note: "refactoring login" })));
  assert.match(h.said(b.id).at(-1)!, /^team_claim: Claimed src\/\*\*/);
  await h.ended(h.send(a.id, "approve src/a.ts"));
  assert.equal(h.said(a.id).at(-1), "decision: deny");
  assert.ok(transcript(h.events(a.id)).some((x) => x.type === "permission" && x.reason === "Lead B is editing src/** (refactoring login). Ask them with team_send, or wait for team_release."));
  // Outside the claim: allowed.
  await h.ended(h.send(a.id, "approve docs/a.md"));
  assert.equal(h.said(a.id).at(-1), "decision: allow");
  await h.ended(h.send(a.id, call("team_claim", { paths: ["src/x.ts"], note: "x" })));
  assert.match(h.said(a.id).at(-1)!, /error: Already claimed: Lead B is editing src\/\*\* \(refactoring login\)/);
  await h.ended(h.send(a.id, call("team_claim", { paths: ["../x"], note: "x" })));
  assert.match(h.said(a.id).at(-1)!, /error: "\.\.\/x" is not a path inside your folder/);
  await h.ended(h.send(a.id, call("team_claim", { paths: ["["], note: "x" })));
  assert.match(h.said(a.id).at(-1)!, /error: "\[": use \* and \*\* instead of \[ \]/);
  // A path that reaches the claim through ".." is still refused.
  await h.ended(h.send(a.id, `approve ${h.store.agent(a.id)!.folder}/tmp/../src/auth.ts`));
  assert.equal(h.said(a.id).at(-1), "decision: deny");
  // So is one through a link inside the folder (alias -> src).
  mkdirSync(join(h.store.agent(a.id)!.folder, "src"), { recursive: true });
  symlinkSync("src", join(h.store.agent(a.id)!.folder, "alias"));
  await h.ended(h.send(a.id, "approve alias/auth.ts"));
  assert.equal(h.said(a.id).at(-1), "decision: deny");
  // A name starting with two dots is still a file inside the folder.
  await h.ended(h.send(b.id, call("team_claim", { paths: ["..config"], note: "" })));
  await h.ended(h.send(a.id, "approve ..config"));
  assert.equal(h.said(a.id).at(-1), "decision: deny");
  await h.ended(h.send(b.id, call("team_release", { paths: ["..config"] })));
  // A path holding a credential is never claimed (nor stored).
  await h.ended(h.send(b.id, call("team_claim", { paths: ["src/$TOKEN"], note: "" })));
  assert.match(h.said(b.id).at(-1)!, /error: A path holds a credential; it was not claimed/);
  // Look only agents cannot claim.
  const look = h.agent("Orchestrator", "look");
  await h.ready(look.id);
  await h.ended(h.send(look.id, call("team_claim", { paths: ["**"], note: "everything" })));
  assert.match(h.said(look.id).at(-1)!, /error: Only an agent that edits its folder can claim paths/);
  // An invalid path to release is an error, never "release everything".
  await h.ended(h.send(b.id, call("team_release", { paths: ["../x"] })));
  assert.match(h.said(b.id).at(-1)!, /error: "\.\.\/x" is not a path inside your folder/);
  assert.equal(h.store.claims(h.tab.id).length, 1);
  // Shown in team_list, the Team panel and the window.
  await h.ended(h.send(a.id, "team_list"));
  assert.match(h.said(a.id).at(-1)!, /- Lead B \(id [a-z0-9]+\): .*; editing src\/\*\* \(refactoring login\)/);
  const view = projectView(h.store, h.project.id)!;
  assert.deepEqual(view.tabs[0].claims.map((c) => [c.agentName, c.pattern]), [["Lead B", "src/**"]]);
  assert.deepEqual(view.agents.find((x) => x.id === b.id)!.claims.map((c) => c.pattern), ["src/**"]);
  await h.ended(h.send(b.id, call("team_release")));
  assert.match(h.said(b.id).at(-1)!, /^team_release: Released 1 claim/);
  await h.ended(h.send(a.id, "approve src/a.ts"));
  assert.equal(h.said(a.id).at(-1), "decision: allow");
  // The owner releases any claim; closing an agent releases its claims.
  await h.ended(h.send(b.id, call("team_claim", { paths: ["lib"], note: "" })));
  const [claim] = h.store.claims(h.tab.id);
  runCommand(h.store, { action: "releaseClaim", claimId: claim.id });
  assert.equal(h.store.claims(h.tab.id).length, 0);
  await h.ended(h.send(b.id, call("team_claim", { paths: ["lib"], note: "" })));
  runCommand(h.store, { action: "close", agentId: b.id });
  assert.equal(h.store.claims(h.tab.id).length, 0);
});

test("claims expire after their time", async (t) => {
  const h = await harness(t, { claimMs: 300 });
  await h.worker.start();
  const a = h.agent("Lead A");
  await h.ready(a.id);
  await h.ended(h.send(a.id, call("team_claim", { paths: ["src"], note: "n" })));
  assert.equal(h.store.claims(h.tab.id).length, 1);
  await h.until(() => h.store.claims(h.tab.id).length === 0, "expired");
});

test("a Codex edit inside a Claude teammate's claim is flagged in Needs you after the turn", async (t) => {
  const h = await harness(t, {}, false, { codex: { account: "chatgpt" } });
  await h.worker.start();
  const lead = h.agent("Lead");
  const coder = h.codexAgent("Coder");
  await h.ready(lead.id, coder.id);
  await h.ended(h.send(lead.id, call("team_claim", { paths: ["notes.md"], note: "rewriting the notes" })));
  const turn = h.send(coder.id, `write ${h.store.agent(coder.id)!.folder}/notes.md`);
  await h.ended(turn);
  await h.until(() => needsView(h.store).notices.length === 1, "flagged");
  const [notice] = needsView(h.store).notices;
  assert.equal(notice.text, "Coder changed notes.md, which Lead has claimed (notes.md: rewriting the notes).");
  runCommand(h.store, { action: "dismissNotice", noticeId: notice.id });
  assert.equal(needsView(h.store).notices.length, 0);
});

test("holds: team messages wait for team_resume; a timeout lifts them; a cycle pauses the tab; a forgotten hold is a stall", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const a = h.agent("Lead A");
  const b = h.agent("Lead B");
  await h.ready(a.id, b.id);
  await h.ended(h.send(a.id, call("team_hold", { to: "Lead B", reason: "merging auth changes" })));
  assert.match(h.said(a.id).at(-1)!, /^team_hold: Lead B is on hold/);
  assert.deepEqual(
    (({ holderName, reason }) => ({ holderName, reason }))(projectView(h.store, h.project.id)!.agents.find((x) => x.id === b.id)!.heldBy!),
    { holderName: "Lead A", reason: "merging auth changes" },
  );
  // B cannot hold A back: a cycle pauses the tab for the owner.
  await h.ended(h.send(b.id, call("team_hold", { to: "Lead A", reason: "me too" })));
  assert.match(h.said(b.id).at(-1)!, /error: That would make agents hold each other \(Lead B → Lead A → Lead B\)/);
  assert.match(h.store.pauseReason("tab", h.tab.id)!, /^Agents are holding each other/);
  // The owner's Resume lifts every hold in the tab.
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  assert.equal(h.store.holds(h.tab.id).length, 0);
  // Held: a message waits; team_resume delivers it.
  await h.ended(h.send(a.id, call("team_hold", { to: "Lead B", reason: "wait" })));
  await h.ended(h.send(a.id, call("team_resume", { to: "Lead B" })));
  assert.match(h.said(a.id).at(-1)!, /^team_resume: Lead B is no longer on hold/);
  await h.ended(h.send(a.id, call("team_hold", { to: "Lead B", reason: "wait again" })));
  await h.ended(h.send(a.id, call("team_send", { to: "Lead B", message: "hi" })));
  // Nobody is working to lift it: the stall check pauses the tab.
  await h.until(() => h.store.pauseReason("tab", h.tab.id) !== null, "stalled");
  assert.match(h.store.pauseReason("tab", h.tab.id)!, /^Waiting on a hold that nobody is working to lift: Lead B is on hold by Lead A \(wait again\)/);
  assert.equal(h.store.queuedMessages(b.id).length, 1);
  runCommand(h.store, { action: "resume", scope: "tab", id: h.tab.id });
  await h.until(() => h.said(b.id).some((s) => s.includes("From Lead A:\nhi")), "delivered after Resume");
});

test("a team turn already made waits while its agent is held; team_resume is recorded; work committed outside a turn's end is checked against claims", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const a = h.agent("Lead A");
  const b = h.agent("Lead B");
  await h.ready(a.id, b.id);
  // team_resume is recorded like every other action.
  await h.ended(h.send(a.id, call("team_hold", { to: "Lead B", reason: "first" })));
  const resume = h.send(a.id, call("team_resume", { to: "Lead B" }));
  await h.ended(resume);
  assert.ok(h.store.toolCalls(resume).some((c) => c.tool === "team_resume" && c.result === "Lead B is no longer on hold."));
  await h.ended(h.send(a.id, call("team_hold", { to: "Lead B", reason: "wait" })));
  // A team turn for B exists already (made just before the hold).
  const db = (h.store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => { lastInsertRowid: number | bigint } } } }).db;
  const id = Number(
    db
      .prepare("INSERT INTO console_messages (tab_id, from_agent, to_agent, kind, body, state, created_at) VALUES (?, ?, ?, 'send', 'queued before the hold', 'queued', ?)")
      .run(h.tab.id, a.id, b.id, Date.now()).lastInsertRowid,
  );
  const turn = h.store.deliver(h.worker.epoch!, b.id, [id], "Messages from your team (1):\n\n[1] From Lead A:\nqueued before the hold")!;
  // The owner's own message still reaches the held agent.
  const direct = h.send(b.id, "hello");
  await h.ended(direct);
  assert.equal(h.store.turn(direct)!.status, "done");
  // The team turn does not start; with nobody working to lift the hold,
  // the tab pauses.
  await h.until(() => h.store.pauseReason("tab", h.tab.id) !== null, "stalled");
  assert.match(h.store.pauseReason("tab", h.tab.id)!, /Lead B is on hold by Lead A \(wait\)/);
  assert.equal(h.store.turn(turn)!.status, "queued");
  // Lift ends the hold, and that pause ends with it.
  runCommand(h.store, { action: "releaseHold", holdId: h.store.holds(h.tab.id)[0].id });
  await h.ended(turn);
  assert.equal(h.store.pauseReason("tab", h.tab.id), null);
  assert.equal(h.store.turn(turn)!.status, "done");
  // B's uncommitted edit in A's claim (a shell write, a restart), committed
  // before its next turn: flagged.
  await h.ended(h.send(a.id, call("team_claim", { paths: ["shared.md", "src/**"], note: "A's notes" })));
  writeFileSync(join(h.store.agent(b.id)!.folder, "shared.md"), "B was here\n");
  mkdirSync(join(h.store.agent(b.id)!.folder, "src"), { recursive: true });
  writeFileSync(join(h.store.agent(b.id)!.folder, "src", `${TOKEN}.txt`), "x\n");
  await h.ended(h.send(b.id, call("team_pull", { from: "Lead A" })));
  await h.until(() => needsView(h.store).notices.some((n) => n.text.startsWith("Lead B changed shared.md, which Lead A has claimed")), "flagged");
  await h.until(() => needsView(h.store).notices.some((n) => n.text.startsWith("Lead B changed [a file whose name holds a credential]")), "flagged, redacted");
  assert.ok(needsView(h.store).notices.every((n) => !n.text.includes(TOKEN)));
});

test("team_pull: claimed paths it brings in are flagged (not the source's own); never from a Look only agent; a conflict on a credential-named file is abandoned", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const a = h.agent("Lead A");
  const b = h.agent("Lead B");
  const c = h.agent("Lead C");
  const look = h.agent("Reviewer", "look");
  await h.ready(a.id, b.id, c.id, look.id);
  for (const id of [a.id, b.id]) writeFileSync(join(h.store.agent(id)!.folder, ".git", "info", "exclude"), "args.jsonl\nenv.json\n");
  await h.ended(h.send(c.id, call("team_claim", { paths: ["c.md"], note: "C's file" })));
  await h.ended(h.send(a.id, call("team_claim", { paths: ["a.md"], note: "A's file" })));
  await h.ended(h.send(a.id, "put c.md from A"));
  await h.ended(h.send(a.id, "put a.md from A"));
  await h.until(() => h.store.commits(a.id).some((x) => x.files.includes("a.md")), "A committed");
  await h.ended(h.send(b.id, call("team_pull", { from: "Lead A" })));
  assert.match(h.said(b.id).at(-1)!, /^team_pull: Merged/);
  await h.until(() => needsView(h.store).notices.some((n) => n.text.startsWith("Lead B changed c.md, which Lead C has claimed")), "flagged");
  assert.ok(!needsView(h.store).notices.some((n) => n.text.startsWith("Lead B changed a.md")));
  await h.ended(h.send(b.id, call("team_pull", { from: "Reviewer" })));
  assert.match(h.said(b.id).at(-1)!, /error: Reviewer does not edit code on a branch of its own/);
  // Both create a file named after a credential: the conflict list would
  // have to be stored, so the pull is abandoned.
  await h.ended(h.send(a.id, "put $TOKEN A"));
  await h.ended(h.send(b.id, "put $TOKEN B"));
  await h.until(() => h.store.commits(b.id).length >= 2, "B committed");
  const head = git(h.store.agent(b.id)!.folder, "rev-parse", "HEAD");
  await h.ended(h.send(b.id, call("team_pull", { from: "Lead A" })));
  assert.match(h.said(b.id).at(-1)!, /error: The merge conflicts in a file whose name holds a credential, so it was abandoned/);
  assert.equal(h.store.merging(b.id), null);
  assert.equal(git(h.store.agent(b.id)!.folder, "rev-parse", "HEAD"), head);
});

test("a commit the agent makes itself during its turn is checked against claims", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const a = h.agent("Lead A");
  const b = h.agent("Lead B");
  await h.ready(a.id, b.id);
  await h.ended(h.send(a.id, call("team_claim", { paths: ["owned.md"], note: "mine" })));
  await h.ended(h.send(b.id, "gitcommit owned.md"));
  await h.until(() => needsView(h.store).notices.some((n) => n.text.startsWith("Lead B changed owned.md, which Lead A has claimed")), "flagged");
});

test("a hold times out by itself", async (t) => {
  const h = await harness(t, { holdMs: 300 });
  await h.worker.start();
  const a = h.agent("Lead A");
  const b = h.agent("Lead B");
  await h.ready(a.id, b.id);
  await h.ended(h.send(a.id, call("team_hold", { to: "Lead B", reason: "brief" })));
  assert.ok(h.store.heldBy(h.store.agent(b.id)!));
  await h.until(() => h.store.heldBy(h.store.agent(b.id)!) === null, "timed out");
});

test("the coding team template: Orchestrator, two Leads and a Reviewer", async (t) => {
  const h = await harness(t);
  const { agents } = runCommand(h.store, { action: "createTeam", tabId: h.tab.id }) as { agents: { name: string; kind: string; permission: string; role: string }[] };
  assert.deepEqual(
    agents.map((a) => [a.name, a.kind, a.permission]),
    [
      ["Orchestrator", "claude-code", "look"],
      ["Lead A", "claude-code", "edit"],
      ["Lead B", "claude-code", "edit"],
      ["Reviewer", "codex", "look"],
    ],
  );
  assert.match(agents[0].role, /team_claim/);
  // A second team in the same tab gets distinct names.
  const again = runCommand(h.store, { action: "createTeam", tabId: h.tab.id }) as { agents: { name: string }[] };
  assert.deepEqual(again.agents.map((a) => a.name), ["Orchestrator 2", "Lead A 2", "Lead B 2", "Reviewer 2"]);
});
