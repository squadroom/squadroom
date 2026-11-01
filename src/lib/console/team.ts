// Team tools and the mailbox: what agents in one tab call to message each
// other, how queued messages become one labelled prompt, what a Re-send
// tells the agent, and the commit message each turn gets. Pure: the worker
// and the store call these.

/** A team-tool call the agent got wrong (an unknown teammate, an ask that
 * is not its own): returned to the agent, never fatal. */
export class TeamError extends Error {}
/** A hold that would close a cycle (agent ids, in order). */
export class HoldCycleError extends TeamError {
  readonly cycle: string[];
  constructor(cycle: string[]) {
    super("A hold cycle.");
    this.cycle = cycle;
  }
}

/** A route sends a finished turn's final message as "route". */
export type MessageKind = "send" | "ask" | "reply" | "route";
/** queued → in_turn → answered (asks) or done; interrupted when the turn
 * that held it did not finish; discarded by the owner. */
export type MessageState = "queued" | "in_turn" | "answered" | "done" | "interrupted" | "discarded";

export interface TeamMessage {
  id: number;
  tabId: string;
  from: string;
  to: string;
  kind: MessageKind;
  /** Asks and the replies that answer them. */
  correlationId: string | null;
  body: string;
  state: MessageState;
  /** The turn that delivered it. */
  turnId: number | null;
  /** The turn that sent it. */
  fromTurn: number | null;
  instructionId: number | null;
  /** A Re-send: the interrupted turn whose actions are listed. */
  resendAfter: number | null;
  createdAt: number;
}

export interface ToolCall {
  turnId: number;
  tool: string;
  summary: string;
  result: string;
}

/** A route's phrase. */
export const ROUTE_PHRASE_MAX = 100;
/** One message's text (the turn's whole output is bounded separately). */
export const MESSAGE_MAX = 32_000;
/** How much of a final message a route or an automatic answer carries; the
 * rest is read with team_read, by its recipient only. */
export const SHARE_MAX = 8_000;
/** One team_read page. */
export const READ_PAGE = 8_000;
/** The note after a shortened message, naming how to read the rest. */
export const continuation = (messageId: number, rest: number, offset: number) =>
  `\n\n[… ${rest} more characters of this message. Read them with team_read(message_id: ${messageId}, offset: ${offset}).]`;
/** One report's text: it is read in the Needs you tray. */
export const REPORT_MAX = 4_000;
/** Reports one turn may file, so a looping agent cannot fill Needs you. */
export const REPORTS_PER_TURN = 3;

/** The tools every agent in a tab has. `team_push` only for an editing
 * agent of a GitHub project. */
