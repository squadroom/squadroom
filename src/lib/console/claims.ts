// Claims and holds: the claim patterns agents give team_claim (and
// team_diff's path), which paths a claim covers, whether two claims
// overlap, and the cycle a new hold would close. Pure.

const WILD = /[*?]/;
/** A claim pattern, normalized, or why it is not one: a path relative to
 * the agent's folder (`src/auth/**`, `README.md`, `docs/`), no `..`. */
export function claimPattern(raw: unknown): string | { error: string } {
  if (typeof raw !== "string") return { error: "A path must be text." };
  // "." components mean nothing in a path ("src/." is src; "." is all).
  const raw2 = raw.trim().replace(/\/+$/, "");
  const p = raw2 === "." ? "**" : raw2.split("/").filter((s, i, all) => s !== "." || all.length === 1).join("/");
  if (!p || p.length > 200 || p.startsWith("/") || p.includes("\0") || p.split("/").some((s) => s === ".." || s === "" || s === "."))
    return { error: `"${String(raw).slice(0, 60)}" is not a path inside your folder.` };
  // Only * and ? (and **) are wildcards here; brackets are not supported.
  if (/[[\]]/.test(p)) return { error: `"${String(raw).slice(0, 60)}": use * and ** instead of [ ] in a claim.` };
  return p;
}
/** A claim pattern's tokens: one per character it spells, `?`, `*`, and
 * the three places a `**` segment can stand: `A` before a "/" (any
 * folders or none), `B` after one (the same, below), `S` alone
 * (anything). A last `B` lets a pattern cover what is below it. */
function claimTokens(pattern: string): string[] {
  const parts: string[] = [];
  pattern.split("/").forEach((seg, k) => {
    if (k) parts.push("=/");
    if (seg === "**") parts.push("**");
    else for (let i = 0; i < seg.length; i++) parts.push(seg[i] === "*" || seg[i] === "?" ? seg[i] : `=${seg[i]}`);
  });
  const pair = (list: string[], first: string, second: string, into: string) => {
    const out: string[] = [];
    for (let i = 0; i < list.length; i++)
      if (list[i] === first && list[i + 1] === second) {
        out.push(into);
        i++;
      } else out.push(list[i]);
    return out;
  };
  return [...pair(pair(parts, "**", "=/", "A"), "=/", "**", "B").map((t) => (t === "**" ? "S" : t)), "B"];
}
const LINE_END = /[\n\r\u2028\u2029]/;
/** Whether `path` matches `pattern` (both lower case), stepping through
 * the path once with every place in the pattern it could be at, so the
 * time grows with the pattern times the path. (A regular expression, one
 * nested optional group per `**` and a `[^/]*` per `*`, backtracked for
 * seconds on a deep path or a long name, and the worker waited.) */
function claimMatches(pattern: string, path: string): boolean {
  const tokens = claimTokens(pattern);
  // A place: token index times 2, plus 1 inside an `A` or `B` token's
  // "anything" part.
  const size = (tokens.length + 1) * 2;
  const enter = (seen: Uint8Array, list: number[], start: number) => {
    const stack = [start];
    while (stack.length) {
      const at = stack.pop()!;
      if (seen[at]) continue;
      seen[at] = 1;
      list.push(at);
      const t = tokens[at >> 1];
      const inside = at & 1;
      if (!inside && (t === "*" || t === "A" || t === "B" || t === "S")) stack.push(at + 2);
      if (!inside && t === "A") stack.push(at + 1);
      if (inside && t === "B") stack.push(at + 1);
    }
  };
  let list: number[] = [];
  enter(new Uint8Array(size), list, 0);
  for (let i = 0; i < path.length && list.length; i++) {
    const c = path[i];
    const any = !LINE_END.test(c);
    const seen = new Uint8Array(size);
    const next: number[] = [];
    for (const at of list) {
      const t = tokens[at >> 1];
      const after = (at | 1) + 1;
      if (t === undefined) continue;
      if (at & 1) {
        if (any) enter(seen, next, at);
        if (t === "A" && c === "/") enter(seen, next, after);
      } else if (t[0] === "=") {
        if (t[1] === c) enter(seen, next, after);
      } else if (t === "?") {
        if (c !== "/") enter(seen, next, after);
      } else if (t === "*") {
        if (c !== "/") enter(seen, next, at);
      } else if (t === "B") {
        if (c === "/") enter(seen, next, at + 1);
      } else if (t === "S" && any) enter(seen, next, at);
    }
    list = next;
  }
  return list.includes(tokens.length * 2);
}
/** Whether a claim covers a path (relative to the folder). A pattern
 * without wildcards covers the path and anything below it. */
export function claimCovers(pattern: string, path: string): boolean {
  // The Mac's file system ignores case: src/A.ts and SRC/a.ts are one file.
  return claimMatches(pattern.toLowerCase(), path.replace(/^\.\//, "").toLowerCase());
}
/** Whether two claims may overlap. Conservative: patterns whose fixed
 * leading folders nest count as overlapping. */
export function claimsOverlap(a: string, b: string): boolean {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (claimCovers(a, b) || claimCovers(b, a)) return true;
  const fixed = (p: string) => {
    const segs = p.split("/");
    const at = segs.findIndex((s) => WILD.test(s));
    return at < 0 ? null : segs.slice(0, at);
  };
  const fa = fixed(a);
  const fb = fixed(b);
  if (!fa && !fb) return false;
  const sa = fa ?? a.split("/");
  const sb = fb ?? b.split("/");
  const n = Math.min(sa.length, sb.length);
  return sa.slice(0, n).every((s, i) => s === sb[i]) && (fa ? true : sa.length >= sb.length) && (fb ? true : sb.length >= sa.length);
}

/** A hold cycle a new hold would close (names in order), or null. */
export function holdCycle(holds: { holder: string; held: string }[], holder: string, held: string): string[] | null {
  const next = new Map<string, string[]>();
  for (const h of [...holds, { holder, held }]) next.set(h.holder, [...(next.get(h.holder) ?? []), h.held]);
  // A path from the new hold's held agent back to its holder is a cycle.
  const seen = new Set<string>();
  const walk = (at: string, path: string[]): string[] | null => {
    if (at === holder) return path;
    if (seen.has(at)) return null;
    seen.add(at);
    for (const n of next.get(at) ?? []) {
      const found = walk(n, [...path, n]);
      if (found) return found;
    }
    return null;
  };
  return walk(held, [holder, held]);
}
