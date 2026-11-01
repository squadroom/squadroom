// What the production build's server file trace must never carry: read by
// next.config.ts and checked after the build by scripts/check-build-trace.ts.

/** Globs (from the project root) excluded from every route's trace. */
export const TRACE_EXCLUDES = [
  ".git",
  ".git/**",
  ".github/**",
  ".gitignore",
  ".agent/**",
  "docs/**",
  "tests/**",
  "scripts/**",
];

/** A traced path (relative to the project root) that must not be there. */
export function forbiddenTracePath(path: string): boolean {
  if (path.startsWith("node_modules/") || path.includes("/node_modules/")) return false;
  return /^(\.git|\.github|\.agent|docs|tests|scripts)(\/|$)/.test(path) || path === ".gitignore";
}
