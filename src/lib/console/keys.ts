import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { LauncherError } from "./launcher.ts";

// The owner's key file: `~/.squadroom/console-keys.json`, 0600 and owned
// by the worker's user, written by the Keys page
// (src/lib/console/keys-page.ts) or by hand. Read on every spawn, never
// logged.
//
//   {
//     "keys": {
//       "CLAUDE_CODE_OAUTH_TOKEN": { "value": "sk-ant-oat01-…" },
//       "CONSOLE_GIT_TOKEN": { "value": "github_pat_…" },
//       "OPENAI_API_KEY": { "value": "sk-…", "cap": { "usd": 20, "url": "https://platform.openai.com/settings/organization/limits", "checkedAt": "2026-10-20" } }
//     },
//     "projects": { "<project id>": { "OPENAI_API_KEY": { "value": "sk-…", "cap": { … } } } }
//   }
//
// One entry per credential, named by its environment variable. A project's
// entry overrides the global one of the same name. A paid API key carries
// its provider-side monthly cap (the amount, the provider's limit page, when
// it was last checked): the cap belongs to the key, so an override that is a
// different key records its own. Subscription logins and the Git token carry
// none. An older flat file (`{NAME: value}`) is refused.

/** Credentials that are not paid API keys: no provider-side cap. */
export const UNCAPPED = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "CONSOLE_GIT_TOKEN"]);

export interface KeyCap {
  /** The provider-side monthly limit, in US dollars. */
  usd: number;
  /** The provider's page where the limit is set. */
  url: string;
  /** When the owner last checked it (an ISO date). */
  checkedAt: string;
}
export interface KeyEntry {
  value: string;
  cap?: KeyCap;
}
export interface KeyFile {
  keys: Record<string, KeyEntry>;
  projects: Record<string, Record<string, KeyEntry>>;
}
/** What an agent of a project is given for one credential name. */
export interface ProjectKey {
  value: string;
  /** Null for a credential that carries none (UNCAPPED). */
  cap: KeyCap | null;
  /** Which entry it came from: the project's override, or the global one. */
  scope: "project" | "global";
}

function readRaw(path: string): Record<string, unknown> {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new LauncherError(`The Console key file is missing (${path}).`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    throw new LauncherError("The Console key file must be a plain file owned by you with mode 0600.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new LauncherError("The Console key file is not valid JSON.");
  }
  if (!isObject(parsed)) throw new LauncherError("The Console key file is not valid JSON.");
  return parsed;
}
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function entry(name: string, raw: unknown, where: string): KeyEntry {
  if (!isObject(raw) || typeof raw.value !== "string")
    throw new LauncherError(`The Console key file's ${where}${name} needs a "value".`);
  const out: KeyEntry = { value: raw.value };
  if (raw.cap !== undefined) {
    const cap = raw.cap;
    if (
      !isObject(cap) ||
      typeof cap.usd !== "number" ||
      !Number.isFinite(cap.usd) ||
      cap.usd <= 0 ||
      typeof cap.url !== "string" ||
      !/^https:\/\/\S+$/.test(cap.url) ||
      typeof cap.checkedAt !== "string" ||
      Number.isNaN(Date.parse(cap.checkedAt))
    )
      throw new LauncherError(`The Console key file's ${where}${name} has a cap without usd, an https url and checkedAt.`);
    out.cap = { usd: cap.usd, url: cap.url, checkedAt: cap.checkedAt };
  }
  return out;
}

function parseKeyFile(raw: Record<string, unknown>): KeyFile {
  if (!isObject(raw.keys))
    throw new LauncherError('The Console key file has no "keys" (an older flat file?): move it aside and re-save it from the Keys page.');
  const keys: Record<string, KeyEntry> = {};
  for (const [name, value] of Object.entries(raw.keys)) keys[name] = entry(name, value, "");
  const projects: Record<string, Record<string, KeyEntry>> = {};
  if (raw.projects !== undefined && !isObject(raw.projects)) throw new LauncherError("The Console key file's projects must be an object.");
  for (const [id, list] of Object.entries(isObject(raw.projects) ? raw.projects : {})) {
    if (!isObject(list)) throw new LauncherError(`The Console key file's project ${id} must be an object.`);
    projects[id] = Object.fromEntries(Object.entries(list).map(([name, value]) => [name, entry(name, value, `project ${id}: `)]));
  }
  return { keys, projects };
}

export function readKeyFile(path: string): KeyFile {
  return parseKeyFile(readRaw(path));
}

/** One credential for an agent of a project: the project's override, or the
 * global entry. A paid API key without a recorded cap is refused: the cap is
 * the hard ceiling required before any paid call. */
export function keyFor(path: string, name: string, projectId: string | null): ProjectKey {
  const file = readKeyFile(path);
  const own = projectId ? file.projects[projectId]?.[name] : undefined;
  const found = own ?? file.keys[name];
  const value = found?.value.trim();
  if (!found || !value) throw new LauncherError(`The Console key file has no ${name}.`);
  if (UNCAPPED.has(name)) return { value, cap: null, scope: own ? "project" : "global" };
  if (!found.cap)
    throw new LauncherError(
      `The Console key file's ${name}${own ? " for this project" : ""} has no provider-side monthly cap. Set one on the provider's limit page and record it (usd, url, checkedAt) before an agent uses this key.`,
    );
  return { value, cap: found.cap, scope: own ? "project" : "global" };
}

/** Every credential value in the file, global and per project: what the
 * redactor and the push check must know, whether or not an agent was
 * handed it in this worker's life. Never a cap's amount, link or date,
 * which are not secrets and would mask ordinary text. */
export function credentialValues(path: string): string[] {
  const file = readKeyFile(path);
  return [...Object.values(file.keys), ...Object.values(file.projects).flatMap((p) => Object.values(p))]
    .map((e) => e.value.trim())
    .filter(Boolean);
}

/** The folder that holds the key file: made 0700 when missing; otherwise
 * it must be the owner's with no access for anyone else, so nobody else
 * can list it or swap the file between a write and its rename. */
function checkFolder(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new LauncherError(`The key file's folder (${dir}) must be a folder owned by you with mode 0700 (chmod 700 it).`);
}

/**
 * Writes the key file whole and atomically: the new content goes to a
 * temporary file beside it with mode 0600, is flushed and read back, then
 * renamed into place, so a crash leaves either the old file or
 * the new one, never half of either. An existing file must pass the
 * reader's own checks first (a plain file of yours, 0600), so a link or an
 * open file is never replaced silently.
 */
export function writeKeyFile(path: string, file: KeyFile) {
  const dir = dirname(path);
  checkFolder(dir);
  if (existsSync(path) || isLink(path)) readRaw(path);
  const text = `${JSON.stringify({ keys: file.keys, projects: file.projects }, null, 2)}\n`;
  // What is written must read back as the same file.
  const parsed = parseKeyFile(JSON.parse(text) as Record<string, unknown>);
  if (JSON.stringify(parsed) !== JSON.stringify({ keys: file.keys, projects: file.projects }))
    throw new LauncherError("The key file could not be written as given; it was left as it was.");
  const temp = join(dir, `.console-keys.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    if (readFileSync(temp, "utf8") !== text) throw new LauncherError("The key file could not be written whole; it was left as it was.");
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};
