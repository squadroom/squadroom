import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { TestContext } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./console-harness.ts";

// A stand-in for GitHub: a local bare repository, and a fake API that
// answers the repository, branch and ruleset checks.

/** A bare "GitHub" repository with `main` holding one file. */
export function origin(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "console-origin-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, "work");
  const bare = join(root, "repo.git");
  git(root, "init", "--quiet", "-b", "main", work);
  writeFileSync(join(work, "README.md"), "# Demo\n");
  git(work, "add", "README.md");
  git(work, "-c", "user.name=Owner", "-c", "user.email=o@x", "commit", "--quiet", "-m", "first");
  git(root, "clone", "--quiet", "--bare", work, bare);
  return bare;
}

export const RULESET = {
  id: 7,
  enforcement: "active",
  target: "branch",
  conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request" }],
  current_user_can_bypass: "never",
};
export function api(ruleset: Record<string, unknown> | null = RULESET, seen: string[] = []) {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    seen.push(new Headers(init.headers).get("authorization") ?? "");
    const json = (v: unknown) => Response.json(v);
    if (url.endsWith("/repos/owner/repo")) return json({ id: 1 });
    if (url.endsWith("/branches/main")) return json({ name: "main" });
    if (url.includes("/branches/")) return new Response("{}", { status: 404 });
    if (url.includes("/rulesets?")) return json(ruleset ? [{ id: 7 }] : []);
    if (url.endsWith("/rulesets/7")) return json(ruleset);
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}
