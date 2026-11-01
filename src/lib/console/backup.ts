import { chmodSync, readdirSync, renameSync, rmSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { dirname, isAbsolute, join } from "node:path";
import { setting } from "../../config/server-env.ts";

// Nightly backups of the Console's store: once a night after 02:00 UTC (a
// failure retried hourly), a consistent SQLite snapshot beside the live
// file, copied under a temporary name and then renamed, 14 days kept. The
// key file is never backed up, and redaction keeps credentials out of the
// database.

export interface BackupSettings {
  /** The backup folder. */
  dir: string;
  keepDays: number;
}
/** CONSOLE_BACKUP_DIR; null: off. */
export function backupSettings(env: Record<string, string | undefined>): BackupSettings | null {
  const dir = setting(env, "CONSOLE_BACKUP_DIR")?.trim();
  if (!dir) return null;
  if (!isAbsolute(dir)) throw new Error("CONSOLE_BACKUP_DIR must be an absolute path.");
  return { dir, keepDays: 14 };
}

/** Once a night: after 02:00 UTC, when today's backup has not succeeded.
 * A failure is retried every hour, not on every check. */
export function backupDue(now: number, state: { succeededAt: number; failedAt: number }): boolean {
  const today = new Date(now).toISOString().slice(0, 10);
  if (new Date(now).getUTCHours() < 2) return false;
  if (new Date(state.succeededAt).toISOString().slice(0, 10) === today) return false;
  return now - state.failedAt >= 60 * 60_000;
}
/** `console-2026-10-16T0200Z.sqlite` (UTC). */
export function consoleBackupName(at: number): string {
  const iso = new Date(at).toISOString();
  return `console-${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z.sqlite`;
}
/** Backups older than the kept days, by the time in their names. */
export function expiredConsoleBackups(names: string[], now: number, keepDays: number): string[] {
  return names.filter((name) => {
    const match = /^console-(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})Z\.sqlite$/.exec(name);
    return !!match && now - Date.parse(`${match[1]}T${match[2]}:${match[3]}:00Z`) > keepDays * 24 * 60 * 60_000;
  });
}

/** A consistent copy of the store taken off the worker's event loop: a
 * worker thread opens its own read-only connection and runs VACUUM INTO,
 * so the tick, the MCP server and the agents' streams go on meanwhile. */
export function snapshotOffThread(storePath: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const thread = new Worker(
      `const { workerData, parentPort } = require("node:worker_threads");
       const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(workerData.src, { readOnly: true });
       try {
         db.exec("PRAGMA busy_timeout=5000");
         db.exec("VACUUM INTO '" + workerData.out.replace(/'/g, "''") + "'");
       } finally {
         db.close();
       }
       parentPort.postMessage("done");`,
      { eval: true, workerData: { src: storePath, out } },
    );
    let done = false;
    thread.once("message", () => (done = true));
    thread.once("error", reject);
    thread.once("exit", (code) => (done && code === 0 ? resolve() : reject(new Error(`The snapshot did not finish (exit ${code}).`))));
  });
}

export async function runConsoleBackup(storePath: string, settings: BackupSettings, now: number): Promise<string> {
  const snapshot = join(dirname(storePath), "console-backup-snapshot.sqlite");
  rmSync(snapshot, { force: true });
  for (const leftover of readdirSync(settings.dir))
    if (/^\.console-.+\.partial$/.test(leftover)) rmSync(join(settings.dir, leftover), { force: true });
  const name = consoleBackupName(now);
  const partial = join(settings.dir, `.${name}.partial`);
  try {
    await snapshotOffThread(storePath, snapshot);
    chmodSync(snapshot, 0o600);
    await copyFile(snapshot, partial);
    chmodSync(partial, 0o600);
    renameSync(partial, join(settings.dir, name));
  } finally {
    rmSync(snapshot, { force: true });
    rmSync(partial, { force: true });
  }
  for (const old of expiredConsoleBackups(readdirSync(settings.dir), now, settings.keepDays)) rmSync(join(settings.dir, old), { force: true });
  return name;
}
