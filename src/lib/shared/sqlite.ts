import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

// The local SQLite stores' shared handling (the Console's store and the
// sign-in's store): an owner-only file in an owner-only folder, WAL mode.

/** Opens (creating) the store: its folder 0700 and the file 0600, unless
 * in memory. */
export function openStoreDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  return db;
}

/** The busy wait first, then WAL mode. Two processes opening a new file at
 * once can still find the switch locked (SQLite does not always wait for
 * it), so it is tried again for up to the same 5 seconds. */
export function enableWal(db: DatabaseSync, timeoutMs = 5000) {
  db.exec(`PRAGMA busy_timeout=${timeoutMs}`);
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode=WAL");
      return;
    } catch (error) {
      if (!/locked|busy/i.test(String(error)) || Date.now() >= until) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
