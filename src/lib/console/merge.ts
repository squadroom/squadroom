// team_merge: an agent asks for a Console pull request to be
// merged, the owner approves it in Needs you, and the worker asks GitHub to
// squash-merge it at the commit the owner saw. Pure: what blocks a merge,
// and every text the owner and the agents read. The GitHub calls are in
// git.ts, the checks around them in repos.ts.

import { codexState, outcome } from "./pull-request.ts";

/** A pull request as GitHub's REST API describes it, for a merge. */
export interface PullState {
  number: number;
  url: string;
  title: string;
  /** "open" or "closed". */
  state: string;
  merged: boolean;
  draft: boolean;
  /** null while GitHub is still working it out. */
  mergeable: boolean | null;
  /** clean, dirty (conflicts), blocked, behind, unstable, unknown, … */
  mergeableState: string;
  headRef: string;
  headSha: string;
  /** `owner/name` of the repository the branch is in; null when it is gone. */
  headRepo: string | null;
  baseRef: string;
  /** The commit GitHub made on the base branch, once it is merged. */
  mergeCommit: string | null;
}

/** What the owner approves, kept with the Needs you item and then with the
 * merge job: the pull request and the one commit the approval is for. */
export interface MergeAsk {
  number: number;
  url: string;
  title: string;
  branch: string;
  base: string;
  /** The pull request's head when it was asked for: the merge is pinned to it. */
  sha: string;
  /** The agent whose branch it is (the asking agent, or another of its project). */
  authorId: string;
  authorName: string;
  /** One line on its checks, and one on its review when GitHub gave it. */
  checks: string;
  review: string | null;
  /** Other agents of the project that asked for the same commit while this
   * request waited: they are told the outcome too. */
  alsoAsked?: string[];
}

type Job = { id: number; run: string; name: string; status: string; conclusion: string | null };
const short = (sha: string) => sha.slice(0, 8);
const jobName = (j: Job) => `${j.run ? `${j.run} / ` : ""}${j.name}`.slice(0, 120);
const listed = (names: string[], max = 6) => `${names.slice(0, max).join(", ")}${names.length > max ? ` and ${names.length - max} more` : ""}`;

/** The squash commit's title, as GitHub writes it: the pull request's
 * title and its number. */
export const mergeCommitTitle = (title: string, number: number) => `${title} (#${number})`;

export const notFound = (number: number, repo: string) => `Pull request #${number} was not found in ${repo}.`;
export const notConsole = (number: number) =>
  `Pull request #${number} is not one the Console opened for an agent of this project, so it cannot be merged from here.`;

/** Why GitHub's own state of the pull request rules a merge out, or null. */
export function pullRefusal(pr: PullState): string | null {
  const n = `Pull request #${pr.number}`;
  const base = pr.baseRef;
  if (pr.merged) return `${n} is already merged.`;
  if (pr.state !== "open") return `${n} is closed, not open.`;
  if (pr.draft) return `${n} is a draft. It has to be marked ready for review on GitHub first, which only the owner can do.`;
  if (pr.mergeable === false || pr.mergeableState === "dirty")
    return `${n} conflicts with ${base}, so GitHub cannot merge it. Its branch needs ${base} brought in: team_pull(from: "${base}") in that branch's own folder, resolve the conflicts, push with team_push, then ask again.`;
  if (pr.mergeable === null || pr.mergeableState === "unknown") return `GitHub has not worked out yet whether pull request #${pr.number} can be merged. Ask again in a minute.`;
  if (pr.mergeableState === "behind")
    return `${n}'s branch is behind ${base}, and this repository only merges a branch that is up to date. Bring ${base} in with team_pull(from: "${base}"), push with team_push, then ask again.`;
  if (pr.mergeableState === "blocked")
    return `GitHub says pull request #${pr.number} cannot be merged yet: a rule of the repository blocks it (a required review or a required check). Only the owner can change that, on GitHub.`;
  return null;
}

/** Why the checks rule a merge out, or null: every GitHub Actions job of
 * the commit must have finished and passed (skipped and neutral count as
 * passed; no job at all is fine). The ones that failed, ended without a
 * result or still run are named. */
