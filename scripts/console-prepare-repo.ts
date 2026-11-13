// Prepare a GitHub repository for the Console from the terminal:
//   npm run console:prepare-repo -- owner/name [base branch, default main]
// It uses your own `gh` sign-in (an admin of the repository), not the
// Console's token: it creates the base branch if it is missing, adds the
// "Squadroom base" ruleset, runs the worker's check, and has the worker check
// again any Console project of that repository whose checks failed.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { consoleStorePath } from "../src/lib/console/config.ts";
import { parseRepo, validBranch } from "../src/lib/console/git.ts";
import { prepareRepo } from "../src/lib/console/prepare-repo.ts";
import { ConsoleStore } from "../src/lib/console/store.ts";

const [repoArg, baseArg = "main"] = process.argv.slice(2);
const repo = parseRepo(repoArg);
if (!repo || !validBranch(baseArg)) {
  console.error("Usage: npm run console:prepare-repo -- owner/name [base branch, default main]");
  process.exit(2);
}
let token: string;
try {
  token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
} catch {
  console.error("Sign in to GitHub first: gh auth login");
  process.exit(1);
}
try {
  const done = await prepareRepo(repo, baseArg, { token });
  for (const line of done) console.log(line);
  console.log(`${repo} is ready for the Console (base ${baseArg}).`);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const path = consoleStorePath();
if (existsSync(path)) {
  const store = new ConsoleStore(path);
  for (const p of store.projects())
    if (p.repo === repo && p.baseBranch === baseArg && p.state === "error" && p.archivedAt === null) {
      store.recheckProject(p.id);
      console.log(`The Console is checking "${p.name}" again.`);
    }
  store.close();
}
