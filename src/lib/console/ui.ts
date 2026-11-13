import type { ConsoleCommand } from "./commands.ts";
import { AGENT_KINDS, type AgentKind } from "./agents.ts";
import type { CleanupItem } from "./cleanup.ts";
import type { ArchiveImpact, TimelineEntry } from "./views.ts";
import type { NeedsLike } from "./notify.ts";
import type { Overview } from "./overview.ts";
import type { Block } from "./transcript.ts";
import { CONSOLE_SPEND_PAUSE, SPEND_PAUSE, turnLimits, type ConsoleEvent, type ConsoleProject, type ConsoleTab } from "./types.ts";

// The Console page's decisions, pure and browser-safe (no DOM, no
// React), so they are tested without a browser.

/** Everything waiting in Needs you. */
export const needCount = (n: NeedsLike) =>
  n.requests.length + (n.expired?.length ?? 0) + n.interrupted.length + (n.messages?.length ?? 0) + (n.paused?.length ?? 0) + (n.notices?.length ?? 0);

/** A Needs you request's stored input, laid out to read: indented when it
 * is whole JSON (so text inside it keeps its `\n` marks), otherwise as
 * stored (a cut one ends with how much was left out). */
export function wholeInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

/** "1 agent", "2 agents". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Dollars: cents, or four places for a fraction of a cent. */
export const money = (n: number) => (n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);

/** A tab's turn limits in force, for its menu: "40 turns, 2 h per message". */
export function turnLimitsHint(tab: Pick<ConsoleTab, "turnLimit" | "timeLimitMin">): string {
  const { turns, ms } = turnLimits(tab);
  return `${plural(turns, "turn")}, ${Math.round((ms / 3_600_000) * 100) / 100} h per message`;
}

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

/** A run of tool rows in a window's transcript. `line` is the
 * one line shown for two or more tools ("18 steps: 10 Edit, 5 Read, 2 Write,
 * 1 Grep"), or null for a single tool, which shows as it always did. */
export interface StepsRow {
  type: "steps";
  /** The run's first row's, so it stays the same while the run grows. */
  key: string;
  blocks: Block[];
  line: string | null;
  /** Tools in the run that failed: the line says so and the run opens. */
  failed: number;
}

/**
 * A window's transcript with each run of tool rows gathered.
 * A run is consecutive tool rows; a Thinking row or an "allowed" line
 * between them (an Always rule, Network auto) stays in the run, uncounted.
 * Anything else ends it: text, a message, team mail, a push, an error, how
 * a turn ended, and every request waiting for the owner or refused, so
 * those always show. A
 * failed tool is counted on the line. `working`: the agent's turn is
 * running, so tools of the last run with no result yet are counted as
 * running.
 */
export function transcriptRows(blocks: Block[], working = false): (Block | StepsRow)[] {
  const rows: (Block | StepsRow)[] = [];
  let run: Block[] = [];
  const flush = (last: boolean) => {
    const tools = run.filter((b) => b.type === "tool");
    if (!tools.length) rows.push(...run);
    else {
      const failed = tools.filter((t) => t.error).length;
      const running = working && last ? tools.filter((t) => t.output === null).length : 0;
      const counts = new Map<string, number>();
      for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
      // Most used first; a tie keeps the order they first ran in.
      const names = [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${n} ${name}`);
      const line =
        tools.length < 2 ? null : `${tools.length} steps: ${names.join(", ")}${failed ? ` · ${failed} failed` : ""}${running ? ` · ${running} running` : ""}`;
      rows.push({ type: "steps", key: `steps-${run[0].key}`, blocks: run, line, failed });
    }
    run = [];
  };
  for (const b of blocks) {
    if (b.type === "tool" || b.type === "thinking" || (b.type === "permission" && b.decision === "allow")) run.push(b);
    else {
      flush(false);
      rows.push(b);
    }
  }
  flush(true);
  return rows;
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

/** The Turn limits dialog's fields as the command takes them:
 * blank is the default (null), the time is typed in hours; undefined when
 * a field is not a number. The command checks the ranges. */
export function turnLimitsForm(turns: string, hours: string): { turns: number | null; minutes: number | null } | undefined {
  const blank = (v: string) => !v.trim();
  if ((!blank(turns) && !/^\s*\d+\s*$/.test(turns)) || (!blank(hours) && !/^\s*\d+(\.\d+)?\s*$/.test(hours))) return undefined;
  return { turns: blank(turns) ? null : Number(turns), minutes: blank(hours) ? null : Math.round(Number(hours) * 60) };
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
