// A failed push, said in plain words. Pure: the worker passes
// the failure's text, already redacted, and puts what these return in the
// owner's Needs you and in what the agent is told next.

/** The most of a failure's own text that either message carries (Git's
 * own words come already cut to 400 characters, after what failed). */
export const PUSH_FAILURE_CHARS = 500;

/** A cause the Console knows: what it means, and who has to act. */
export interface PushHint {
  text: string;
  who: "owner" | "agent";
}

/** Known causes, by the words Git or GitHub uses for them; the first that
 * matches. The workflow refusal comes first: Git reports it as a "remote
 * rejected" line like any rule's. */
const CAUSES: { match: RegExp; hint: PushHint }[] = [
  {
    match: /create or update workflow|without `?workflows?`? (scope|permission)/i,
    hint: {
      who: "owner",
      text: "GitHub refused because this branch changes a workflow file (.github/workflows/…) and the Console's GitHub token may not change workflows. Add the Workflows permission to that token (classic token: the `workflow` scope), then push again.",
    },
  },
  {
    match: /non-fast-forward|\(fetch first\)|cannot force-push/i,
    hint: {
      who: "agent",
      text: "GitHub refused because the branch there has commits this push would throw away (a non-fast-forward rejection). The agent has to act: its branch must keep every commit already pushed (no rebase or amend of them), then push again.",
    },
  },
  {
    match: /GH006|GH013|protected branch|repository rule violations|rule violations found/i,
    hint: {
      who: "owner",
      text: "GitHub refused because a branch protection rule or ruleset of the repository does not allow this push. The owner has to act: change that rule on GitHub or let the Console's token past it; the agent cannot.",
    },
  },
  {
    match: /bad credentials|authentication failed|invalid username or (password|token)|\(401\)|(error|status|status code|HTTP|answered):? 401\b/i,
    hint: {
      who: "owner",
      text: "GitHub did not accept the Console's GitHub token: it has expired, was revoked or is wrong. The owner has to act: put a working token on the Keys page, then push again.",
    },
  },
];

/** The plain hint for a failure's text, or null when the cause is not one
 * the Console knows. */
export function pushHint(failure: string): PushHint | null {
  return CAUSES.find((c) => c.match.test(failure))?.hint ?? null;
}

/** The owner's Needs you item: the branch and the reason (the tray shows
 * the agent's name above it). */
export function pushFailedNotice(branch: string | null, failure: string): string {
  const hint = pushHint(failure);
  const what = `The push of ${branch ?? "its branch"} did not go through.`;
  return hint ? `${what} ${hint.text}\n\nDetails: ${failure}` : `${what} ${failure}`;
}

/** What the agent is told, once (with its next turn, or a turn the
 * Console starts for it when it is idle); team_pr
 * says it too while the failed push is the agent's latest. */
export function pushFailedNote(failure: string): string {
  const hint = pushHint(failure);
  const reason = hint ? `${hint.text} (${failure})` : failure;
  const who =
    hint?.who === "agent"
      ? "This is yours to fix."
      : hint
        ? "Only the owner can fix this, and it is in their Needs you."
        : "The owner has been told in their Needs you.";
  return `Your last push did not go through. ${reason}\n${who} Asking for the same push again (team_push) will fail the same way until the cause is fixed.`;
}
