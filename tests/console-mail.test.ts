import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { backupFailedKey, renderConsoleMail } from "../src/lib/console/mail.ts";
import { workerEnv } from "../src/lib/console/worker-env.ts";
import { backupSettings } from "../src/lib/console/backup.ts";
import { queueLockoutEmail } from "../src/lib/console/web.ts";
import { idempotencyKey, mailSettings, RETRY_WINDOW_MS, type MailSettings } from "../src/lib/shared/mail.ts";
import { harness } from "./helpers/console-harness.ts";

// the Console's e-mail queue, its delivery by the Console worker
// and its two templates. A fake fetch; no request leaves the process.

const RESEND_KEY = "re_fakeResendKey0123456789WXYZ";
const mail: MailSettings = { apiKey: RESEND_KEY, from: "console@example.test", to: "owner@example.test", origin: "https://console.example" };

/** A fake Resend: answers with the given statuses in turn (then 200). */
function fakeResend(statuses: number[] = []) {
  const sent: { key: string | null; subject: string; text: string; auth: string | null }[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as { subject: string; text: string };
    sent.push({ key: headers.get("Idempotency-Key"), subject: body.subject, text: body.text, auth: headers.get("Authorization") });
    return new Response(null, { status: statuses.shift() ?? 200 });
  }) as typeof fetch;
  return { fetcher, sent };
}

async function mailHarness(t: TestContext, statuses: number[] = [], options = {}) {
  const resend = fakeResend(statuses);
  // Delivery is driven by the test (deliverEmail), not the timer.
  const h = await harness(t, {}, false, { options: { mail, mailFetch: resend.fetcher, mailCheckMs: 3_600_000, ...options } });
  return { ...h, resend };
}

test("one row per incident: a repeated key adds nothing", () => {
  const store = new ConsoleStore(":memory:");
  store.enqueueMail("signin_locked:5", { kind: "signin_locked", minutes: 15 }, 10);
  store.enqueueMail("signin_locked:5", { kind: "signin_locked", minutes: 30 }, 20);
  const rows = store.mailRows();
  assert.deepEqual(rows.map((r) => [r.key, r.mail, r.status, r.attempts, r.createdAt]), [["signin_locked:5", { kind: "signin_locked", minutes: 15 }, "pending", 0, 10]]);
  assert.deepEqual(store.dueMail(9), []);
  assert.equal(store.dueMail(10).length, 1);
  store.close();
});

test("a failed backup is keyed by its UTC day: one e-mail a day", () => {
  const store = new ConsoleStore(":memory:");
  const night = Date.parse("2026-10-31T02:01:00Z");
  for (const at of [night, night + 3_600_000, night + 23 * 3_600_000]) store.enqueueMail(backupFailedKey(at), { kind: "backup_failed" }, at);
  assert.deepEqual(store.mailRows().map((r) => r.key), ["console_backup_failed:2026-10-31", "console_backup_failed:2026-11-01"]);
  store.close();
});

test("the templates: fixed wording and a link to the Console", () => {
  const locked = renderConsoleMail({ kind: "signin_locked", minutes: 15 }, "https://console.example");
  assert.equal(locked.subject, "Sign-in paused for 15 minutes after 5 wrong codes");
  assert.match(locked.text, /emergency sign-in on the server still works/);
  assert.match(locked.text, /Open Squadroom: https:\/\/console\.example\/console/);
  assert.match(locked.html, /<a href="https:\/\/console\.example\/console">/);
  const backup = renderConsoleMail({ kind: "backup_failed" }, null);
  assert.equal(backup.subject, "Squadroom backup failed");
  assert.doesNotMatch(backup.text, /https?:/);
});

test("a store at version 1 without the queue is upgraded in place", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "console-mail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "console.sqlite");
  const first = new ConsoleStore(path);
  first.createProject("Kept", "folder");
  first.close();
  const raw = new DatabaseSync(path);
  raw.exec("DROP TABLE console_mail; PRAGMA user_version = 1");
  raw.close();
  const store = new ConsoleStore(path);
  assert.deepEqual(store.projects().map((p) => p.name), ["Kept"]);
  store.enqueueMail("k", { kind: "backup_failed" }, 1);
  assert.equal(store.mailRows().length, 1);
  store.close();
  const after = new DatabaseSync(path);
  assert.equal(after.prepare("PRAGMA user_version").get()!.user_version, 4);
  after.close();
});

test("delivery: the same idempotency key on every attempt, backoff, then sent", async (t) => {
  const h = await mailHarness(t, [500]);
  await h.worker.start();
  const at = Date.now();
  h.store.enqueueMail("signin_locked:1", { kind: "signin_locked", minutes: 15 }, at);
  await h.worker.deliverEmail();
  let [row] = h.store.mailRows();
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 1);
  assert.equal(row.lastStatus, 500);
  assert.ok(row.nextAttemptAt >= at + 60_000 && row.nextAttemptAt <= Date.now() + 60_000);
  // Not due yet: nothing is sent.
  await h.worker.deliverEmail();
  assert.equal(h.resend.sent.length, 1);
  (h.store as unknown as { db: DatabaseSync }).db.prepare("UPDATE console_mail SET next_attempt_at = 0").run();
  await h.worker.deliverEmail();
  [row] = h.store.mailRows();
  assert.deepEqual([row.status, row.attempts], ["sent", 2]);
  assert.deepEqual(h.resend.sent.map((s) => s.key), [idempotencyKey("signin_locked:1"), idempotencyKey("signin_locked:1")]);
  assert.equal(h.resend.sent[0].auth, `Bearer ${RESEND_KEY}`);
});

