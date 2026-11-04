// The Console's worker: the only process that runs Console agents, with
// its own lease and store, separate from the web server (restarting one
// never interrupts the other). `npm run console:worker`. It keeps nothing
// from the .env files but the backup folder, the e-mail settings,
// SERVER_PUBLIC_ORIGIN (for links in its e-mails), the dead-man's switch
// and the Codex review switch; agents get only the
// credential the worker selects from ~/.squadroom/console-keys.json.
import { ConsoleStore } from "../src/lib/console/store.ts";
import { ConsoleWorker } from "../src/lib/console/worker.ts";
import { Launcher } from "../src/lib/console/launcher.ts";
import {
  agentHostProblems,
  consoleClientBinary,
  consoleKeysFile,
  consoleLauncher,
  consoleLogFile,
  consolePaths,
  consoleStorePath,
  consoleUploadsDir,
} from "../src/lib/console/config.ts";
import { jsonLog } from "../src/lib/console/log.ts";
import { workerEnv } from "../src/lib/console/worker-env.ts";
import { backupSettings } from "../src/lib/console/backup.ts";
import { mailSettings } from "../src/lib/shared/mail.ts";
import { healthSettings } from "../src/lib/shared/healthcheck.ts";
import { codexReviewSetting } from "../src/lib/console/pull-request.ts";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { envFileProblem } from "../src/config/server-env.ts";

// The worker's log: JSON lines the Logs page reads; startup problems also
// go to standard error, which the LaunchAgent keeps.
const log = jsonLog(consoleLogFile());
const fail = (line: string) => {
  console.error(`[console] ${line}`);
  log(line);
};
// A .env.local any account can read is refused, as by the web server.
const root = fileURLToPath(new URL("..", import.meta.url));
const envProblem = envFileProblem(`${root}.env.local`, statSync(`${root}.env.local`, { throwIfNoEntry: false })?.mode);
if (envProblem) {
  fail(`worker did not start: ${envProblem}`);
  process.exit(1);
}
// Only those settings are read from the .env files (shared with the web
// server); the rest of their contents is not kept.
const env = workerEnv(root);
const backup = backupSettings(env);
const mail = mailSettings(env);
// A ping URL without the web check it needs, or a Codex review switch that is
// neither on nor off, stops the start.
let health;
let codexReview;
try {
  health = healthSettings(env);
  codexReview = codexReviewSetting(env);
} catch (error) {
  fail(`worker did not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
// The agent host is checked before the worker starts: a shared folder
// agents cannot read would fail every agent's start with an opaque client
// error.
const paths = consolePaths();
const problems = agentHostProblems(paths);
if (problems.length) {
  fail(`worker did not start: ${problems.join(" ")}`);
  process.exit(1);
}

const storePath = consoleStorePath();
const store = new ConsoleStore(storePath);
const make = () =>
  new ConsoleWorker({
    store,
    launcher: new Launcher(consoleLauncher()),
    paths,
    binary: (kind) => consoleClientBinary(kind),
    keysFile: consoleKeysFile(),
    uploadsDir: consoleUploadsDir(),
    backup,
    mail,
    health,
    codexReview,
    storePath,
    log,
  });

let worker = make();
let waiting = false;
for (;;) {
  try {
    await worker.start();
    break;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A worker that just stopped holds its lease for up to a minute.
    if (/lease is current/.test(message)) {
      if (!waiting) log("waiting for the previous worker's lease to expire…");
      waiting = true;
      await new Promise((r) => setTimeout(r, 5_000));
      worker = make();
      continue;
    }
    fail(`worker did not start: ${message}`);
    await worker.stop().catch(() => {});
    process.exit(1);
  }
}
log(`worker settings: backups ${backup ? backup.dir : "off"}, health check ${health ? "on" : "off"}, e-mail ${mail ? "on" : "off"}${mail && !mail.origin ? " (no links: SERVER_PUBLIC_ORIGIN is not set)" : ""}`);
worker.onFatal = () => process.exit(1);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void worker.stop().finally(() => process.exit(0));
  });
