import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConsoleStore } from "../src/lib/console/store.ts";

// Review C-8: `get`, `all`, `run` and `insert` prepare each query once and
// reuse it. A reused statement must read what was written since, roll back
// with its transaction, and not outlive its connection.

const COUNT = "SELECT count(*) AS n FROM console_flags";
const FLAGS = "SELECT key FROM console_flags ORDER BY key";
const ADD = "INSERT INTO console_flags (key, value) VALUES (?, ?)";

test("a cached statement sees rows written after it was first used", () => {
  const store = new ConsoleStore(":memory:");
  assert.equal(store.get(COUNT)?.n, 0);
  assert.deepEqual(store.all(FLAGS), []);
  store.insert(ADD, "a", "1");
  store.insert(ADD, "b", "2");
  assert.equal(store.get(COUNT)?.n, 2);
  assert.deepEqual(store.all(FLAGS).map((r) => r.key), ["a", "b"]);
  assert.equal(store.run("DELETE FROM console_flags WHERE key = ?", "a"), 1);
  assert.equal(store.run("DELETE FROM console_flags WHERE key = ?", "a"), 0);
  assert.equal(store.get(COUNT)?.n, 1);
  store.close();
});

test("inside a transaction: its writes are seen, and a rollback undoes them", () => {
  const store = new ConsoleStore(":memory:");
  store.transaction(() => {
    store.insert(ADD, "a", "1");
    assert.equal(store.get(COUNT)?.n, 1);
  });
  assert.throws(() =>
    store.transaction(() => {
      store.insert(ADD, "b", "2");
      assert.equal(store.get(COUNT)?.n, 2);
      throw new Error("undo");
    }),
  );
  assert.deepEqual(store.all(FLAGS).map((r) => r.key), ["a"]);
  store.close();
});

test("closed and opened again, the same file's queries are prepared afresh", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "console-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "console.sqlite");
  const first = new ConsoleStore(path);
  first.insert(ADD, "a", "1");
  first.close();
  assert.throws(() => first.get(COUNT));
  const second = new ConsoleStore(path);
  second.insert(ADD, "b", "2");
  assert.equal(second.get(COUNT)?.n, 2);
  second.close();
});

test("many different queries (a varying list of ?s) keep working past the cache's size", () => {
  const store = new ConsoleStore(":memory:");
  for (let i = 0; i < 600; i++) store.insert(ADD, `k${i}`, "v");
  for (let n = 1; n <= 600; n++) {
    const keys = Array.from({ length: n }, (_, i) => `k${i}`);
    assert.equal(store.get(`SELECT count(*) AS n FROM console_flags WHERE key IN (${keys.map(() => "?").join(", ")})`, ...keys)?.n, n);
  }
  assert.equal(store.get(COUNT)?.n, 600);
  store.close();
});
