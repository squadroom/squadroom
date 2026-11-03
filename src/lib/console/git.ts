import { UPLOADS_DIR } from "./files.ts";
import type { RunResult } from "./launcher.ts";

// Git for the Console: what its GitHub client (github-api.ts), the owner's
// mirror (mirror.ts) and the agents' clones (clone.ts) share. That is
// repository and branch names, the console/ branches the worker pushes,
// the folders never committed, and the error every Git failure becomes.

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/** `owner/name` from a GitHub URL or slug; null when it is not one. */
export function parseRepo(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const text = input.trim().replace(/\/$/, "").replace(/\.git$/, "");
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(text);
  if (!match || match[2] === "." || match[2] === "..") return null;
  return `${match[1]}/${match[2]}`;
}
/** A branch name Git and the Console both accept for a base branch. */
export function validBranch(name: unknown): name is string {
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    !name.endsWith(".")
  );
}
/** The only branches the worker ever pushes. */
export const CONSOLE_BRANCH = /^console\/[a-z0-9][a-z0-9-]{0,80}$/;
/** An editing agent's branch: by id, so renaming changes nothing. */
export function consoleBranch(agentId: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return `console/${agentId}${slug ? `-${slug}` : ""}`;
}
/** Where a turn's temporary files go inside a Codex clone. */
export const CLONE_TMP = ".console-tmp";
/** Never committed or pushed: a Codex thread's temporary folder and the
 * owner's uploads. */
export const CONSOLE_DIRS = [CLONE_TMP, UPLOADS_DIR];
/** A Git command that failed, as a GitError: the last lines it printed,
 * with the token taken out. */
export const fail = (what: string, r: RunResult, token?: string | null) => {
  let detail = r.stderr.split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 400);
  if (token) detail = detail.split(token).join("[redacted]");
  return new GitError(`${what} failed${detail ? `: ${detail}` : ` (exit ${r.code})`}`);
};
