import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../src/lib/console/commands.ts";
import { tmpKey, type CleanupDone, type CleanupItem } from "../src/lib/console/cleanup.ts";
import { harness } from "./helpers/console-harness.ts";

// the owner-run folder cleanup. The
// worker lists, measures and removes as the agent user, never following a
// link, never touching an open agent, and warns about unpushed commits.

test("the cleanup lists only what nothing open uses, warns about lost commits, and removes only what was chosen", async (t) => {
  const h = await harness(t);
  await h.worker.start();
  const lead = h.agent("Lead");
  const old = h.agent("Old");
  await h.ready(lead.id, old.id);
  const turn = h.send(old.id, "write work.txt");
  await h.ended(turn);
  await h.until(() => !!h.store.turn(turn)!.commitAfter, "committed");
  runCommand(h.store, { action: "close", agentId: old.id });
  await h.until(() => h.worker.runningCount() === 0, "closed");
  const work = join(h.agentHome, "work", h.project.id);
  // A removed project's folders, a link, stale and live temporary folders,
  // and the shared folder's leftovers.
  mkdirSync(join(h.agentHome, "work", "p000000000099", "a000000000099"), { recursive: true });
  writeFileSync(join(h.agentHome, "work", "p000000000099", "a000000000099", "x.txt"), "x".repeat(5000));
  mkdirSync(join(h.root, "elsewhere"));
  writeFileSync(join(h.root, "elsewhere", "keep.txt"), "keep");
  symlinkSync(join(h.root, "elsewhere"), join(work, "a0000000000aa"));
  const stale = `.tmp/${"0".repeat(32)}`;
  mkdirSync(join(h.agentHome, stale), { recursive: true });
  const live = tmpKey(h.store.agent(lead.id)!.folder);
  mkdirSync(join(h.agentHome, live), { recursive: true });
  writeFileSync(join(h.shared, "a000000000077.json"), "{}");
  writeFileSync(join(h.shared, "review-x.bundle"), "b");
  const hour = Date.now() / 1000 - 2 * 3600;
  utimesSync(join(h.shared, "review-x.bundle"), hour, hour);
  writeFileSync(join(h.shared, "review-new.bundle"), "b");

  const wait = async (id: number) => {
    await h.until(() => ["done", "failed"].includes(h.store.cleanup(id)!.state), "cleanup");
    const c = h.store.cleanup(id)!;
    assert.equal(c.state, "done", JSON.stringify(c.result));
    return c.result;
  };
  const scan = async () => {
    const { cleanupId } = runCommand(h.store, { action: "cleanupScan" }) as { cleanupId: number };
    return ((await wait(cleanupId)) as { items: CleanupItem[] }).items;
  };
  // A closed agent's folder is left alone until its process has exited.
  let items = await scan();
  for (let i = 0; i < 50 && !items.some((x) => x.key.endsWith(old.id)); i++) {
    await new Promise((r) => setTimeout(r, 100));
    items = await scan();
  }
  const keys = items.map((i) => i.key).sort();
  assert.deepEqual(keys, [
    stale,
    "shared/a000000000077.json",
    "shared/review-x.bundle",
    "work/p000000000099",
    `work/${h.project.id}/${old.id}`,
  ].sort());
  const closed = items.find((i) => i.key === `work/${h.project.id}/${old.id}`)!;
  assert.match(closed.what, /^Old's folder \(closed\)/);
  assert.equal(closed.warning, "1 commit exists only in this folder.");
  // A removed project's clones cannot be checked: warned (listed unticked).
  assert.match(items.find((i) => i.key === "work/p000000000099")!.warning!, /cannot tell whether its 1 folder hold work that was never pushed/);
  assert.ok(items.find((i) => i.key === "work/p000000000099")!.sizeKb! >= 4);

  // Changes never committed (a failed commit, a restart) are warned too.
  writeFileSync(join(work, old.id, "loose.txt"), "not committed\n");
  const rescan = runCommand(h.store, { action: "cleanupScan" }) as { cleanupId: number };
  const after = ((await wait(rescan.cleanupId)) as { items: CleanupItem[] }).items;
  assert.equal(after.find((i) => i.key === `work/${h.project.id}/${old.id}`)!.warning, "1 commit exists only in this folder. It has changes that were never committed.");
  // Remove: what is still listed goes; an open agent's folder, a link and
  // anything not listed are left alone.
  const removed = runCommand(h.store, {
    action: "cleanupDelete",
    keys: [...keys, `work/${h.project.id}/${lead.id}`, `work/${h.project.id}/a0000000000aa`, "work/../etc"],
  }) as { cleanupId: number };
  const done = (await wait(removed.cleanupId)) as CleanupDone;
  assert.deepEqual(done.removed.sort(), keys);
  assert.deepEqual(done.skipped.map((s) => s.key).sort(), [`work/${h.project.id}/${lead.id}`, `work/${h.project.id}/a0000000000aa`, "work/../etc"].sort());
  assert.equal(existsSync(join(work, old.id)), false);
  assert.equal(existsSync(join(h.agentHome, "work", "p000000000099")), false);
  assert.equal(existsSync(join(h.agentHome, stale)), false);
  assert.ok(existsSync(join(h.agentHome, live)));
  assert.ok(existsSync(h.store.agent(lead.id)!.folder));
  assert.ok(existsSync(join(h.root, "elsewhere", "keep.txt")));
  assert.ok(existsSync(join(h.shared, "review-new.bundle")));
  assert.ok(existsSync(join(h.shared, `${h.project.id}.bundle`)));
  // Nothing left to clean.
  const again = runCommand(h.store, { action: "cleanupScan" }) as { cleanupId: number };
  assert.deepEqual(((await wait(again.cleanupId)) as { items: CleanupItem[] }).items, []);
  assert.throws(() => runCommand(h.store, { action: "cleanupDelete", keys: [] }), /Choose what to remove/);
});