test("delivery gives up after the 24-hour window without sending again; the Overview counts it", async (t) => {
  const { overviewView } = await import("../src/lib/console/overview.ts");
  const { healthWarnings } = await import("../src/lib/console/ui.ts");
  const h = await mailHarness(t);
  await h.worker.start();
  h.store.enqueueMail("old", { kind: "backup_failed" }, Date.now() - RETRY_WINDOW_MS);
  await h.worker.deliverEmail();
  assert.deepEqual(h.store.mailRows().map((r) => r.status), ["failed"]);
  assert.equal(h.resend.sent.length, 0);
  const view = overviewView(h.store, h.keysFile, Date.now());
  assert.equal(view.health.mailFailed, 1);
  assert.ok(healthWarnings(view.health, Date.now()).includes("1 e-mail not sent."));
});

test("the lockout: the web process queues it in the Console's store, the Console worker sends it", async (t) => {
  const h = await mailHarness(t);
  const state = globalThis as typeof globalThis & { consoleStore?: ConsoleStore };
  const previous = state.consoleStore;
  state.consoleStore = h.store;
  t.after(() => {
    state.consoleStore = previous;
  });
  queueLockoutEmail({ at: 5, minutes: 15 });
  queueLockoutEmail({ at: 5, minutes: 15 });
  assert.deepEqual(h.store.mailRows().map((r) => [r.key, r.mail]), [["signin_locked:5", { kind: "signin_locked", minutes: 15 }]]);
  await h.worker.start();
  await h.worker.deliverEmail();
  assert.equal(h.resend.sent.length, 1);
  assert.match(h.resend.sent[0].subject, /Sign-in paused for 15 minutes/);
  assert.match(h.resend.sent[0].text, /https:\/\/console\.example\/console/);
  assert.equal(h.store.mailRows()[0].status, "sent");
});

test("a failed Console backup queues one e-mail for the day and the worker sends it", async (t) => {
  // After 02:00 UTC, when a backup is due.
  const shift = new Date().getUTCHours() < 2 ? 3 * 3_600_000 : 0;
  const now = () => Date.now() + shift;
  const h = await mailHarness(t, [], { now, mailCheckMs: 30, backupCheckMs: 30, backup: { dir: "/nonexistent/console-backups", keepDays: 14 } });
  await h.worker.start();
  await h.until(() => h.store.mailRows().some((r) => r.status === "sent"), "the backup e-mail is sent");
  assert.deepEqual(h.store.mailRows().map((r) => r.key), [backupFailedKey(now())]);
  assert.equal(h.store.backupState().failedAt > 0, true);
  assert.deepEqual(h.resend.sent.map((s) => s.subject), ["Squadroom backup failed"]);
});

test("e-mail is off without its three settings; nothing is queued for a failed backup", async (t) => {
  assert.equal(mailSettings({ CONSOLE_RESEND_API_KEY: "k", CONSOLE_MAIL_FROM: "a@b.c" }), null);
  const resend = fakeResend();
  const shift = new Date().getUTCHours() < 2 ? 3 * 3_600_000 : 0;
  const h = await harness(t, {}, false, {
    options: { mail: null, mailFetch: resend.fetcher, now: () => Date.now() + shift, backupCheckMs: 30, backup: { dir: "/nonexistent/console-backups", keepDays: 14 } },
  });
  await h.worker.start();
  await h.until(() => h.store.backupState().failedAt > 0, "the backup fails");
  h.store.enqueueMail("signin_locked:1", { kind: "signin_locked", minutes: 15 }, Date.now());
  await h.worker.deliverEmail();
  assert.deepEqual(h.store.mailRows().map((r) => [r.key, r.status]), [["signin_locked:1", "pending"]]);
  assert.equal(resend.sent.length, 0);
});

test("the Resend key is masked in what the worker logs and stores", async (t) => {
  const h = await mailHarness(t);
  assert.equal(h.worker.redactor.text(`key=${RESEND_KEY}`), "key=[redacted …WXYZ]");
  assert.ok(h.worker.redactor.holdsSecret(`x ${RESEND_KEY}`));
});

test("the worker reads the backup folder and e-mail settings from the .env files, and nothing else", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "console-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const names = ["CONSOLE_BACKUP_DIR", "CONSOLE_RESEND_API_KEY", "CONSOLE_MAIL_FROM", "CONSOLE_NOTIFY_EMAIL", "SERVER_PUBLIC_ORIGIN", "CONSOLE_TEST_OTHER"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  t.after(() => {
    for (const n of names) if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  });
  process.env.CONSOLE_MAIL_FROM = "shell@example.test";
  writeFileSync(
    join(dir, ".env"),
    `CONSOLE_BACKUP_DIR=/backups\nCONSOLE_RESEND_API_KEY=${RESEND_KEY}\nCONSOLE_MAIL_FROM=file@example.test\nCONSOLE_NOTIFY_EMAIL=you@example.test\nSERVER_PUBLIC_ORIGIN=https://console.example\nCONSOLE_TEST_OTHER=secret\n`,
  );
  const env = workerEnv(dir);
  // The values survive the files' names being removed, and the process's
  // own environment wins.
  assert.deepEqual(env, {
    CONSOLE_BACKUP_DIR: "/backups",
    CONSOLE_RESEND_API_KEY: RESEND_KEY,
    CONSOLE_MAIL_FROM: "shell@example.test",
    CONSOLE_NOTIFY_EMAIL: "you@example.test",
    SERVER_PUBLIC_ORIGIN: "https://console.example",
  });
  for (const n of names.filter((n) => n !== "CONSOLE_MAIL_FROM")) assert.equal(process.env[n], undefined, n);
  assert.deepEqual(mailSettings(env), { apiKey: RESEND_KEY, from: "shell@example.test", to: "you@example.test", origin: "https://console.example" });
  assert.equal(backupSettings(env)!.dir, "/backups");
});
