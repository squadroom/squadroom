import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Redactor } from "./redact.ts";

// The Console worker's log: one JSON line per entry,
// `{"t":"<ISO time>","msg":"…"}`, key shapes masked on the way in (the
// worker has already masked every credential value it knows) and again on
// the way out. At its size limit the file becomes `<file>.1`, replacing
// the one before, so at most twice the limit is kept.

const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** How much of each file the Logs page reads: its latest entries. */
const TAIL_BYTES = 512 * 1024;

export interface LogEntry {
  t: string;
  msg: string;
}

/** A writer for `file`; a failed write is dropped (logging never stops
 * the worker). */
export function jsonLog(file: string, maxBytes = LOG_MAX_BYTES, now: () => number = Date.now): (msg: string) => void {
  const redactor = new Redactor();
  return (msg) => {
    try {
      // Made at the first write: a folder that cannot be made loses the
      // entry, never the worker's start.
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        // No file yet.
      }
      if (size >= maxBytes) renameSync(file, `${file}.1`);
      appendFileSync(file, `${JSON.stringify({ t: new Date(now()).toISOString(), msg: redactor.text(msg) })}\n`, { mode: 0o600 });
    } catch {
      // A full disk or a removed folder: the entry is lost, not the worker.
    }
  };
}

/** Entries from JSON lines (pure): anything else is skipped, as is a line
 * cut at the start of a read. */
export function parseLog(text: string): LogEntry[] {
  return text.split("\n").flatMap((line) => {
    try {
      const e = JSON.parse(line) as Partial<LogEntry>;
      return typeof e?.t === "string" && typeof e.msg === "string" ? [{ t: e.t, msg: e.msg }] : [];
    } catch {
      return [];
    }
  });
}

function tail(file: string): string {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const size = statSync(file).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The latest `limit` entries, oldest first, from the file and the one it
 * rotated into; masked again for the page. */
export function readLog(file: string, limit = 500): LogEntry[] {
  const redactor = new Redactor();
  return [...parseLog(tail(`${file}.1`)), ...parseLog(tail(file))].slice(-limit).map((e) => ({ t: e.t, msg: redactor.text(e.msg) }));
}
