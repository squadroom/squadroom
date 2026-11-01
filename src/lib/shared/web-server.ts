// How `npm run web` starts the web server: a built `next start` for daily
// use, or `next dev` while developing. Pure, so the rules are tested;
// scripts/web.ts is the glue.
//
// A development server keeps old module objects across a hot reload after a
// pull (2026-10-22: the Keys page failed until a restart). A built server
// runs exactly the code it was built from, so each update is: pull, build,
// restart. The build records the commit it was made from
// (`scripts/build-stamp.ts`), and the built server refuses to start from a
// build of another commit, so a pull without a build never serves old code
// under new docs.

export type WebMode = "start" | "dev";

/** The stamp `npm run build` leaves in `.next`. */
export const BUILD_STAMP = "squadroom-build.json";

export interface BuildStamp {
  /** The commit built, or null outside a Git checkout. */
  commit: string | null;
  builtAt: string;
}

/** Bundler flags only `next dev` takes; `next start` refuses them, and an
 * owner's usual command (`--webpack`) should keep working. */
const DEV_ONLY = new Set(["--webpack", "--turbopack", "--turbo"]);

/** The mode, from `--dev` among the arguments, and the arguments left. */
export function webMode(args: string[]): { mode: WebMode; rest: string[] } {
  return { mode: args.includes("--dev") ? "dev" : "start", rest: args.filter((a) => a !== "--dev") };
}

/** The web server's port, as Next reads it: --port N, --port=N, -p N, then
 * PORT, then 3000. */
export function webPort(args: string[], env: Record<string, string | undefined>): string {
  const flag = args.findIndex((a) => a === "--port" || a === "-p");
  return (flag >= 0 ? args[flag + 1] : args.find((a) => a.startsWith("--port="))?.slice(7)) ?? env.PORT ?? "3000";
}

/** Next's command line: always on loopback (an https proxy is the way in). */
export function nextArgs(mode: WebMode, args: string[]): string[] {
  return [mode, "--hostname", "127.0.0.1", ...(mode === "start" ? args.filter((a) => !DEV_ONLY.has(a)) : args)];
}

/** Why the built server must not start, or null: no build, or a build of
 * another commit than the checkout's. */
export function buildProblem(stamp: unknown, head: string | null): string | null {
  const s = stamp as Partial<BuildStamp> | null;
  if (!s || typeof s !== "object" || typeof s.builtAt !== "string")
    return "There is no build to serve. Run `npm run build` first (or `npm run web:dev` for the development server).";
  if (head && s.commit !== head)
    return `The build is of ${s.commit ? s.commit.slice(0, 12) : "an unknown commit"}, but the checkout is at ${head.slice(0, 12)}. Run \`npm run build\`, then start it again.`;
  return null;
}

/** The exit code when the server ended by itself (never on a stop the owner
 * asked for): never 0, so a LaunchAgent restarts it. */
export function serverExitCode(code: number | null): number {
  return code ? code : 1;
}
