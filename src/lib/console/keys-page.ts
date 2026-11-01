import { existsSync } from "node:fs";
import { IMAGE_KEY } from "./image-tools.ts";
import { LauncherError } from "./launcher.ts";
import { MIN_SECRET_LENGTH } from "./redact.ts";
import { readKeyFile, UNCAPPED, writeKeyFile, type KeyCap, type KeyEntry, type KeyFile } from "./keys.ts";

// The Keys page: one entry per credential, named by its environment
// variable, globally or as a project's override. It writes the key file
// through `writeKeyFile` (0600, temporary file and rename). A paid API key
// needs its provider-side monthly cap (amount, the provider's limit page,
// when it was checked); a subscription login and the Git token carry none.
// A stored value is never shown again: the page sees its last four
// characters only. Every write needs a fresh code (`needsFreshCode`).

export interface CredentialInfo {
  /** The environment variable the client reads. */
  name: string;
  label: string;
  /** `api`: a paid API key, which needs a cap; `login`: a subscription
   * login token; `git`: the GitHub token (never reaches an agent). */
  kind: "api" | "login" | "git";
  /** Where the provider's spending limit is set, and what to set there. */
  limitUrl?: string;
  limitHint?: string;
  /** Used by the worker itself, never handed to an agent (the Krea key of
   * the image tools). */
  workerOnly?: boolean;
}

/**
 * Every credential the Console knows, checked 2026-10-21. The names other
 * than the Git token and the worker-only keys are exactly the launcher's
 * list (`console-agent`'s CREDENTIALS) and the sudoers `env_keep` (a test
 * holds the three equal): a new provider needs all three changed.
 */
export const CREDENTIALS: CredentialInfo[] = [
  { name: "CLAUDE_CODE_OAUTH_TOKEN", label: "Claude Code login (claude setup-token)", kind: "login" },
  { name: "CONSOLE_GIT_TOKEN", label: "GitHub token (the worker's mirror)", kind: "git" },
  {
    name: "OPENAI_API_KEY",
    label: "OpenAI API key",
    kind: "api",
    limitUrl: "https://platform.openai.com/settings/organization/limits",
    limitHint: "Limits → Budget: set a monthly budget that stops requests.",
  },
  {
    name: "CODEX_API_KEY",
    label: "OpenAI API key for Codex",
    kind: "api",
    limitUrl: "https://platform.openai.com/settings/organization/limits",
    limitHint: "Limits → Budget: set a monthly budget that stops requests.",
  },
  {
    name: "ANTHROPIC_API_KEY",
    label: "Anthropic API key",
    kind: "api",
    limitUrl: "https://console.anthropic.com/settings/limits",
    limitHint: "Limits: set the monthly spend limit.",
  },
  {
    name: "GEMINI_API_KEY",
    label: "Gemini API key",
    kind: "api",
    limitUrl: "https://aistudio.google.com/",
    limitHint: "Google AI Studio → Spend → Monthly spend cap (enforced about 10 minutes late).",
  },
  {
    name: "XAI_API_KEY",
    label: "xAI API key",
    kind: "api",
    limitUrl: "https://console.x.ai/",
    limitHint: "Billing → API Credits: prepaid credits with the invoiced billing limit at $0; an auto top-up's monthly maximum is the cap.",
  },
  {
    name: "MOONSHOT_API_KEY",
    label: "Moonshot (Kimi) API key",
    kind: "api",
    limitUrl: "https://platform.moonshot.ai/console",
    limitHint: "Prepaid balance: the balance you top up is the cap.",
  },
  {
    name: "DEEPSEEK_API_KEY",
    label: "DeepSeek API key",
    kind: "api",
    limitUrl: "https://platform.deepseek.com/usage",
    limitHint: "Prepaid balance: the balance you top up is the cap.",
  },
  {
    name: "ZAI_API_KEY",
    label: "Z.ai API key",
    kind: "api",
    limitUrl: "https://z.ai/manage-apikey/billing",
    limitHint: "Prepaid balance: the balance you top up is the cap.",
  },
  {
    name: "OPENROUTER_API_KEY",
    label: "OpenRouter API key",
    kind: "api",
    limitUrl: "https://openrouter.ai/settings/keys",
    limitHint: "Keys: give this key its own credit limit.",
  },
  {
    name: IMAGE_KEY,
    label: "Krea API key (image tools; the worker's own)",
    kind: "api",
    limitUrl: "https://www.krea.ai/docs/developers/api-keys-and-billing",
    limitHint: "Prepaid balance, auto top-up off: the balance is the cap.",
    workerOnly: true,
  },
];
export function credentialInfo(name: string): CredentialInfo | undefined {
  return CREDENTIALS.find((c) => c.name === name);
}
// The key file's uncapped names must be this catalog's non-API ones.
for (const name of UNCAPPED)
  if (credentialInfo(name)?.kind === "api") throw new Error(`${name} cannot be both uncapped and a paid API key.`);

