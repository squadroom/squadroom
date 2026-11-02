import type { ConsoleCommand } from "./commands.ts";
import { AGENT_KINDS, type AgentKind } from "./agents.ts";
import type { CleanupItem } from "./cleanup.ts";
import type { ArchiveImpact, TimelineEntry } from "./views.ts";
import type { NeedsLike } from "./notify.ts";
import type { Overview } from "./overview.ts";
import { CONSOLE_SPEND_PAUSE, SPEND_PAUSE, type ConsoleEvent, type ConsoleProject, type ConsoleTab } from "./types.ts";

// The Console page's decisions, pure and browser-safe (no DOM, no
// React), so they are tested without a browser.

/** Everything waiting in Needs you. */
export const needCount = (n: NeedsLike) =>
  n.requests.length + n.interrupted.length + (n.messages?.length ?? 0) + (n.paused?.length ?? 0) + (n.notices?.length ?? 0);

/** "1 agent", "2 agents". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Dollars: cents, or four places for a fraction of a cent. */
export const money = (n: number) => (n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);

/** "12s", "3m", "1h" since a time (a helpers row label). */
export function elapsed(since: number, until = Date.now()): string {
  const s = Math.max(0, Math.round((until - since) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

/** What a template creates, in words (New tab and Settings › Templates). */
export const templateSummary = (t: { agents: string[]; steps: { name: string }[] }) =>
  `Creates ${t.agents.join(", ")}${t.steps.length ? `; steps: ${t.steps.map((s) => s.name).join(", ")}` : ""}.`;

/** The previous polled view when the new one is equal, so an unchanged
 * poll re-renders nothing. Flat views only: compared by key. */
export function keepIfSame<T extends object>(previous: T | null, next: T | null): T | null {
  if (!previous || !next) return next;
  const a = previous as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((k) => Object.is(a[k], b[k])) ? previous : next;
}

/** Where a project's agents work, in words (the project switcher's hint). */
export const projectPlace = (p: Pick<ConsoleProject, "source" | "repo" | "baseBranch">) =>
  p.source === "github" ? `${p.repo} (${p.baseBranch})` : p.source === "folder" ? "a new folder per agent" : "no project files";

/** A link in an agent's writing or a shown document: one of the agent's
 * own files opens in the file panel (`resolve` finds it); any other path on
 * the Mac is never navigated to; web links (protocol-relative ones too)
 * open in a new tab. Returns true when the link is handled here. */
export function fileLinks(resolve: (href: string) => string | null, open: (path: string) => void) {
  return (href: string): boolean => {
    const path = resolve(href);
    if (path) {
      open(path);
      return true;
    }
    return (href.startsWith("/") && !href.startsWith("//")) || href.startsWith("file:");
  };
}

/** Text as a fenced code block, its fence longer than any backtick run in it. */
export function fence(text: string, language: string | null | undefined): string {
  const ticks = "`".repeat((text.match(/`+/g) ?? []).reduce((n, t) => Math.max(n, t.length + 1), 3));
  return `${ticks}${language ?? ""}\n${text}\n${ticks}`;
}

/** Archive or close may go ahead: the impact is known and, when any agent
 * is working or unpushed, its name was typed. */
export const archiveReady = (impact: Pick<ArchiveImpact, "name" | "typeToConfirm"> | null, typed: string) =>
  !!impact && (!impact.typeToConfirm || typed.trim() === impact.name);

/** The chosen cleanup items: their keys, total size (KB) and how many hold
 * commits that would be lost. */
export function cleanupSelection(items: CleanupItem[] | null, chosen: ReadonlySet<string>) {
  const picked = (items ?? []).filter((i) => chosen.has(i.key));
  return { keys: [...chosen], kb: picked.reduce((n, i) => n + (i.sizeKb ?? 0), 0), lost: picked.filter((i) => i.warning).length };
}

/** A typed dollar amount to the cent, or NaN. */
export const parseDollars = (value: string) => (/^\s*\d+(\.\d+)?\s*$/.test(value) ? Math.round(Number(value) * 100) / 100 : NaN);

/** The pause shown above a tab: why, and its one button. A tab paused at
 * its spend limit outlasts any Resume, so it offers Reset spend, as Needs
 * you does. */
export function pauseBanner(
  pausedAll: string | null | undefined,
  project: Pick<ConsoleProject, "id" | "paused" | "pauseReason">,
  tab: Pick<ConsoleTab, "id" | "paused" | "pauseReason"> | undefined,
): { text: string; spend: boolean; button: string; body: ConsoleCommand } | null {
  if (pausedAll != null) return { text: pausedAll || "Everything is paused.", spend: false, button: "Resume all", body: { action: "resume", scope: "all" } };
  if (project.paused)
    return { text: project.pauseReason || "This project is paused.", spend: false, button: "Resume project", body: { action: "resume", scope: "project", id: project.id } };
  if (!tab?.paused) return null;
  const text = tab.pauseReason || "This tab is paused.";
  if (text.startsWith(CONSOLE_SPEND_PAUSE)) return { text, spend: false, button: "Reset Console spend", body: { action: "resetConsoleSpend" } };
  return text.startsWith(SPEND_PAUSE)
    ? { text, spend: true, button: "Reset spend", body: { action: "resetSpend", tabId: tab.id } }
    : { text, spend: false, button: "Resume tab", body: { action: "resume", scope: "tab", id: tab.id } };
}

/** The agent kinds offered in New agent and the team setup. */
export const offeredKinds = (codexOff: string | null) => AGENT_KINDS.filter((k) => k.offered && (k.kind !== "codex" || !codexOff));
/** A role's suggested AI, Claude Code while Codex is off. */
export const roleKind = (ai: AgentKind, codexOff: string | null): AgentKind => (ai === "codex" && codexOff ? "claude-code" : ai);
/** A kind's first model, chosen when the kind changes. */
export const firstModel = (kind: string) => AGENT_KINDS.find((k) => k.kind === kind)!.models[0].id;

/** A team timeline entry's heading. */
export const timelineLine = (e: Pick<TimelineEntry, "from" | "to" | "kind">) =>
  `${e.from} → ${e.to}${e.kind === "ask" ? " (asks)" : e.kind === "reply" ? " (answers)" : e.kind === "route" ? " (route)" : ""}`;

/** One window's events kept on the page. */
export const EVENTS_MAX = 2000;
export const EVENT_BYTES_MAX = 2 * 1024 * 1024;
export interface EventWindow {
  list: ConsoleEvent[];
  sizes: number[];
  bytes: number;
}
const utf8 = new TextEncoder();

/** Adds an event to a window's list, bounded: streamed text of one turn is
 * merged as it arrives, and the oldest go once the window holds more than
 * EVENTS_MAX events or EVENT_BYTES_MAX bytes (counted as UTF-8, not
 * string length). */
export function appendEvent(own: EventWindow, event: ConsoleEvent): void {
  const prev = own.list.at(-1);
  const size = utf8.encode(JSON.stringify(event.body)).length;
  if (prev && prev.turnId === event.turnId && prev.kind === event.kind && (event.kind === "text" || event.kind === "thinking")) {
    let text = (prev.body as { text: string }).text + (event.body as { text: string }).text;
    // One turn's text past a quarter of the window's budget keeps only its
    // latest part, so the answer itself is never evicted by a later event.
    if (text.length > EVENT_BYTES_MAX / 4) text = `… ${text.slice(-EVENT_BYTES_MAX / 8)}`;
    own.list[own.list.length - 1] = { ...event, body: { text } };
    const merged = utf8.encode(JSON.stringify({ text })).length;
    own.bytes += merged - own.sizes[own.sizes.length - 1] - size;
    own.sizes[own.sizes.length - 1] = merged;
  } else {
    own.list.push(event);
    own.sizes.push(size);
  }
  own.bytes += size;
  while (own.list.length > 1 && (own.list.length > EVENTS_MAX || own.bytes > EVENT_BYTES_MAX)) {
    own.list.shift();
    own.bytes -= own.sizes.shift()!;
  }
}

/** A pasted image's file name (`pasted-<time>[-<n>].<ext>`). */
export function pastedName(type: string, index: number, now = Date.now()): string {
  const ext = type.split("/")[1];
  return `pasted-${now}${index ? `-${index}` : ""}.${ext === "jpeg" ? "jpg" : ext}`;
}

/** What the Overview flags in its health section: the worker down, no
 * backup for more than a day (or a failure since the last one), e-mails
 * not sent, free disk under the clone floor, a client whose checked
 * version is not the verified one. */
export function healthWarnings(h: Overview["health"], now: number): string[] {
  const out: string[] = [];
  if (!h.worker.online) out.push("The Console worker is not running.");
  if (!h.backup.succeededAt) out.push("No backup has been made yet.");
  else if (h.backup.failedAt > h.backup.succeededAt) out.push("The last backup failed.");
  else if (now - h.backup.succeededAt > 26 * 3600_000) out.push(`The last backup is ${elapsed(h.backup.succeededAt, now)} old.`);
  if (h.mailFailed) out.push(`${h.mailFailed} e-mail${h.mailFailed === 1 ? "" : "s"} not sent.`);
  if (h.disk.freeBytes !== null && h.disk.freeBytes < h.disk.floorBytes)
    out.push(`Free disk is ${gigabytes(h.disk.freeBytes)}: new agent folders need ${gigabytes(h.disk.floorBytes)}.`);
  for (const c of h.clients)
    if (c.installed !== null && c.installed !== c.pinned) out.push(`${c.label} ${c.installed} is installed; the Console is verified with ${c.pinned}.`);
  return out;
}

/** "41.2 GB". */
export const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** A search snippet as plain runs, `hit` for the matched words the store
 * marked with \u0002 … \u0003. */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  return snippet
    .split(/(\u0002[^\u0003]*\u0003)/)
    .filter(Boolean)
    .map((part) => (part.startsWith("\u0002") ? { text: part.slice(1, -1), hit: true } : { text: part, hit: false }));
}

/** The approve gate's line: what is approved, after whose review, or that
 * a later commit cancelled it. */
export function approvalLine(a: { head: string | null; current: { sha: string; reviewerName: string | null; current: boolean; cancelledBy: string | null } | null }): string {
  if (!a.current) return a.head ? "Not approved." : "No commit to approve yet.";
  const what = `${a.current.sha.slice(0, 7)}${a.current.reviewerName ? `, after ${a.current.reviewerName}'s review` : ""}`;
  const by = a.current.cancelledBy ?? a.head;
  return a.current.current ? `Approved: ${what}.` : `The approval of ${what} was cancelled by a later commit${by ? ` (${by.slice(0, 7)})` : ""}.`;
}

/** A download's file name from a title: letters, digits, spaces, dots and
 * dashes only, at most 100 characters, then `.md`. */
export function markdownFileName(title: string): string {
  return `${title.replace(/[^\p{L}\p{N} ._-]+/gu, "-").replace(/\s+/g, " ").trim().slice(0, 100) || "report"}.md`;
}

/** The Settings page's cards, in the order shown: each opens an existing
 * screen inside the page. */
export const SETTINGS_SECTIONS = [
  { key: "overview", title: "Overview", description: "Health, spend and problems" },
  { key: "keys", title: "Keys and connections", description: "API keys, caps and client logins" },
  { key: "roles", title: "Roles", description: "What each kind of agent is told" },
  { key: "templates", title: "Templates", description: "Saved teams and step plans" },
  { key: "notifications", title: "Notifications", description: "Alerts on this device" },
  { key: "appearance", title: "Appearance", description: "Light, dark or the system's" },
  { key: "logs", title: "Logs", description: "What the worker did, live" },
  { key: "cleanup", title: "Clean up", description: "Free disk from old folders" },
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["key"];

/** Where the page's address points: null outside Settings, "" for its
 * cards, or a section (`#settings/keys`); an unknown section shows the
 * cards. */
export function settingsFromHash(hash: string): SettingsSection | "" | null {
  const m = /^#settings(?:\/(.*))?$/.exec(hash);
  if (!m) return null;
  return SETTINGS_SECTIONS.find((s) => s.key === m[1])?.key ?? "";
}
export const settingsHash = (section: SettingsSection | "") => (section ? `#settings/${section}` : "#settings");

/** Light or dark: the system's setting unless this device chose one;
 * anything else remembered reads as the system's. */
export const APPEARANCES = ["system", "light", "dark"] as const;
export type Appearance = (typeof APPEARANCES)[number];
export const readAppearance = (stored: string | null): Appearance =>
  APPEARANCES.find((a) => a === stored) ?? "system";

/** The top bar's status control: the worker stopped, everything paused,
 * or running. */
export function workerStatus(w: { online: boolean; pausedAll: string | null } | null): { label: string; tone: "ok" | "paused" | "off" } | null {
  if (!w) return null;
  if (!w.online) return { label: "Worker stopped", tone: "off" };
  return w.pausedAll !== null ? { label: "Paused", tone: "paused" } : { label: "Running", tone: "ok" };
}

/** An agent kind's badge: two letters from its name, neutral rather than
 * the maker's logo: "Claude Code" → "CC", "Codex" → "Co". */
export function kindInitials(label: string): string {
  const words = label.split(/\s+/).filter(Boolean);
  return words.length > 1 ? `${words[0][0]}${words[1][0]}`.toUpperCase() : `${(words[0] ?? "?")[0].toUpperCase()}${(words[0] ?? "")[1] ?? ""}`;
}
