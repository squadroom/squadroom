import { firstSentence } from "./team.ts";
import { setting } from "../../config/server-env.ts";

// The pull request the Console opens after a push: its title and
// description, from what the agent gave team_push, else from its latest
// report and the branch's commits. Pure: the worker redacts and the GitHub
// calls live in github-api.ts.

/** What the agent (team_push) or the owner (Push branch) asked for. */
interface PushRequest {
  by: "agent" | "owner";
  title?: string;
  body?: string;
  /** Ask Codex to review even when the pull request already exists. */
  review?: boolean;
}

const PR_TITLE_MAX = 120;
/** GitHub refuses bodies over 65,536 characters; the footer and the commit
 * list need room. */
const PR_BODY_MAX = 50_000;
export const CODEX_REVIEW = "@codex review";

/** CONSOLE_CODEX_REVIEW: whether the worker comments `@codex review` on the
 * pull requests it opens, for repositories that use Codex's GitHub
 * reviewer. Off unless set to on, true or 1. */
export function codexReviewSetting(env: Record<string, string | undefined>): boolean {
  const value = setting(env, "CONSOLE_CODEX_REVIEW")?.trim().toLowerCase() ?? "";
  if (["on", "true", "1"].includes(value)) return true;
  if (["", "off", "false", "0"].includes(value)) return false;
  throw new Error("CONSOLE_CODEX_REVIEW must be on or off.");
}

/** A push request from untrusted input (team_push arguments). */
export function pushRequest(raw: Record<string, unknown>, by: PushRequest["by"]): PushRequest | { error: string } {
  const text = (v: unknown, name: string, max: number): string | undefined | { error: string } => {
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") return { error: `${name} must be text.` };
    if (v.trim().length > max) return { error: `${name} is at most ${max} characters.` };
    return v.trim() || undefined;
  };
  const title = text(raw.title, "title", PR_TITLE_MAX);
  if (title && typeof title === "object") return title;
  const body = text(raw.body, "body", PR_BODY_MAX);
  if (body && typeof body === "object") return body;
  if (raw.review !== undefined && typeof raw.review !== "boolean") return { error: "review must be true or false." };
  return { by, ...(title ? { title } : {}), ...(body ? { body } : {}), ...(raw.review ? { review: true } : {}) };
}

/**
 * The pull request's title and description. The agent's own words come
 * first; without them, the agent's latest report stands in, then the
 * commits. The footer says who opened it.
 */
export function pullRequestText(input: {
  request: PushRequest | null;
  agentName: string;
  model: string;
  branch: string;
  report: string | null;
  commits: string[];
}): { title: string; body: string } {
  const report = input.report?.trim() ?? "";
  const subjects = input.commits.map((c) => c.trim()).filter(Boolean);
  const title =
    input.request?.title ||
    firstSentence(report, 72) ||
    // Commits come newest first; the oldest names the work best.
    firstSentence(subjects.at(-1) ?? "", 72) ||
    `${input.agentName}'s work from Squadroom`;
  const described = input.request?.body || report;
  const commits = subjects.slice(0, 30).map((s) => `- ${s.split("\n")[0].slice(0, 120)}`);
  const parts = [
    described.slice(0, PR_BODY_MAX),
    ...(commits.length ? ["", "### Commits", "", ...commits, ...(subjects.length > 30 ? [`- and ${subjects.length - 30} more`] : [])] : []),
    "",
    "---",
    `Opened by Squadroom for ${input.agentName} (${input.model}), from \`${input.branch}\`.`,
  ];
  return { title: title.slice(0, PR_TITLE_MAX), body: parts.join("\n").trim() };
}

/** The most of a description the approval card shows; the request's input
 * keeps all of it. */
export const PUSH_SUMMARY_BODY = 1_200;
/** What the owner approves for team_push: the push, and the title and
 * description that will be posted from their account, as given. */
export function pushSummary(branch: string, request: PushRequest): string {
  const head = `Push ${branch} to GitHub and open its pull request${request.title ? `: "${request.title}"` : ""}`;
  if (!request.body) return `${head}\n\nNo description given: a new pull request is described by the agent's final message and its commits.`;
  const body = request.body.length > PUSH_SUMMARY_BODY ? `${request.body.slice(0, PUSH_SUMMARY_BODY)}\n… (cut here; the full description is in the request's input)` : request.body;
  return `${head}\n\nDescription:\n${body}`;
}

/** Whether to ask Codex to review after this push, when Codex reviews are
 * switched on: when the pull request is new, or when whoever pushed asked
 * again (the owner's Push branch always does: new code to look at). */
export function wantsReview(request: PushRequest | null, created: boolean): boolean {
  return created || request?.by === "owner" || request?.review === true;
}

