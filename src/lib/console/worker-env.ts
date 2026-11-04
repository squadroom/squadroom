import nextEnv from "@next/env";

// What the Console worker takes from the .env files: the backup folder, the
// e-mail settings (with SERVER_PUBLIC_ORIGIN, for links in them), the
// dead-man's switch and the Codex review switch, nothing else. The process's own environment wins, as in Next.js.

const WORKER_ENV_NAMES = [
  "CONSOLE_BACKUP_DIR",
  "CONSOLE_RESEND_API_KEY",
  "CONSOLE_MAIL_FROM",
  "CONSOLE_NOTIFY_EMAIL",
  "SERVER_PUBLIC_ORIGIN",
  "CONSOLE_HEALTHCHECK_URL",
  "CONSOLE_WEB_HEALTH_URL",
  "CONSOLE_CODEX_REVIEW",
];

/** The named values from `dir`'s .env files and the process's environment;
 * every other name the files add is removed from `process.env` again.
 *
 * `loadEnvConfig`'s `combinedEnv` is `process.env` itself, so the values are
 * copied out before the files' names are removed: read afterwards, they
 * were gone, and the worker would run with no backup folder. */
export function workerEnv(dir: string): Record<string, string> {
  const before = { ...process.env };
  const { combinedEnv } = nextEnv.loadEnvConfig(dir, false);
  const picked: Record<string, string> = {};
  for (const name of WORKER_ENV_NAMES) if (combinedEnv[name] !== undefined) picked[name] = combinedEnv[name];
  for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name];
  Object.assign(process.env, before);
  return picked;
}
