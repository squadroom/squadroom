// The web server's environment: what the web server, its sign-in and the
// Console need. Nothing else under src/ reads `process.env` (scripts load
// .env files themselves). See .env.example.

export type Env = Record<string, string | undefined>;

/** A setting by name, or undefined when it is unset. */
export function setting(env: Env, name: string): string | undefined {
  return env[name];
}

/** The server's whole environment, for modules that parse a record of it
 * (the Console's paths). */
export function serverEnv(): NodeJS.ProcessEnv {
  return process.env;
}
/** A production build (`next build`), not the development server. */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Why the server must not start with this `.env.local` (its mode, or
 * undefined when there is none): one every account on the Mac can read,
 * the `agent` user's included, would hand its secrets to any agent. */
export function envFileProblem(path: string, mode: number | undefined): string | null {
  if (mode === undefined || !(mode & 0o004)) return null;
  return `${path} can be read by every account on this Mac, the agent user's included. Make it yours alone, then start again: chmod 600 ${path}`;
}

/** The web process's settings. None of them is an agent credential: the web
 * holds only the sign-in settings (and, optionally, the mail key that sends
 * sign-in codes). */
export interface ServerSettings {
  /** https origin you open Squadroom at (checked against `Origin`, used in links). */
  publicOrigin: string;
  /** Host header of the worker's internal health check (`127.0.0.1:<port>`). */
  internalHost: string;
  /** Your own GitHub OAuth app, and the one GitHub account allowed in. */
  githubClientId: string;
  githubClientSecret: string;
  ownerGithubId: number;
}

const required = (env: Env, name: string) => {
  const value = setting(env, name)?.trim();
  if (!value) throw new Error(`Squadroom needs ${name} (see .env.example).`);
  return value;
};

/** Throws when a setting is missing or malformed: a server with an
 * incomplete sign-in must not serve anything. */
export function serverSettings(env: Env = process.env): ServerSettings {
  const origin = required(env, "SERVER_PUBLIC_ORIGIN");
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin.replace(/\/$/, ""))
    throw new Error("SERVER_PUBLIC_ORIGIN must be an https origin such as https://squadroom.example.");
  const githubId = required(env, "SERVER_OWNER_GITHUB_ID");
  if (!/^[1-9]\d{0,15}$/.test(githubId))
    throw new Error("SERVER_OWNER_GITHUB_ID must be your numeric GitHub account ID.");
  const internalHost = setting(env, "SERVER_INTERNAL_HOST")?.trim() || "127.0.0.1:3000";
  // Only the worker's own loopback request may skip the session: never the
  // public address or any other name.
  const port = /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(internalHost)?.[1];
  if (!port || Number(port) > 65535)
    throw new Error("SERVER_INTERNAL_HOST must be 127.0.0.1:<port>.");
  return {
    publicOrigin: url.origin,
    internalHost,
    githubClientId: required(env, "SERVER_GITHUB_CLIENT_ID"),
    githubClientSecret: required(env, "SERVER_GITHUB_CLIENT_SECRET"),
    ownerGithubId: Number(githubId),
  };
}

/** The paths the server serves: a path is served exactly, or with anything
 * below it when it ends in "/". Everything else is 404; the routes check
 * the session. */
export const SERVED_PATHS: Record<string, readonly string[]> = {
  console: ["/console", "/console/", "/api/console", "/api/console/"],
  signIn: ["/login", "/api/auth", "/api/auth/"],
};
export function servedPath(path: string): boolean {
  return Object.values(SERVED_PATHS).some((paths) =>
    paths.some((served) => (served.endsWith("/") ? path.startsWith(served) : path === served)),
  );
}