export const TEAM_TOOLS = [
  {
    name: "team_list",
    description: "List the agents in your tab: names, roles, kinds and what each is doing now.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "team_send",
    description:
      "Send a message to a teammate in your tab. It is delivered when they are free; no answer is expected. Not a reply to an ask: answer asks with team_reply.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string", description: "The teammate's name." }, message: { type: "string" } },
      required: ["to", "message"],
    },
  },
  {
    name: "team_ask",
    description:
      "Ask a teammate in your tab something. This does not wait: end your turn, and their answer arrives as your next message, with the same correlation id.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string", description: "The teammate's name." }, message: { type: "string" } },
      required: ["to", "message"],
    },
  },
  {
    name: "team_reply",
    description:
      "Answer one ask you were given, by its correlation id. An ask you do not answer this way is answered with your final message of the turn.",
    inputSchema: {
      type: "object",
      properties: { correlation_id: { type: "string" }, message: { type: "string" } },
      required: ["correlation_id", "message"],
    },
  },
  {
    name: "team_report",
    description:
      "Put a note or a question for the owner in their Needs you tray: a blocker, a decision only they can make, something they should know. It does not wait for an answer; the owner answers, if at all, with a message in your window. Keep it short (at most 4000 characters); at most 3 per turn.",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
  {
    name: "team_pull",
    description:
      "Bring a teammate's latest committed work into your branch (their uncommitted edits never come along). Your own changes so far are committed first. A clean merge is committed for you; with conflicts, the files are listed: resolve the markers in your turn and the Console commits the merge when the turn ends, or call team_pull_abort.",
    inputSchema: { type: "object", properties: { from: { type: "string", description: "The teammate's name or id." } }, required: ["from"] },
  },
  {
    name: "team_pull_abort",
    description: "Abandon a merge from team_pull that has conflicts; your branch goes back to how it was before the pull.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "team_claim",
    description:
      "Tell your teammates you are editing these paths (files, folders or globs such as src/auth/**), with a note. Claude teammates cannot write there until you release them (or the claim expires).",
    inputSchema: {
      type: "object",
      properties: { paths: { type: "array", items: { type: "string" } }, note: { type: "string" } },
      required: ["paths", "note"],
    },
  },
  {
    name: "team_release",
    description: "Release your claims on these paths (or all of them when paths is empty).",
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } } },
  },
  {
    name: "team_hold",
    description:
      "Ask a teammate to hang on: after its current turn, no team messages reach it until you call team_resume (or the owner resumes, or the hold times out).",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, reason: { type: "string" } },
      required: ["to", "reason"],
    },
  },
  {
    name: "team_resume",
    description: "Lift your hold on a teammate.",
    inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
  },
  {
    name: "team_push",
    description:
      "Ask to push your console/ branch to GitHub and open its pull request (the owner approves it). It is pushed after this turn ends and its changes are committed. Give the pull request a title and a description in Markdown: what changed and why, the files, the checks you ran, and what the owner should test. If the owner has switched Codex reviews on, a new pull request gets one; on later pushes, set review to true to ask for another.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The pull request's title, at most 120 characters." },
        body: { type: "string", description: "The pull request's description (Markdown)." },
        review: { type: "boolean", description: "Ask Codex to review again when the pull request already exists (only when the owner has switched Codex reviews on)." },
      },
    },
  },
  {
    name: "team_pr",
    description:
      "Read your branch's open pull request on GitHub: its state, whether your newer commits are pushed, Codex's review state, every open review thread (with its id) and the conversation, each comment whole with its formatting and a number. With comment (that number) or thread (an id), read just that one in full, however long. Read-only; GitHub projects.",
    inputSchema: {
      type: "object",
      properties: {
        comment: { type: "integer", minimum: 1, description: "A conversation comment's number, to read it in full." },
        thread: { type: "string", description: "A review thread's id, to read all of it." },
      },
    },
  },
  {
    name: "team_pr_reply",
    description:
      "Answer one review thread on your pull request (the owner approves it): say what you changed and in which commit, or why you are not changing it. resolve: true also resolves the thread. Push the fix with team_push first.",
    inputSchema: {
      type: "object",
      properties: { thread: { type: "string", description: "The thread id team_pr shows." }, message: { type: "string" }, resolve: { type: "boolean" } },
      required: ["thread", "message"],
    },
  },
  {
    name: "team_read",
    description:
      "Read the rest of a long message you received (a teammate's final message, routed to you or answering your ask, is cut and says so). Give its message_id and offset as the message says. Read-only.",
    inputSchema: {
      type: "object",
      properties: { message_id: { type: "number" }, offset: { type: "number" } },
      required: ["message_id"],
    },
  },
  {
    name: "team_diff",
    description:
      "Read a teammate's work: its branch's changes against the commit it started from, as of its last finished turn (work in a turn still running is not in it). Without path: the changed files and as much of the patch as fits; with path (a file, folder or glob such as src/**): that part's patch. Read-only.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string", description: "The teammate's name or id." }, path: { type: "string" } },
      required: ["from"],
    },
  },
];
export const TEAM_TOOL_NAMES = new Set(TEAM_TOOLS.map((t) => t.name));

/** The team tools offered to one agent: the ones the worker would accept
 * from it, so no schema is paid for in every request's prefix for a call
 * that is always refused. An editing agent claims, and pulls unless its
 * project has no files; only an editing agent of a GitHub project pushes
 * and reads or answers its pull request. */
