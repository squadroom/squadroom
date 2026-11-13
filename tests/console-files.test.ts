import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runCommand } from "../src/lib/console/commands.ts";
import { agentFilePath, checkUpload, fileKind, listedFiles, resolveAgentPath, resolveFromDocument, toolPaths, uploadsNote, UPLOADS_DIR } from "../src/lib/console/files.ts";
import { transcript } from "../src/lib/console/transcript.ts";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { Redactor } from "../src/lib/console/redact.ts";
import { TEXT_MAX_BYTES } from "../src/lib/console/files.ts";
import { harness, TOKEN } from "./helpers/console-harness.ts";

// The "not found" bug, the file panel and uploads.

const FOLDER = "/Users/agent/work/p7902b5de9893/aff144ea02543";

test("regression: an agent's link to its own file opens it instead of navigating (the owner's not found)", () => {
  // The exact link Codex wrote in the owner's test.
  assert.equal(resolveAgentPath(FOLDER, `${FOLDER}/notes.md`), "notes.md");
  assert.equal(resolveAgentPath(FOLDER, `file://${FOLDER}/src/a%20b.ts#L12`), "src/a b.ts");
  assert.equal(resolveAgentPath(FOLDER, "src/app.ts:40:2"), "src/app.ts");
  assert.equal(resolveAgentPath(FOLDER, "./README.md"), "README.md");
  for (const bad of ["https://example.com/x", "/Users/agent/work/p7902b5de9893/other/notes.md", "../x", `${FOLDER}/../x`, "#top", "", FOLDER, "mailto:x@y", "vscode://file/x", "ftp://h/x", "x-app:notes.md", "blob:abc"])
    assert.equal(resolveAgentPath(FOLDER, bad), null, bad);
});

test("file kinds, change lists, tool rows, upload names and the upload note", () => {
  assert.deepEqual(fileKind("notes.md"), { kind: "markdown", language: "markdown", mime: "text/markdown" });
  assert.equal(fileKind("a/b.ts").language, "typescript");
  assert.equal(fileKind("p.PNG").kind, "image");
  assert.equal(fileKind("a.bin").kind, "other");
  // A link's query and fragment are not part of the name; web links are not files.
  assert.equal(resolveAgentPath(FOLDER, "README.md#installation"), "README.md");
  assert.equal(resolveAgentPath(FOLDER, "report.csv?raw=1"), "report.csv");
  assert.equal(resolveAgentPath(FOLDER, "//example.com/docs"), null);
  // Exact paths (Git, file tools) are names, not links: nothing is cut or decoded.
  for (const name of ["notes#draft.md", "report?raw.md", "file:part.md", "source.ts:12", "100%25.md"])
    assert.equal(agentFilePath(FOLDER, name), name);
  assert.equal(agentFilePath(FOLDER, `${FOLDER}/a#b.md`), "a#b.md");
  for (const bad of ["../x", `${FOLDER}/../x`, "/etc/hosts", "", "a\0b"]) assert.equal(agentFilePath(FOLDER, bad), null, bad);
  // Links inside a shown document resolve against its own folder.
  assert.equal(resolveFromDocument(FOLDER, "docs/a.md", "../b.md"), "b.md");
  assert.equal(resolveFromDocument(FOLDER, "docs/a.md", "c.md#x"), "docs/c.md");
  assert.equal(resolveFromDocument(FOLDER, "docs/a.md", `${FOLDER}/d.md`), "d.md");
  for (const bad of ["../../x.md", "https://example.com", "#top", "//example.com/x", "/etc/hosts"])
    assert.equal(resolveFromDocument(FOLDER, "docs/a.md", bad), null, bad);
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `f${i}.txt`, size: 1 }));
  assert.match(uploadsNote(many), /^The owner uploaded 25 files to your folder:\n(- \.console-uploads\/f\d+\.txt \(1 B\)\n){20}- and 5 more in \.console-uploads\/\n\n$/);
  assert.deepEqual(toolPaths("Edit", "/w/a.ts, /w/b.ts"), ["/w/a.ts", "/w/b.ts"]);
  assert.deepEqual(toolPaths("Shell", "ls"), []);
  assert.deepEqual(checkUpload("C:\\x\\My Notes.md", 10), { ok: true, name: "My Notes.md" });
  for (const [name, size] of [[".env", 1], ["x.exe", 1], ["a/../b", 1], ["big.png", 11 * 1024 * 1024], ["", 1]] as const)
    assert.equal(checkUpload(name, size).ok, false, name);
  assert.equal(uploadsNote([]), "");
  assert.match(uploadsNote([{ name: "a.png", size: 2048 }]), /^The owner uploaded a file to your folder:\n- \.console-uploads\/a\.png \(2\.0 KB\)\n\n$/);
});

