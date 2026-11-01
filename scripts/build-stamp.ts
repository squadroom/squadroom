// After `next build`: records the commit the build was made from in
// `.next/squadroom-build.json`, which `npm run web` checks before it serves
// the build (src/lib/shared/web-server.ts). Offline.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_STAMP, type BuildStamp } from "../src/lib/shared/web-server.ts";

let commit: string | null = null;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
} catch {
  // Not a Git checkout: the build is served without a commit check.
}
const stamp: BuildStamp = { commit, builtAt: new Date().toISOString() };
writeFileSync(join(process.cwd(), ".next", BUILD_STAMP), `${JSON.stringify(stamp)}\n`);
console.log(`Build stamped: ${commit ? commit.slice(0, 12) : "no Git commit"}.`);