export function checksRefusal(number: number, sha: string, jobs: Job[], incomplete: boolean): string | null {
  const by = (o: ReturnType<typeof outcome>) => jobs.filter((j) => outcome(j) === o);
  const parts = [
    ...(by("failed").length ? [`failed: ${listed(by("failed").map(jobName))}`] : []),
    ...(by("other").length ? [`ended without a result: ${listed(by("other").map(jobName))}`] : []),
    ...(by("running").length ? [`still running: ${listed(by("running").map(jobName))}`] : []),
  ];
  if (parts.length)
    return `Pull request #${number}'s checks have not all passed for ${short(sha)} (${parts.join("; ")}). It is merged only once every check has finished and passed: read them with team_checks, fix and push what failed, or ask again when they are done.`;
  if (incomplete) return `GitHub has more checks for ${short(sha)} than the Console reads, so it cannot tell that all of them passed. The owner merges pull request #${number} on GitHub.`;
  return null;
}

/** GitHub's own word that some check of the commit has not passed, when
 * the jobs the Console reads all have (a deployment's status, say). */
export const unstableRefusal = (number: number) =>
  `GitHub reports a check on pull request #${number} that has not passed and is not a GitHub Actions job (a deployment's status, say). It is merged only once every check has passed: look at the pull request's page, or ask again when it is done.`;

/** The branch on GitHub is not what its agent has committed. */
export const unpushedRefusal = (who: string | null, number: number, folder: string, github: string) =>
  `${who ? `${who}'s folder` : "Your folder"} has commits that are not on GitHub yet (it is at ${short(folder)}, pull request #${number} at ${short(github)}). ${who ? `${who} pushes` : "Push"} with team_push first; ask again once that push shows as done.`;

/** The pull request's head is no longer the commit the owner approved. */
export const movedRefusal = (ask: Pick<MergeAsk, "number" | "sha">, now: string) =>
  `Pull request #${ask.number} changed after it was asked for: the approval was for ${short(ask.sha)}, and its branch is now at ${short(now)}. Nothing was merged. Ask again with team_merge, so the owner approves the commit that is there now.`;

/** One line on the checks, for the owner. */
export function checksLine(jobs: Job[]): string {
  if (!jobs.length) return "Checks: none ran for this commit.";
  const skipped = jobs.filter((j) => j.conclusion === "skipped" || j.conclusion === "neutral").length;
  return `Checks: all ${jobs.length} passed${skipped ? ` (${skipped} skipped)` : ""}.`;
}

/** One line on the review, for the owner: Codex's state and the open
 * review threads, as team_pr reads them. Shown, never blocking. */
export function reviewLine(review: { comments: { author: string; body: string }[]; threads: { resolved: boolean }[]; moreThreads?: boolean }): string {
  const codex = codexState(review.comments);
  const open = review.threads.filter((t) => !t.resolved).length;
  const state = codex ? `${codex.status}${codex.commit ? ` on ${codex.commit}` : ""}${codex.status === "completed" && codex.clean ? ", no major issues" : ""}` : "none requested";
  return `Codex review: ${state}. Open review threads: ${open}${review.moreThreads ? " or more" : ""}.`;
}

/** The owner's Needs you item (the tray shows who asks above it, and the
 * pull request's link beside it). */
export function mergeAskText(ask: MergeAsk, own: boolean): string {
  return [
    `Merge pull request #${ask.number} into ${ask.base}: "${ask.title}"`,
    `${own ? "Its" : `${ask.authorName}'s`} branch ${ask.branch} → ${ask.base} · Squash and merge · commit ${short(ask.sha)}`,
    ask.checks,
    ...(ask.review ? [ask.review] : []),
  ].join("\n");
}

/** What the asking agent is answered. */
export const mergeAsked = (ask: MergeAsk) =>
  `Asked the owner to merge pull request #${ask.number} into ${ask.base} (squash), at commit ${short(ask.sha)}. It waits in their Needs you and stays there after your turn ends; this does not wait for the answer. The Console tells you the result as soon as it comes, starting a turn if you are not working, so end your turn now instead of waiting. The approval is for this commit only: a push to ${ask.branch} before then means asking again.`;
export const mergeWaiting = (ask: MergeAsk) =>
  `Pull request #${ask.number} at commit ${short(ask.sha)} is already waiting for the owner in their Needs you. Nothing more to do: the Console tells you the result as soon as it comes.`;
export const mergeRunning = (number: number) => `The owner has approved merging pull request #${number} and the Console is merging it now. It tells you the result as soon as it comes.`;

/** The line in the windows of the asking agent and the branch's agent. */
export const mergedLine = (ask: MergeAsk, commit: string) =>
  `Merged pull request #${ask.number} into ${ask.base} (squash, commit ${short(commit)}), approved by the owner. ${ask.authorName}'s branch ${ask.branch} is now part of ${ask.base}: its next work should start with team_pull(from: "${ask.base}").`;
