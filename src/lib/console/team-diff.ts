import { claimCovers, claimPattern } from "./claims.ts";
import { TeamError } from "./team.ts";

// Reading a teammate's work (team_diff): the kept patch cut into one
// section per file, and the answer built from it within a bound. Pure.

/** The most of a patch one team_diff answer carries: about 15k tokens, so a
 * reviewer reads a large change file by file instead of all at once. */
export const TEAM_DIFF_CHARS = 60_000;

/** A Git C-quoted path ("a/\346\227\245.txt"): escapes and octal bytes,
 * read as UTF-8. Returns the text and where the closing quote ended. */
function unquote(s: string, at: number): { text: string; end: number } {
  const bytes: number[] = [];
  const named: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  let i = at + 1;
  for (; i < s.length && s[i] !== '"'; i++) {
    if (s[i] !== "\\") {
      bytes.push(...Buffer.from(s[i], "utf8"));
      continue;
    }
    const next = s[++i];
    if (/[0-7]/.test(next ?? "") && /^[0-7]{3}$/.test(s.slice(i, i + 3))) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(named[next] ?? next.charCodeAt(0));
  }
  return { text: Buffer.from(bytes).toString("utf8"), end: i + 1 };
}
/** The file a `diff --git a/X b/Y` header names (Y; X for a deletion is the
 * same path). Paths with spaces are read by halving the identical pair;
 * paths Git quotes (non-ASCII, quotes, control characters) are unquoted. */
function headerPath(line: string): string {
  const quoted = line.slice("diff --git ".length);
  if (quoted.includes('"')) {
    // Either side may be quoted: "a/…" "b/…", or a/… "b/…".
    let rest = quoted;
    if (rest.startsWith('"')) rest = rest.slice(unquote(rest, 0).end).trimStart();
    else rest = rest.slice(rest.indexOf(' "b/') + 1);
    if (rest.startsWith('"b/')) return unquote(rest, 0).text.slice(2);
  }
  const rest = line.slice("diff --git a/".length);
  const half = (rest.length - " b/".length) / 2;
  if (Number.isInteger(half) && half > 0 && rest.slice(half, half + 3) === " b/" && rest.slice(0, half) === rest.slice(half + 3)) return rest.slice(0, half);
  return /^(.*?) b\/(.*)$/.exec(rest)?.[2] ?? rest;
}
/** A patch cut into one section per file, in order. */
export function patchSections(patch: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const part of patch.split(/(?=^diff --git "?a\/)/m)) {
    if (!/^diff --git "?a\//.test(part)) continue;
    out.push({ path: headerPath(part.slice(0, part.indexOf("\n") < 0 ? part.length : part.indexOf("\n"))), text: part.endsWith("\n") ? part : `${part}\n` });
  }
  return out;
}

/**
 * What team_diff answers: a teammate's branch against its starting commit,
 * from the diff the Console keeps after each of its turns.
 * Whole files only, within `max` characters; the rest are named so the
 * reader can ask for them by path.
 */
export function teamDiffText(
  who: { name: string; branch: string | null; running: boolean },
  diff: { base: string; head: string; stat: string; patch: string; files: string[] } | null,
  path?: unknown,
  max = TEAM_DIFF_CHARS,
): string {
  if (!diff) return `${who.name} has no committed changes yet.`;
  const short = (sha: string) => sha.slice(0, 8);
  const running = who.running ? ` ${who.name} has a turn running now; its changes from that turn are not here until it ends.` : "";
  const head = `${who.name}'s branch${who.branch ? ` ${who.branch}` : ""} at ${short(diff.head)}, against ${short(diff.base)} (the commit it started from).${running}`;
  const sections = patchSections(diff.patch);
  let wanted = sections;
  let scope = "";
  let pattern: string | null = null;
  if (path !== undefined && path !== null && path !== "") {
    const p = claimPattern(path);
    if (typeof p !== "string") throw new TeamError(p.error);
    pattern = p;
    wanted = sections.filter((s) => claimCovers(p, s.path));
    scope = ` under ${pattern}`;
    if (!wanted.length) {
      const listed = diff.files.filter((f) => claimCovers(p, f));
      return listed.length
        ? `${head}\n\nThe changes${scope} (${listed.join(", ")}) could not be read here; read them with git in your own folder if you are Code analysis, or ask ${who.name} which parts matter.`
        : `${head}\n\nNo changes${scope}. Changed files: ${diff.files.join(", ") || "none"}.`;
    }
  }
  const shown: string[] = [];
  let used = 0;
  for (const s of wanted) {
    if (used + s.text.length > max) {
      // One file larger than the whole allowance is shown cut, alone.
      if (!shown.length) {
        shown.push(`${s.text.slice(0, max)}\n[… cut at ${max} characters]\n`);
        used = max;
      }
      break;
    }
    shown.push(s.text);
    used += s.text.length;
  }
  const missing = wanted.slice(shown.length).map((s) => s.path);
  // Files changed but not in the kept patch (it is bounded) are named too.
  const kept = new Set(sections.map((s) => s.path));
  const unkept = diff.files.filter((f) => !kept.has(f) && (pattern === null || claimCovers(pattern, f)));
  return [
    head,
    "",
    ...(scope ? [] : [diff.stat.trim(), ""]),
    shown.join("").trimEnd(),
    ...(missing.length || unkept.length
      ? ["", `Not shown here: ${[...missing, ...unkept].join(", ")}. Call team_diff with from and path for each.`]
      : []),
  ].join("\n");
}

/** The path pattern team_diff must read from Git because the kept patch
 * (bounded) lacks some of the files it names, or null. */
export function teamDiffMissing(diff: { patch: string; files: string[] } | null, path: unknown): string | null {
  if (!diff || path === undefined || path === null || path === "") return null;
  const pattern = claimPattern(path);
  if (typeof pattern !== "string") return null;
  const kept = new Set(patchSections(diff.patch).map((s) => s.path));
  return diff.files.some((f) => claimCovers(pattern, f) && !kept.has(f)) ? pattern : null;
}