export function teamToolsFor(agent: { permission: "look" | "edit" }, project: { source: "folder" | "none" | "github" } | undefined) {
  const edit = agent.permission === "edit";
  const withFiles = edit && !!project && project.source !== "none";
  const github = edit && project?.source === "github";
  const offered = (name: string) => {
    switch (name) {
      case "team_pull":
        return withFiles;
      case "team_claim":
        return edit;
      case "team_push":
      case "team_pr":
      case "team_pr_reply":
        return github;
      default:
        return true;
    }
  };
  return TEAM_TOOLS.filter((t) => offered(t.name));
}

/** The agents' instructions about the team (part of each window's system
 * prompt). */
export const TEAM_NOTE = [
  "",
  "You work in a team of agents in one tab of the Console. Use the console tools:",
  "- team_list to see your teammates;",
  "- team_send(to, message) to tell a teammate something;",
  "- team_ask(to, message) to ask for something (a review, an answer). It never waits: end your turn, and the answer arrives as your next message;",
  "- team_reply(correlation_id, message) to answer an ask you were given; otherwise your final message answers it;",
  "- team_report(message) to put a blocker, a question or a decision for the owner in their Needs you tray. It does not wait: carry on, or end your turn if you cannot go on without the answer;",
  "- team_diff(from, path?) to read a teammate's committed changes. You cannot open other agents' folders, so use this (or your own folder, if you are Look only) instead of asking anyone to paste a patch;",
  "- team_push(title, body) to ask the owner to push your branch and open its pull request, which may then get a Codex review (GitHub projects);",
  "- team_pr to read your pull request (Codex's findings, every comment in full; team_pr(comment: n) or team_pr(thread: id) for one long item), and team_pr_reply(thread, message, resolve) to answer a finding. team_push also replaces the pull request's title and description with the ones you give. GitHub is reached only through these tools: there is no gh login or token in your sandbox, by design, so do not try gh, curl or the web for it;",
  "- team_pull(from) to bring a teammate's committed work into your branch (team_pull_abort to give up a conflicted merge);",
  "- team_claim(paths, note) before editing shared areas, and team_release when done; respect teammates' claims;",
  "- team_hold(to, reason) to ask a teammate to hang on while you change something, and team_resume(to) afterwards.",
].join("\n");

const label = (m: TeamMessage & { fromName: string }) =>
  m.kind === "ask"
    ? `From ${m.fromName} (an ask, correlation id ${m.correlationId})`
    : m.kind === "reply"
      ? `From ${m.fromName} (the answer to your ask ${m.correlationId})`
      : m.kind === "route"
        ? `From ${m.fromName} (its final message, sent by a route)`
        : `From ${m.fromName}`;

/** Queued messages, delivered together as one prompt (batching). */
export function teamPrompt(messages: (TeamMessage & { fromName: string })[]): string {
  const parts = messages.map((m, i) => `[${i + 1}] ${label(m)}:\n${m.body}`);
  const asks = messages.some((m) => m.kind === "ask");
  return [
    `Messages from your team (${messages.length}):`,
    "",
    parts.join("\n\n"),
    ...(asks ? ["", "Answer each ask with team_reply(correlation_id, message); an ask you do not answer that way is answered with your final message."] : []),
  ].join("\n");
}

const describe = (c: ToolCall) => `- ${c.summary}${c.result ? ` → ${c.result.split("\n")[0].slice(0, 200)}` : ""}`;

/** What a Re-send says first, so the agent continues instead of repeating
 * what it already did. */
export function resendNote(calls: ToolCall[]): string {
  if (!calls.length) return "Your previous attempt was interrupted before it used any team tool. Start again.\n\n";
  return `Your previous attempt was interrupted after these actions:\n${calls.slice(0, 30).map(describe).join("\n")}${
    calls.length > 30 ? `\n- and ${calls.length - 30} more` : ""
  }\nDo not repeat them; continue from there.\n\n`;
}