/** One stored entry as the page sees it: never the value. */
export interface KeyRow {
  name: string;
  label: string;
  kind: CredentialInfo["kind"] | "unknown";
  /** The value's last four characters. */
  last4: string;
  cap: KeyCap | null;
  /** A paid API key with no cap: no agent is given it. */
  needsCap: boolean;
  limitUrl: string | null;
  limitHint: string | null;
}
export interface KeysView {
  exists: boolean;
  /** Why the file could not be read (its mode, its JSON). */
  problem: string | null;
  global: KeyRow[];
  projects: Record<string, KeyRow[]>;
  credentials: CredentialInfo[];
}

function row(name: string, entry: KeyEntry): KeyRow {
  const info = credentialInfo(name);
  const kind = info?.kind ?? (UNCAPPED.has(name) ? "login" : "unknown");
  return {
    name,
    label: info?.label ?? name,
    kind,
    last4: entry.value.trim().slice(-4),
    cap: entry.cap ?? null,
    needsCap: !UNCAPPED.has(name) && !entry.cap,
    limitUrl: info?.limitUrl ?? null,
    limitHint: info?.limitHint ?? null,
  };
}
const rows = (list: Record<string, KeyEntry>) =>
  Object.entries(list)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => row(name, entry));

/** What the Keys page shows: names, last four characters and caps. */
export function keysView(path: string): KeysView {
  const base = { global: [], projects: {}, credentials: CREDENTIALS };
  if (!existsSync(path)) return { exists: false, problem: null, ...base };
  let file: KeyFile;
  try {
    file = readKeyFile(path);
  } catch (error) {
    return { exists: true, problem: (error as Error).message, ...base };
  }
  return {
    exists: true,
    problem: null,
    global: rows(file.keys),
    projects: Object.fromEntries(Object.entries(file.projects).map(([id, list]) => [id, rows(list)])),
    credentials: CREDENTIALS,
  };
}

export class KeyCommandError extends Error {}

/** Today as the owner's checked date may say it (a day of slack for time
 * zones), as an ISO date. */
const latestDate = (now: number) => new Date(now + 24 * 60 * 60_000).toISOString().slice(0, 10);

function checkCap(raw: unknown, now: number): KeyCap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new KeyCommandError("A paid API key needs its monthly cap: the amount, the limit page and when you checked it.");
  const cap = raw as Record<string, unknown>;
  const usd = typeof cap.usd === "string" ? Number(cap.usd) : cap.usd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0 || usd > 100_000)
    throw new KeyCommandError("The cap's amount must be a number of dollars above 0.");
  if (typeof cap.url !== "string" || !/^https:\/\/[^\s]+$/.test(cap.url.trim()) || cap.url.length > 500)
    throw new KeyCommandError("The cap's limit page must be an https link.");
  if (typeof cap.checkedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(cap.checkedAt) || Number.isNaN(Date.parse(cap.checkedAt)))
    throw new KeyCommandError("Say when you checked the cap, as a date.");
  if (cap.checkedAt > latestDate(now)) throw new KeyCommandError("The cap's checked date is in the future.");
  return { usd: Math.round(usd * 100) / 100, url: cap.url.trim(), checkedAt: cap.checkedAt };
}