export const notMergedLine = (number: number, reason: string) => `Pull request #${number} was not merged: ${reason}`;

/** What an agent is told (as news) once the merge went through:
 * the agent whose branch it was (`own`), or the one that asked for it. */
export function mergedNote(ask: MergeAsk, commit: string, own: boolean, askedBy: string | null): string {
  const how = `into ${ask.base} (squash, commit ${short(commit)})`;
  if (!own) return `Pull request #${ask.number} (${ask.authorName}'s) was merged ${how}, as the owner approved.`;
  return `Your pull request #${ask.number} was merged ${how}${askedBy ? `: ${askedBy} asked for it and the owner approved` : ", as the owner approved"}. Your branch's work is now on ${ask.base} as one commit, and the pull request is closed. Start your next work with team_pull(from: "${ask.base}"); your next team_push then opens a new pull request.`;
}
/** … when it did not, though the owner approved. */
export const notMergedNote = (number: number, reason: string) =>
  `Pull request #${number} was not merged, though the owner approved it. ${reason}\nNothing was merged. Once that is settled, ask again with team_merge.`;
/** … when the owner said no. */
export const deniedNote = (number: number) =>
  `The owner did not approve merging pull request #${number}, so it was not merged. Do not ask for it again until the owner tells you to.`;
/** The owner's Needs you note when an approved merge did not go through. */
export const notMergedNotice = (number: number, reason: string) => `Pull request #${number} was not merged after your approval. ${reason}`;

/** GitHub's answer to the merge never arrived and the pull request could
 * not be read again afterwards: it may or may not be merged. */
export const mergeUncertain = (number: number, reason: string) =>
  `It is not known whether GitHub merged pull request #${number}: its answer did not arrive (${reason}). Look at the pull request on GitHub (an agent: team_pr); if it is still open, the agent asks again with team_merge.`;

/** The worker restarted while it was asking GitHub (for both). */
export const mergeUnknown = (number: number) =>
  `The Console worker restarted while it was merging pull request #${number}, so it is not known whether GitHub merged it. Look at the pull request on GitHub (an agent: team_pr); if it is still open, the agent asks again with team_merge.`;

// ── A merge GitHub refused, in plain words (as push-failure.ts does) ──────

export interface MergeHint {
  text: string;
  who: "owner" | "agent";
}
const CAUSES: { match: RegExp; hint: MergeHint }[] = [
  {
    match: /head branch was modified|\(409\b/i,
    hint: { who: "agent", text: "GitHub refused because the branch changed between the approval and the merge, so nothing was merged. Ask again with team_merge: the owner then approves the commit that is there now." },
  },
  {
    match: /squash merges are not allowed/i,
    hint: { who: "owner", text: "GitHub refused because squash merging is switched off for this repository. The owner has to act: switch on Allow squash merging (the repository's Settings → General → Pull Requests), then have the agent ask again." },
  },
  {
    match: /workflow/i,
    hint: { who: "owner", text: "GitHub refused because this pull request changes a workflow file (.github/workflows/…) and the Console's GitHub token may not change workflows. The owner has to act: add the Workflows permission to that token (classic token: the `workflow` scope), or merge this one on GitHub." },
  },
  {
    match: /rule violations|protected branch|required status check|review is required|approving review|not mergeable|\(405\b/i,
    hint: { who: "owner", text: "GitHub refused because a branch protection rule or ruleset of the repository does not allow this merge (a required review, a required check, or a rule the Console's token may not pass). The owner has to act: change that rule on GitHub, or merge this one there." },
  },
  {
    match: /bad credentials|\(401\b/i,
    hint: { who: "owner", text: "GitHub did not accept the Console's GitHub token: it has expired, was revoked or is wrong. The owner has to act: put a working token on the Keys page, then have the agent ask again." },
  },
  {
    match: /resource not accessible|\(403\b|\(404\b/i,
    hint: { who: "owner", text: "GitHub refused because the Console's GitHub token may not merge pull requests in this repository. The owner has to act: give that token Contents: Read and write and Pull requests: Read and write for it (Settings → Developer settings → Fine-grained tokens), then have the agent ask again." },
  },
];
/** The plain hint for a refused merge, or null when the cause is not one
 * the Console knows. */
export function mergeHint(failure: string): MergeHint | null {
  return CAUSES.find((c) => c.match.test(failure))?.hint ?? null;
}
/** A refused merge's reason: the hint, then GitHub's own words. */
export function mergeFailure(failure: string): string {
  const hint = mergeHint(failure);
  return hint ? `${hint.text} (${failure})` : failure;
}
