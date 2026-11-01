import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonLog, parseLog, readLog } from "../src/lib/console/log.ts";

// The worker's log: JSON lines, masked, rotated by size.

const dir = () => mkdtempSync(join(tmpdir(), "console-log-"));
const KEY = `sk-proj-${"Ab3".repeat(10)}`;

test("each entry is one JSON line with its time; key shapes are masked", () => {
  const d = dir();
  try {
    const file = join(d, "logs", "console.jsonl");
    const log = jsonLog(file, 1_000_000, () => Date.UTC(2026, 9, 25, 12));
    log("worker started");
    log(`diff refresh failed: ${KEY}`);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.deepEqual(JSON.parse(lines[0]), { t: "2026-10-25T12:00:00.000Z", msg: "worker started" });
    assert.ok(!lines[1].includes(KEY));
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("at its size limit the file rotates into .1; the page reads both, newest last, up to its limit", () => {
  const d = dir();
  try {
    const file = join(d, "console.jsonl");
    const log = jsonLog(file, 200);
    for (let i = 0; i < 30; i++) log(`entry ${i}`);
    assert.ok(statSync(`${file}.1`).size >= 200);
    const all = readLog(file).map((e) => e.msg);
    assert.equal(all.at(-1), "entry 29");
    assert.ok(all.length < 30, "only the current and one older file are kept");
    assert.deepEqual(readLog(file, 2).map((e) => e.msg), ["entry 28", "entry 29"]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("what the page reads is masked again, and anything that is not an entry is skipped", () => {
  const d = dir();
  try {
    const file = join(d, "console.jsonl");
    writeFileSync(file, `not json\n${JSON.stringify({ t: "x", msg: `old ${KEY}` })}\n{"t":1}\n`);
    const entries = readLog(file);
    assert.equal(entries.length, 1);
    assert.ok(!entries[0].msg.includes(KEY));
    assert.deepEqual(parseLog('{"t":"a","msg":"b"}\npartial{'), [{ t: "a", msg: "b" }]);
    assert.deepEqual(readLog(join(d, "missing.jsonl")), []);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a write that fails is dropped without stopping the worker", () => {
  const d = dir();
  try {
    const file = join(d, "console.jsonl");
    const log = jsonLog(file);
    rmSync(d, { recursive: true, force: true });
    assert.doesNotThrow(() => log("into a removed folder"));
    // A folder that cannot be made (a file is in its way): no throw at all.
    writeFileSync(join(tmpdir(), `console-log-file-${process.pid}`), "");
    assert.doesNotThrow(() => jsonLog(join(tmpdir(), `console-log-file-${process.pid}`, "logs", "c.jsonl"))("x"));
    rmSync(join(tmpdir(), `console-log-file-${process.pid}`), { force: true });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