function checkValue(raw: unknown): string {
  if (typeof raw !== "string") throw new KeyCommandError("Paste the key.");
  const value = raw.trim();
  // Shorter values would not be masked by the redactor (MIN_SECRET_LENGTH).
  if (value.length < MIN_SECRET_LENGTH) throw new KeyCommandError(`A key is at least ${MIN_SECRET_LENGTH} characters long.`);
  if (value.length > 4096) throw new KeyCommandError("That key is longer than 4096 characters.");
  if (/[\s\u0000-\u001f\u007f]/.test(value)) throw new KeyCommandError("A key has no spaces or line breaks.");
  return value;
}

/**
 * The Keys page's two commands. `setKey` adds a credential or changes its
 * value or cap (a value left out keeps the stored one); `removeKey` takes
 * it out. A project's override is named by `projectId`; without one the
 * entry is global. Returns only what the page may see.
 */
export function runKeyCommand(
  path: string,
  input: Record<string, unknown>,
  projectExists: (id: string) => boolean,
  now = Date.now(),
): Record<string, unknown> {
  const name = input.name;
  // A new or changed key must be a listed credential; removing also takes
  // a name the file holds that is no longer listed (written by hand, say).
  if (typeof name !== "string" || name.length > 100 || (input.action !== "removeKey" && !credentialInfo(name)))
    throw new KeyCommandError("Choose one of the listed credentials.");
  const info = credentialInfo(name);
  let projectId: string | null = null;
  if (input.projectId !== undefined && input.projectId !== null && input.projectId !== "") {
    if (typeof input.projectId !== "string" || !/^[a-z][0-9a-f]{12}$/.test(input.projectId) || !projectExists(input.projectId))
      throw new KeyCommandError("That project does not exist.");
    projectId = input.projectId;
  }
  // The Git token is the worker's own; a project may override it like
  // any other credential.
  let file: KeyFile;
  try {
    file = existsSync(path) ? readKeyFile(path) : { keys: {}, projects: {} };
  } catch (error) {
    throw new KeyCommandError(`${(error as Error).message} Fix it by hand first; the Keys page does not overwrite a file it cannot read.`);
  }
  const list = projectId ? { ...(file.projects[projectId] ?? {}) } : { ...file.keys };
  const where = projectId ? " for this project" : "";
  if (input.action === "removeKey") {
    if (!list[name]) throw new KeyCommandError(`There is no ${name}${where}.`);
    delete list[name];
  } else if (input.action === "setKey") {
    const current = list[name];
    const value = input.value === undefined || input.value === "" ? current?.value : checkValue(input.value);
    if (!value) throw new KeyCommandError("Paste the key.");
    const entry: KeyEntry = { value };
    if (info!.kind === "api") entry.cap = checkCap(input.cap === undefined ? current?.cap : input.cap, now);
    else if (input.cap !== undefined && input.cap !== null) throw new KeyCommandError("A login or the Git token has no monthly cap.");
    list[name] = entry;
  } else throw new KeyCommandError("Unknown key command.");
  const next: KeyFile = { keys: projectId ? file.keys : list, projects: { ...file.projects } };
  if (projectId) {
    if (Object.keys(list).length) next.projects[projectId] = list;
    else delete next.projects[projectId];
  }
  try {
    writeKeyFile(path, next);
  } catch (error) {
    if (error instanceof LauncherError) throw new KeyCommandError(error.message);
    throw new KeyCommandError("The key file could not be written; it was left as it was.");
  }
  return { saved: true, name, scope: projectId ? "project" : "global", last4: list[name]?.value.slice(-4) ?? null };
}