// ── Reading the pull request (team_pr) ────────────────────────

/** The most of the pull request team_pr hands back. */
const PR_READ_CHARS = 60_000;
/** The Codex app's logins, exactly (REST names bots with "[bot]",
 * GraphQL without): anyone else's look-alike comments are not Codex. */
const CODEX_LOGINS = new Set(["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"]);
const isCodex = (login: string | undefined) => !!login && CODEX_LOGINS.has(login);

/** A GitHub comment as plain text: no HTML comments, badge images as their
 * label (P1, P2), no feedback prompts. */
export function cleanComment(body: string, max = 2_000): string {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[(P\d) Badge\]\([^)]*\)/g, "$1")
    .replace(/<\/?(sub|sup|details|summary|br)\s*\/?>/gi, "")
    .split("\n")
    .filter((l) => !/^\s*Useful\? React with/.test(l) && !/^\s*AGENTS\.md reference:/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Codex's latest review state, from its summary comment. */
export function codexState(comments: { author: string; body: string }[]): { status: string; commit: string | null; clean: boolean } | null {
  const mine = comments.filter((c) => isCodex(c.author));
  let state: { status: string; commit: string | null; clean: boolean } | null = null;
  for (const c of mine) {
    const m = /codex-review-state:v1 (\{.*?\}) -->/.exec(c.body);
    if (m) {
      try {
        const s = JSON.parse(m[1]) as { code_review?: { status?: string; commit_sha?: string | null } };
        state = { status: s.code_review?.status ?? "unknown", commit: s.code_review?.commit_sha?.slice(0, 8) ?? null, clean: false };
      } catch {
        /* Not the shape we know: ignored. */
      }
    }
    if (state && /Didn't find any major issues/.test(c.body)) state.clean = true;
  }
  return state;
}

type PrComment = { author: string; body: string; createdAt?: string; bot?: boolean };
type PrThread = { id: string; resolved: boolean; outdated: boolean; path: string | null; line: number | null; comments: PrComment[]; moreComments?: number };
type PrRead = { number: number; url: string; title: string; state: string; headSha: string; threads: PrThread[]; comments: PrComment[]; moreThreads?: boolean; moreConversation?: boolean };

/** One person's (or Codex's) comment is shown whole up to this; past it,
 * team_pr with that comment's number reads it all. */
const PR_COMMENT_CHARS = 8_000;
/** A single comment or thread asked for by number or id. */
const PR_ITEM_CHARS = 60_000;
const indent = (text: string) => text.replace(/\n/g, "\n    ");
/** Codex's review summary, or a deploy bot's hidden metadata: not talk. */
const boilerplate = (c: PrComment) => /codex-review-state:v1|codex-pull-request-review-summary/.test(c.body) || /^\s*\[vc\]:/.test(c.body);
const isBot = (c: PrComment) => c.bot === true || /\[bot\]$/.test(c.author);

/**
 * What team_pr answers: the pull request, whether the agent's branch has
 * moved past it, Codex's review state, the open review threads and the
 * conversation, each comment whole (up to PR_COMMENT_CHARS) with its line
 * breaks. Comments are numbered, so `focus` can ask for one comment or one
 * thread in full. Bounded; the caller redacts.
 */
export function pullRequestReviewText(
  pr: PrRead,
  branchHead: string | null,
  max = PR_READ_CHARS,
  focus: { comment?: number; thread?: string } = {},
): string {
  if (focus.comment !== undefined) {
    const c = pr.comments[focus.comment - 1];
    if (!c) return `Pull request #${pr.number} has no comment ${focus.comment}; it has ${pr.comments.length}${pr.moreConversation ? " read here (more on GitHub)" : ""}.`;
    // Hidden bot metadata stays out, however it is asked for.
    if (boilerplate(c)) return `Comment ${focus.comment} on pull request #${pr.number} is ${c.author}'s hidden status data, not a message; nothing to read.`;
    return `Comment ${focus.comment} on pull request #${pr.number}, from ${c.author}${c.createdAt ? ` (${c.createdAt})` : ""}:\n\n${cleanComment(c.body, PR_ITEM_CHARS)}`;
  }
  if (focus.thread !== undefined) {
    const t = pr.threads.find((x) => x.id === focus.thread);
    if (!t) return `Pull request #${pr.number} has no review thread ${focus.thread}.`;
    const where = t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "the whole pull request";
    return [
      `Thread ${t.id} on pull request #${pr.number}, ${where}${t.resolved ? " (resolved)" : ""}${t.outdated ? " (on an older commit)" : ""}:`,
      ...t.comments.map((c) => `\n${c.author}:\n${cleanComment(c.body, Math.floor(PR_ITEM_CHARS / Math.max(1, t.comments.length)))}`),
      ...(t.moreComments ? ["\n… the thread goes on past what could be read here; see the rest on GitHub."] : []),
    ].join("\n");
  }
  const head = pr.headSha.slice(0, 8);
  const moved = branchHead && !branchHead.startsWith(pr.headSha.slice(0, 7)) && !pr.headSha.startsWith(branchHead.slice(0, 7));
  const codex = codexState(pr.comments);
  const open = pr.threads.filter((t) => !t.resolved);
  const lines = [
    `Pull request #${pr.number} (${pr.state.toLowerCase()}): "${pr.title}" ${pr.url}`,
    moved
      ? `GitHub has your branch at ${head}; your folder is at ${branchHead!.slice(0, 8)}, so your newer commits are not on GitHub yet (team_push sends them).`
      : `GitHub has your branch at ${head}, the same as your folder.`,
    codex
      ? `Codex review: ${codex.status}${codex.commit ? ` on ${codex.commit}` : ""}${codex.status === "completed" ? (codex.clean ? ", no major issues" : `, ${open.filter((t) => isCodex(t.comments[0]?.author)).length} open finding(s)`) : ""}.`
      : "Codex review: none requested yet.",
    "",
    open.length ? `Open review threads (${open.length}):` : "No open review threads.",
  ];
  let used = lines.join("\n").length;
  const shown: string[] = [];
  for (const [i, t] of open.entries()) {
    const where = t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "the whole pull request";
    const text = [
      `[${i + 1}] thread ${t.id}, ${where}${t.outdated ? " (on an older commit)" : ""}`,
      ...t.comments.map((c, j) => `${j ? "  reply from" : "  from"} ${c.author}:\n    ${indent(cleanComment(c.body, PR_COMMENT_CHARS))}`),
      ...(t.moreComments ? [`  … and ${t.moreComments} later repl${t.moreComments === 1 ? "y" : "ies"} not read here; team_pr(thread: "${t.id}") reads it.`] : []),
    ].join("\n");
    if (used + text.length > max / 2) {
      // Their ids, so each can still be read on its own.
      const left = open.slice(i).map((x) => `${x.id}${x.path ? ` (${x.path}${x.line ? `:${x.line}` : ""})` : ""}`);
      shown.push(`… and ${left.length} more open thread(s) not shown for space: ${left.join(", ")}. team_pr(thread: "<id>") reads one.`);
      break;
    }
    shown.push(text);
    used += text.length;
  }
  const resolved = pr.threads.length - open.length;
  // The conversation, newest last: people's and Codex's comments whole (with
  // their line breaks); other bots in one short line; boilerplate left out.
  // When it does not all fit, the oldest are named, not shown.
  const talk: string[] = [];
  let skipped: number[] = [];
  for (let i = pr.comments.length - 1; i >= 0; i--) {
    const c = pr.comments[i];
    if (boilerplate(c)) continue;
    const n = i + 1;
    const text =
      isBot(c) && !isCodex(c.author)
        ? `[comment ${n}] ${c.author} (bot): ${cleanComment(c.body, 300).replace(/\s+/g, " ")}`
        : (() => {
            const full = cleanComment(c.body, Number.MAX_SAFE_INTEGER);
            const body = full.length > PR_COMMENT_CHARS ? `${full.slice(0, PR_COMMENT_CHARS)}\n… (cut at ${PR_COMMENT_CHARS} characters: team_pr(comment: ${n}) reads all of it)` : full;
            return `[comment ${n}] ${c.author}${c.createdAt ? ` (${c.createdAt})` : ""}:\n    ${indent(body)}`;
          })();
    if (used + text.length > max) {
      skipped.push(n);
      continue;
    }
    talk.unshift(text);
    used += text.length;
  }
  skipped = skipped.reverse();
  return [
    ...lines,
    ...shown,
    ...(resolved ? ["", `${resolved} resolved thread(s) not shown.`] : []),
    ...(pr.moreThreads ? ["", "This pull request has more review threads than were read; see the rest on GitHub."] : []),
    ...(pr.moreConversation ? ["", "This pull request has more comments than were read; the newest are on GitHub."] : []),
    ...(talk.length ? ["", "Conversation (newest last):", ...talk] : []),
    ...(skipped.length ? ["", `Not shown for space: comments ${skipped.join(", ")}; team_pr(comment: <number>) reads one.`] : []),
    "",
    "Answer a thread with team_pr_reply(thread, message, resolve). Push fixes with team_push: it also replaces the pull request's title and description with the ones you give (review: true asks Codex again, when Codex reviews are on).",
  ].join("\n");
}