test("the file panel reads as the agent, inside its folder only: markdown, images, redaction, links refused", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  await h.ready(lead.id);
  const folder = h.store.agent(lead.id)!.folder;
  await h.ended(h.send(lead.id, "write notes.md"));
  const read = async (path: string) => {
    const { readId } = runCommand(h.store, { action: "readFile", agentId: lead.id, path }) as { readId: number };
    await h.until(() => h.store.fileRead(readId)?.state === "done", "read");
    return h.store.fileRead(readId)!.result as { kind: string; text?: string; base64?: string; message?: string; path: string };
  };
  const notes = await read(`${folder}/notes.md`);
  assert.equal(notes.kind, "markdown");
  // The folder's files, to open from the panel: as it is now,
  // committed or not, documents first; nothing Git ignores.
  writeFileSync(join(folder, "draft.md"), "# Draft\n");
  writeFileSync(join(folder, "a.txt"), "a\n");
  writeFileSync(join(folder, ".gitignore"), "ignored.md\n");
  writeFileSync(join(folder, "ignored.md"), "x\n");
  const { readId: listId } = runCommand(h.store, { action: "listFiles", agentId: lead.id }) as { readId: number };
  await h.until(() => h.store.fileRead(listId)?.state === "done", "list");
  const list = h.store.fileRead(listId)!.result as { kind: string; path: string; files: string[]; truncated: boolean };
  assert.deepEqual([list.kind, list.path, list.truncated], ["folder", ".", false]);
  assert.deepEqual(list.files.slice(0, 2), ["draft.md", "notes.md"]);
  assert.ok(list.files.includes("a.txt") && !list.files.includes("ignored.md"));
  assert.match(notes.text!, /^written by claude/);
  writeFileSync(join(folder, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  const pic = await read("pic.png");
  assert.equal(pic.kind, "image");
  assert.deepEqual([...Buffer.from(pic.base64!, "base64")], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
  await h.ended(h.send(lead.id, "leak secret.txt"));
  assert.match((await read("secret.txt")).text!, /\[redacted …ABCD\]/);
  assert.doesNotMatch((await read("secret.txt")).text!, new RegExp(TOKEN));
  // A changed file whose name holds a credential is left out of the lists.
  await h.ended(h.send(lead.id, `write ${TOKEN}.txt`));
  await h.ended(h.send(lead.id, "write marker.txt"));
  await h.until(() => h.store.commits(lead.id).some((c) => c.files.includes("marker.txt")), "committed");
  assert.ok(h.store.commits(lead.id).some((c) => c.stat.includes("redacted")));
  assert.ok(h.store.commits(lead.id).every((c) => c.files.every((f) => !f.includes(TOKEN))));
  // A link planted in the folder is not followed; outside paths never queue.
  const other = h.agent("Other");
  await h.ready(other.id);
  writeFileSync(join(h.store.agent(other.id)!.folder, "private.txt"), "theirs");
  symlinkSync(join(h.store.agent(other.id)!.folder, "private.txt"), join(folder, "link.txt"));
  assert.equal((await read("link.txt")).kind, "error");
  assert.equal((await read("missing.md")).message, "That file does not exist (any more).");
  assert.throws(() => runCommand(h.store, { action: "readFile", agentId: lead.id, path: join(h.store.agent(other.id)!.folder, "private.txt") }), /not a file in this agent's folder/);
  assert.throws(() => runCommand(h.store, { action: "readFile", agentId: lead.id, path: "../x" }), /not a file/);
  // Binary content is never stored unredacted: a credential refuses it.
  writeFileSync(join(folder, "dump.bin"), Buffer.concat([Buffer.from([0]), Buffer.from(TOKEN)]));
  assert.match((await read("dump.bin")).message!, /holds a credential/);
  // A credential across the panel's cut is masked whole, never shown in part.
  writeFileSync(join(folder, "long.txt"), `${"a".repeat(TEXT_MAX_BYTES - 10)}${TOKEN}\n${"b".repeat(9000)}`);
  const long = (await read("long.txt")) as { text?: string; truncated?: boolean; size?: number };
  assert.equal(long.truncated, true);
  assert.equal(long.size, TEXT_MAX_BYTES - 10 + TOKEN.length + 9001);
  assert.ok(!long.text!.includes(TOKEN.slice(0, 8)), "no part of the credential");
  writeFileSync(join(folder, "odd.txt"), Buffer.from([0x61, 0, 0x62]));
  assert.match((await read("odd.txt")).message!, /binary content/);
});

test("uploads land in the agent's folder as the agent, are announced with the next prompt, never replace silently, never committed", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  await h.ready(lead.id);
  const folder = h.store.agent(lead.id)!.folder;
  const staging = mkdtempSync(join(tmpdir(), "console-staging-"));
  t.after(() => rmSync(staging, { recursive: true, force: true }));
  const stage = (content: string) => {
    const path = join(staging, `s-${Math.random()}`);
    writeFileSync(path, content);
    return path;
  };
  const place = async (content: string, replace = false) => {
    const id = h.store.queueUpload({ agentId: lead.id, name: "brief.md", size: content.length, staged: stage(content), replace });
    await h.until(() => !["queued", "running"].includes(h.store.upload(id)!.state), "upload placed");
    return h.store.upload(id)!;
  };
  const first = await place("# Brief\n");
  assert.equal(first.state, "done", first.message ?? "");
  assert.equal(readFileSync(join(folder, UPLOADS_DIR, "brief.md"), "utf8"), "# Brief\n");
  assert.equal(first.staged, "");
  assert.ok(transcript(h.events(lead.id)).some((b) => b.type === "upload" && b.path === `${UPLOADS_DIR}/brief.md`));
  // The next prompt says what arrived and where.
  const turn = h.send(lead.id, "look at it");
  await h.ended(turn);
  assert.match(h.said(lead.id).at(-1)!, /^echo: The owner uploaded a file to your folder:\n- \.console-uploads\/brief\.md \(8 B\)\n\nlook at it$/);
  // Told once only.
  await h.ended(h.send(lead.id, "again"));
  assert.equal(h.said(lead.id).at(-1), "echo: again");
  // Same name: refused unless replacing.
  const again = await place("# New\n");
  assert.equal(again.state, "exists");
  assert.equal(readFileSync(join(folder, UPLOADS_DIR, "brief.md"), "utf8"), "# Brief\n");
  assert.equal((await place("# New\n", true)).state, "done");
  assert.equal(readFileSync(join(folder, UPLOADS_DIR, "brief.md"), "utf8"), "# New\n");
  // A link planted at the name is never written through.
  writeFileSync(join(folder, "keep.txt"), "untouched\n");
  symlinkSync(join(folder, "keep.txt"), join(folder, UPLOADS_DIR, "link.md"));
  const linked = async (replace: boolean) => {
    const id = h.store.queueUpload({ agentId: lead.id, name: "link.md", size: 2, staged: stage("hi"), replace });
    await h.until(() => !["queued", "running"].includes(h.store.upload(id)!.state), "placed");
    return h.store.upload(id)!;
  };
  assert.equal((await linked(false)).state, "exists");
  assert.equal((await linked(true)).state, "done");
  assert.equal(readFileSync(join(folder, "keep.txt"), "utf8"), "untouched\n");
  assert.equal(readFileSync(join(folder, UPLOADS_DIR, "link.md"), "utf8"), "hi");
  // Two uploads of one new name at once: one lands, the other is refused.
  const a = h.store.queueUpload({ agentId: lead.id, name: "twin.md", size: 1, staged: stage("A"), replace: false });
  const b = h.store.queueUpload({ agentId: lead.id, name: "twin.md", size: 1, staged: stage("B"), replace: false });
  await h.until(() => [a, b].every((id) => !["queued", "running"].includes(h.store.upload(id)!.state)), "both placed");
  assert.deepEqual([h.store.upload(a)!.state, h.store.upload(b)!.state].sort(), ["done", "exists"]);
  // Every outcome removes the staged copy.
  assert.deepEqual(readdirSync(staging), []);
  // An upload the agent staged itself is still never committed.
  execFileSync("git", ["add", "-f", `${UPLOADS_DIR}/brief.md`], { cwd: folder, env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null" } as Record<string, string> as NodeJS.ProcessEnv });
  writeFileSync(join(folder, UPLOADS_DIR, "brief.md"), "# Changed after staging\n");
  // The notice of new uploads rides this prompt; the commit is titled by
  // the owner's own words.
  await h.ended(h.send(lead.id, "write more.txt"));
  assert.equal(h.said(lead.id).at(-1), "wrote more.txt");
  await h.until(() => h.store.commits(lead.id).some((c) => c.files.includes("more.txt")), "committed");
  // Uploads are inputs, not the agent's work: never committed.
  const log = execFileSync("git", ["log", "--all", "--name-only", "--format="], { cwd: folder, encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null" } as Record<string, string> as NodeJS.ProcessEnv });
  assert.doesNotMatch(log, /console-uploads/);
  const messages = execFileSync("git", ["log", "--all", "--format=%B"], { cwd: folder, encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null" } as Record<string, string> as NodeJS.ProcessEnv });
  assert.match(messages, /Request:\nwrite more\.txt\n/);
  assert.doesNotMatch(messages, /Request:\nThe owner uploaded/);
  assert.ok(existsSync(join(folder, UPLOADS_DIR)));
});

test("the panel's cut never shows part of a credential", () => {
  const r = new Redactor();
  const secret = "sk-live-0123456789abcdefXYZW";
  r.add(secret);
  // Masked whole when read past the cut.
  assert.equal(r.cut(`abc${secret}def`, 8).text, "abc[reda");
  // A start of one at the cut is dropped (handed-out value or key shape).
  const other = new Redactor();
  other.add("TOKENVALUE-123456789");
  assert.deepEqual(other.cut("hello TOKENVALUE-1 and more text", 16), { text: "hello ", truncated: true });
  assert.equal(new Redactor().cut("key: ghp_abcdefghij", 15).text, "key: ");
  assert.deepEqual(new Redactor().cut("short", 100), { text: "short", truncated: false });
});

test("reads expire while polled, claims stay within the worker's capacity", () => {
  const dir = mkdtempSync(join(tmpdir(), "console-reads-"));
  try {
    let now = 1_000_000;
    const store = new ConsoleStore(join(dir, "console.sqlite"), () => now);
    const epoch = store.takeLease("t", now)!;
    const ids = Array.from({ length: 5 }, (_, i) => store.queueRead("a000000000001", `f${i}.md`));
    assert.equal(store.claimReads(epoch, 0).length, 0);
    assert.equal(store.claimReads(epoch, 2).length, 2);
    now += 16 * 60_000;
    assert.equal(store.fileRead(ids[4]), undefined);
    store.expireReads();
    assert.equal(store.claimReads(epoch, 8).length, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("after a restart, an interrupted upload's leftovers are removed", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  await h.ready(lead.id);
  const folder = h.store.agent(lead.id)!.folder;
  // Land one upload, so the uploads folder exists.
  const staged = join(h.root, "staged");
  writeFileSync(staged, "x");
  const id = h.store.queueUpload({ agentId: lead.id, name: "a.txt", size: 1, staged, replace: false });
  await h.until(() => h.store.upload(id)!.state === "done", "placed");
  await h.worker.stop();
  writeFileSync(join(h.shared, "upload-9-abcdef"), "left");
  writeFileSync(join(folder, UPLOADS_DIR, ".upload-0123abcd"), "left");
  // Owner staging: an old file no upload refers to goes; a fresh one stays
  // (it may be about to be queued).
  const staging = join(h.root, "staging");
  mkdirSync(staging);
  const old = join(staging, `${Date.now() - 2 * 60 * 60_000}-0123456789abcdef`);
  const fresh = join(staging, `${Date.now()}-0123456789abcdef`);
  writeFileSync(old, "x");
  writeFileSync(fresh, "x");
  const { ConsoleWorker } = await import("../src/lib/console/worker.ts");
  const { Launcher } = await import("../src/lib/console/launcher.ts");
  const next = new ConsoleWorker({
    store: h.store,
    launcher: new Launcher({ command: [join(h.root, "launcher")] }),
    paths: { agentHome: h.agentHome, shared: h.shared },
    keysFile: join(h.root, "keys.json"),
    tickMs: 25,
    log: () => {},
    uploadsDir: staging,
  });
  await next.start();
  assert.deepEqual([existsSync(old), existsSync(fresh)], [false, true]);
  assert.equal(existsSync(join(h.shared, "upload-9-abcdef")), false);
  assert.deepEqual(readdirSync(join(folder, UPLOADS_DIR)), ["a.txt"]);
  await next.stop();
});

test("uploads never follow a linked uploads folder; files the repository tracks there are kept; uploaded files open in the panel", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent();
  const other = h.agent("Other");
  await h.ready(lead.id);
  await h.ready(other.id);
  const folder = h.store.agent(lead.id)!.folder;
  const elsewhere = h.store.agent(other.id)!.folder;
  const env = { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@y", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@y" } as Record<string, string> as NodeJS.ProcessEnv;
  const place = async (agentId: string, name: string) => {
    const staged = join(h.root, `s-${Math.random()}`);
    writeFileSync(staged, "hi");
    const id = h.store.queueUpload({ agentId, name, size: 2, staged, replace: false });
    await h.until(() => !["queued", "running"].includes(h.store.upload(id)!.state), "placed");
    return h.store.upload(id)!;
  };
  // The uploads folder is a link into a teammate's folder: nothing is written.
  symlinkSync(elsewhere, join(folder, UPLOADS_DIR));
  const linked = await place(lead.id, "x.md");
  assert.equal(linked.state, "failed");
  assert.match(linked.message ?? "", /not a plain folder/);
  assert.equal(existsSync(join(elsewhere, "x.md")), false);
  rmSync(join(folder, UPLOADS_DIR));
  // A repository that already tracks a file there keeps it.
  mkdirSync(join(folder, UPLOADS_DIR));
  writeFileSync(join(folder, UPLOADS_DIR, "tracked.md"), "kept\n");
  execFileSync("git", ["add", "-f", `${UPLOADS_DIR}/tracked.md`], { cwd: folder, env });
  execFileSync("git", ["commit", "-q", "--no-verify", "-m", "tracked"], { cwd: folder, env });
  assert.equal((await place(lead.id, "new.md")).state, "done");
  await h.ended(h.send(lead.id, "write work.txt"));
  await h.until(() => h.store.commits(lead.id).some((c) => c.files.includes("work.txt")), "committed");
  const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: folder, encoding: "utf8", env });
  assert.match(tracked, /\.console-uploads\/tracked\.md/);
  assert.doesNotMatch(tracked, /new\.md/);
  // A file whose name looks like a link part opens by its exact name.
  writeFileSync(join(folder, "notes#draft.md"), "exact\n");
  const exact = runCommand(h.store, { action: "readFile", agentId: lead.id, path: "notes#draft.md" }) as { readId: number };
  await h.until(() => h.store.fileRead(exact.readId)?.state === "done", "read");
  assert.equal((h.store.fileRead(exact.readId)!.result as { text?: string }).text, "exact\n");
  // An uploaded file opens in the panel (read as the agent).
  const { readId } = runCommand(h.store, { action: "readFile", agentId: lead.id, path: `${UPLOADS_DIR}/new.md` }) as { readId: number };
  await h.until(() => h.store.fileRead(readId)?.state === "done", "read");
  assert.equal((h.store.fileRead(readId)!.result as { text?: string }).text, "hi");
});

test("a folder's listing: documents first, each by path, no duplicates; never a file's path", () => {
  assert.deepEqual(listedFiles("src/b.ts\0README.md\0adrs/001.md\0a.txt\0README.md\0"), ["adrs/001.md", "README.md", "a.txt", "src/b.ts"]);
  assert.deepEqual(listedFiles(""), []);
  // Output cut at the limit: the unfinished last path is not a path.
  assert.deepEqual(listedFiles("a.md\0b/SECRET_TOK"), ["a.md"]);
  assert.deepEqual(listedFiles("SECRET_TOK"), []);
  assert.equal(agentFilePath("/work/a", "."), null);
});