/** The first sentence of a text, on one line, cut on a word boundary. */
export function firstSentence(text: string, max = 72): string {
  const line = text
    .replace(/[`*_#>]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return "";
  const flat = line.replace(/\s+/g, " ");
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end > 0 ? flat.slice(0, end + 1) : flat;
  if (sentence.length <= max) return sentence.replace(/[.:;,]$/, "");
  const cut = sentence.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.:;,]+$/, "")}…`;
}

/**
 * A turn's commit message: a short subject (the agent's own summary when it
 * gave one, else the request's first sentence), the full request in the
 * body, and an `Agent:` trailer.
 */
export function commitMessage(input: { request: string; summary: string | null; agentName: string; agentId: string; turnId: number }): string {
  const subject = firstSentence(input.summary ?? "") || firstSentence(input.request) || `Console turn ${input.turnId}`;
  const request = input.request.trim();
  const summary = input.summary?.trim() ?? "";
  return [
    subject,
    "",
    "Request:",
    // Whole: the request and summary are already bounded (a message, a
    // batch, the agent's final message).
    request,
    ...(summary && firstSentence(summary) !== summary.replace(/\s+/g, " ") ? ["", "Summary:", summary] : []),
    "",
    `Agent: ${input.agentName} (${input.agentId})`,
    `Console-Turn: ${input.turnId}`,
  ].join("\n");
}

/** A teammate by name (case-insensitive) or id. */
export function findTeammate<T extends { id: string; name: string }>(agents: T[], to: string): T | null {
  const want = to.trim().toLowerCase();
  return agents.find((a) => a.id === to.trim()) ?? agents.find((a) => a.name.trim().toLowerCase() === want) ?? null;
}

/** A one-line description of a tool call, for Re-send and the timeline. */
export function callSummary(tool: string, args: Record<string, unknown>, names: { to?: string } = {}): string {
  const text = (v: unknown) => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    return s.length > 120 ? `${s.slice(0, 119)}…` : s;
  };
  switch (tool) {
    case "team_send":
      return `team_send to ${names.to ?? text(args.to)}: ${text(args.message)}`;
    case "team_ask":
      return `team_ask to ${names.to ?? text(args.to)}: ${text(args.message)}`;
    case "team_reply":
      return `team_reply to ${text(args.correlation_id)}: ${text(args.message)}`;
    case "team_report":
      return `team_report: ${text(args.message)}`;
    default:
      return tool;
  }
}

// ── The circle detector ──────────────────────────────

/**
 * The pair of agents that has exchanged the most messages since the tab's
 * last progress, when that is at least `limit`; else null. A message counts
 * when an agent sent it (not the owner) from a turn after `since`: the
 * tab's latest commit, owner message or Resume, as a turn id. Each pair is
 * counted on its own, in both directions.
 */
export function circlePair<T extends { from: string; to: string; fromTurn: number | null }>(
  messages: T[],
  since: number,
  limit: number,
): { a: string; b: string; count: number } | null {
  const counts = new Map<string, { a: string; b: string; count: number }>();
  for (const m of messages) {
    if (!m.from || m.from === m.to || m.fromTurn === null || m.fromTurn <= since) continue;
    const [a, b] = m.from < m.to ? [m.from, m.to] : [m.to, m.from];
    const key = `${a}\u0000${b}`;
    const c = counts.get(key) ?? { a, b, count: 0 };
    c.count++;
    counts.set(key, c);
  }
  let worst: { a: string; b: string; count: number } | null = null;
  for (const c of counts.values()) if (c.count >= limit && (!worst || c.count > worst.count)) worst = c;
  return worst;
}

// ── Reading a teammate's work ───────────────────────

/** The most of a patch one team_diff answer carries: about 15k tokens, so a
 * reviewer reads a large change file by file instead of all at once. */
export const TEAM_DIFF_CHARS = 60_000;

/** A Git C-quoted path ("a/\346\227\245.txt"): escapes and octal bytes,
 * read as UTF-8. Returns the text and where the closing quote ended. */
function unquote(s: string, at: number): { text: string; end: number } {
  const bytes: number[] = [];
  const named: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  let i = at + 1;
  for (; i < s.length && s[i] !== '"'; i++) {
    if (s[i] !== "\\") {
      bytes.push(...Buffer.from(s[i], "utf8"));
      continue;
    }
    const next = s[++i];
    if (/[0-7]/.test(next ?? "") && /^[0-7]{3}$/.test(s.slice(i, i + 3))) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(named[next] ?? next.charCodeAt(0));
  }
  return { text: Buffer.from(bytes).toString("utf8"), end: i + 1 };
}
/** The file a `diff --git a/X b/Y` header names (Y; X for a deletion is the
 * same path). Paths with spaces are read by halving the identical pair;
 * paths Git quotes (non-ASCII, quotes, control characters) are unquoted. */
function headerPath(line: string): string {
  const quoted = line.slice("diff --git ".length);
  if (quoted.includes('"')) {
    // Either side may be quoted: "a/…" "b/…", or a/… "b/…".
    let rest = quoted;
    if (rest.startsWith('"')) rest = rest.slice(unquote(rest, 0).end).trimStart();
    else rest = rest.slice(rest.indexOf(' "b/') + 1);
    if (rest.startsWith('"b/')) return unquote(rest, 0).text.slice(2);
  }
  const rest = line.slice("diff --git a/".length);
  const half = (rest.length - " b/".length) / 2;
  if (Number.isInteger(half) && half > 0 && rest.slice(half, half + 3) === " b/" && rest.slice(0, half) === rest.slice(half + 3)) return rest.slice(0, half);
  return /^(.*?) b\/(.*)$/.exec(rest)?.[2] ?? rest;
}
/** A patch cut into one section per file, in order. */
export function patchSections(patch: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const part of patch.split(/(?=^diff --git "?a\/)/m)) {
    if (!/^diff --git "?a\//.test(part)) continue;
    out.push({ path: headerPath(part.slice(0, part.indexOf("\n") < 0 ? part.length : part.indexOf("\n"))), text: part.endsWith("\n") ? part : `${part}\n` });
  }
  return out;
}

/**
 * What team_diff answers: a teammate's branch against its starting commit,
 * from the diff the Console keeps after each of its turns.
 * Whole files only, within `max` characters; the rest are named so the
 * reader can ask for them by path.
 */
export function teamDiffText(
  who: { name: string; branch: string | null; running: boolean },
  diff: { base: string; head: string; stat: string; patch: string; files: string[] } | null,
  path?: unknown,
  max = TEAM_DIFF_CHARS,
): string {
  if (!diff) return `${who.name} has no committed changes yet.`;
  const short = (sha: string) => sha.slice(0, 8);
  const running = who.running ? ` ${who.name} has a turn running now; its changes from that turn are not here until it ends.` : "";
  const head = `${who.name}'s branch${who.branch ? ` ${who.branch}` : ""} at ${short(diff.head)}, against ${short(diff.base)} (the commit it started from).${running}`;
  const sections = patchSections(diff.patch);
  let wanted = sections;
  let scope = "";
  let pattern: string | null = null;
  if (path !== undefined && path !== null && path !== "") {
    const p = claimPattern(path);
    if (typeof p !== "string") throw new TeamError(p.error);
    pattern = p;
    wanted = sections.filter((s) => claimCovers(p, s.path));
    scope = ` under ${pattern}`;
    if (!wanted.length) {
      const listed = diff.files.filter((f) => claimCovers(p, f));
      return listed.length
        ? `${head}\n\nThe changes${scope} (${listed.join(", ")}) could not be read here; read them with git in your own folder if you are Look only, or ask ${who.name} which parts matter.`
        : `${head}\n\nNo changes${scope}. Changed files: ${diff.files.join(", ") || "none"}.`;
    }
  }
  const shown: string[] = [];
  let used = 0;
  for (const s of wanted) {
    if (used + s.text.length > max) {
      // One file larger than the whole allowance is shown cut, alone.
      if (!shown.length) {
        shown.push(`${s.text.slice(0, max)}\n[… cut at ${max} characters]\n`);
        used = max;
      }
      break;
    }
    shown.push(s.text);
    used += s.text.length;
  }
  const missing = wanted.slice(shown.length).map((s) => s.path);
  // Files changed but not in the kept patch (it is bounded) are named too.
  const kept = new Set(sections.map((s) => s.path));
  const unkept = diff.files.filter((f) => !kept.has(f) && (pattern === null || claimCovers(pattern, f)));
  return [
    head,
    "",
    ...(scope ? [] : [diff.stat.trim(), ""]),
    shown.join("").trimEnd(),
    ...(missing.length || unkept.length
      ? ["", `Not shown here: ${[...missing, ...unkept].join(", ")}. Call team_diff with from and path for each.`]
      : []),
  ].join("\n");
}

/** The path pattern team_diff must read from Git because the kept patch
 * (bounded) lacks some of the files it names, or null. */
export function teamDiffMissing(diff: { patch: string; files: string[] } | null, path: unknown): string | null {
  if (!diff || path === undefined || path === null || path === "") return null;
  const pattern = claimPattern(path);
  if (typeof pattern !== "string") return null;
  const kept = new Set(patchSections(diff.patch).map((s) => s.path));
  return diff.files.some((f) => claimCovers(pattern, f) && !kept.has(f)) ? pattern : null;
}

// ── Claims and holds ─────────────────────────────────────────

const WILD = /[*?]/;
/** A claim pattern, normalized, or why it is not one: a path relative to
 * the agent's folder (`src/auth/**`, `README.md`, `docs/`), no `..`. */
export function claimPattern(raw: unknown): string | { error: string } {
  if (typeof raw !== "string") return { error: "A path must be text." };
  // "." components mean nothing in a path ("src/." is src; "." is all).
  const raw2 = raw.trim().replace(/\/+$/, "");
  const p = raw2 === "." ? "**" : raw2.split("/").filter((s, i, all) => s !== "." || all.length === 1).join("/");
  if (!p || p.length > 200 || p.startsWith("/") || p.includes("\0") || p.split("/").some((s) => s === ".." || s === "" || s === "."))
    return { error: `"${String(raw).slice(0, 60)}" is not a path inside your folder.` };
  // Only * and ? (and **) are wildcards here; brackets are not supported.
  if (/[[\]]/.test(p)) return { error: `"${String(raw).slice(0, 60)}": use * and ** instead of [ ] in a claim.` };
  return p;
}
const regex = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split("/")
      .map((seg) =>
        seg === "**"
          ? "\u0000"
          : seg.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"),
      )
      .join("/")
      .replace(/\u0000\//g, "(?:.*/)?")
      .replace(/\/\u0000/g, "(?:/.*)?")
      .replace(/\u0000/g, ".*")}(?:/.*)?$`,
  );
/** Whether a claim covers a path (relative to the folder). A pattern
 * without wildcards covers the path and anything below it. */
export function claimCovers(pattern: string, path: string): boolean {
  // The Mac's file system ignores case: src/A.ts and SRC/a.ts are one file.
  return regex(pattern.toLowerCase()).test(path.replace(/^\.\//, "").toLowerCase());
}
/** Whether two claims may overlap. Conservative: patterns whose fixed
 * leading folders nest count as overlapping. */
export function claimsOverlap(a: string, b: string): boolean {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (claimCovers(a, b) || claimCovers(b, a)) return true;
  const fixed = (p: string) => {
    const segs = p.split("/");
    const at = segs.findIndex((s) => WILD.test(s));
    return at < 0 ? null : segs.slice(0, at);
  };
  const fa = fixed(a);
  const fb = fixed(b);
  if (!fa && !fb) return false;
  const sa = fa ?? a.split("/");
  const sb = fb ?? b.split("/");
  const n = Math.min(sa.length, sb.length);
  return sa.slice(0, n).every((s, i) => s === sb[i]) && (fa ? true : sa.length >= sb.length) && (fb ? true : sb.length >= sa.length);
}

/** A hold cycle a new hold would close (names in order), or null. */
export function holdCycle(holds: { holder: string; held: string }[], holder: string, held: string): string[] | null {
  const next = new Map<string, string[]>();
  for (const h of [...holds, { holder, held }]) next.set(h.holder, [...(next.get(h.holder) ?? []), h.held]);
  // A path from the new hold's held agent back to its holder is a cycle.
  const seen = new Set<string>();
  const walk = (at: string, path: string[]): string[] | null => {
    if (at === holder) return path;
    if (seen.has(at)) return null;
    seen.add(at);
    for (const n of next.get(at) ?? []) {
      const found = walk(n, [...path, n]);
      if (found) return found;
    }
    return null;
  };
  return walk(held, [holder, held]);
}
