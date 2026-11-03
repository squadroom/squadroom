// Starts the web server: the Console's pages and commands and the sign-in,
// reached at your https address. Arguments go to the web server (for
// example `npm run web -- --port 3011`). The Console worker runs on its own
// (scripts/console-worker.ts).
//
// By default the web server is the built one (`next start`, after
// `npm run build`); `npm run web:dev` (or `--dev`) runs `next dev`
// instead. The built server refuses a build of another commit than the
// checkout's (src/lib/shared/web-server.ts). Run as a LaunchAgent by
// scripts/install-web-launch-agent.sh.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILD_STAMP, buildProblem, nextArgs, serverExitCode, webMode, webPort } from "../src/lib/shared/web-server.ts";
import { envFileProblem, setting } from "../src/config/server-env.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const envFile = `${root}.env.local`;
const envProblem = envFileProblem(envFile, statSync(envFile, { throwIfNoEntry: false })?.mode);
if (envProblem) {
  console.error(`[web] ${envProblem}`);
  process.exit(1);
}
const { mode, rest: args } = webMode(process.argv.slice(2));
const port = webPort(args, process.env);

if (mode === "start") {
  let stamp: unknown = null;
  try {
    stamp = JSON.parse(readFileSync(`${root}.next/${BUILD_STAMP}`, "utf8"));
  } catch {
    // No build yet: buildProblem says so.
  }
  // Outside a Git checkout (a packaged copy) the stamp alone is checked; in
  // one, a commit that cannot be read refuses, never skips the check.
  let head: string | null = null;
  if (existsSync(`${root}.git`)) {
    try {
      head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      // Reported below.
    }
    if (!head) {
      console.error("[web] This checkout's commit cannot be read (git rev-parse HEAD failed), so the build cannot be checked against it.");
      process.exit(1);
    }
  }
  const problem = buildProblem(stamp, head);
  if (problem) {
    console.error(`[web] ${problem}`);
    process.exit(1);
  }
}

const env = {
  ...process.env,
  // `next start` runs as production and loads .env.production* rather than
  // .env.development*.
  ...(mode === "start" ? { NODE_ENV: "production" as const } : {}),
  // The Console worker's health check reaches the web server directly on
  // loopback; only that Host is accepted without a session, and it returns
  // no data.
  SERVER_INTERNAL_HOST: setting(process.env, "SERVER_INTERNAL_HOST") ?? `127.0.0.1:${port}`,
};
const next = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

const server: ChildProcess = spawn(process.execPath, [next, ...nextArgs(mode, args)], { stdio: "inherit", env, cwd: root });
let exiting = false;
server.on("exit", (code) => {
  if (exiting) return;
  // The server ended by itself: never a clean exit, so the LaunchAgent
  // starts it again.
  process.exitCode = serverExitCode(code);
});
// A stop asked for (Ctrl-C, `launchctl bootout`) ends it and exits 0.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    exiting = true;
    server.kill(signal);
  });
