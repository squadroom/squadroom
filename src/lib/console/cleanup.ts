import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Launcher } from "./launcher.ts";
import type { ConsolePaths } from "./permissions.ts";
import type { ConsoleStore } from "./store.ts";

// Folder cleanup: the owner runs it.
// A scan lists what no open agent or project uses any more, with sizes and
// a warning for commits that were never pushed; a delete removes only what
// the owner chose and a fresh scan still lists. Everything in the agent's
// home is listed, measured and removed as `agent` through the launcher,
// never following a link; the shared folder is the worker's own.

export interface CleanupItem {
  /** Where it is: `work/<project>[/<agent>]`, `projects/<project>.git` or
   * `.tmp/<hash>` under the agent's home, or `shared/<name>`. */
  key: string;
  what: string;
  sizeKb: number | null;
  /** Commits that would be lost (never pushed, or only in this folder). */
  warning: string | null;
}
export interface CleanupDone {
  removed: string[];
  skipped: { key: string; reason: string }[];
}

const ID = /^[a-z][0-9a-f]{12}$/;
/** What the delete script accepts (as `agent`, in its home). */
const HOME_KEY = /^(work\/[a-z][0-9a-f]{12}(\/[a-z][0-9a-f]{12})?|projects\/[a-z][0-9a-f]{12}\.git|\.tmp\/[0-9a-f]{32})$/;
const STALE_SHARED_MS = 60 * 60_000;

/** Lists `work/*`, `work/*\/*`, `projects/*` and `.tmp/*` as `agent`: one
 * line each, D (a folder), L (a link), F (anything else); never follows a
 * link. */
const LIST_SCRIPT = `use Cwd qw(getcwd); my ($root) = @ARGV; exit 5 unless getcwd() eq $root;
sub kind { my ($p) = @_; return (-l $p) ? "L" : (-d _) ? "D" : "F" }
for my $top ("work", "projects", ".tmp") {
  next if -l $top || !-d _;
  opendir(my $h, $top) or next;
  for my $p (sort grep { !/^\\.\\.?$/ } readdir $h) {
    my $rel = "$top/$p"; next if $rel =~ /[\\t\\n]/;
    my $k = kind($rel); print "$k\\t$rel\\n";
    next unless $top eq "work" && $k eq "D";
    opendir(my $g, $rel) or next;
    for my $a (sort grep { !/^\\.\\.?$/ } readdir $g) { my $r = "$rel/$a"; next if $r =~ /[\\t\\n]/; print kind($r), "\\t$r\\n" }
  }
}`;

/** Removes each accepted path as `agent`: every folder on the way is
 * entered one step at a time (a link refuses it) and checked, so the final
 * `rm -rf` of a plain name runs in a pinned folder. */
const REMOVE_SCRIPT = `use Cwd qw(getcwd); my ($root, @rels) = @ARGV; exit 5 unless getcwd() eq $root;
for my $rel (@rels) {
  next unless $rel =~ m{^(work/[a-z][0-9a-f]{12}(/[a-z][0-9a-f]{12})?|projects/[a-z][0-9a-f]{12}\\.git|\\.tmp/[0-9a-f]{32})$};
  my ($parent, $name) = $rel =~ m{^(.*)/([^/]+)$};
  chdir($root) or next; my $ok = 1;
  for my $c (split m{/}, $parent) { if (-l $c || !-d _ || !chdir($c)) { $ok = 0; last } }
  my $here = getcwd();
  if (!$ok || !defined $here || $here ne "$root/$parent" || -l $name || !-d _) { print "skip\\t$rel\\n"; next }
  print((system("/bin/rm", "-rf", "--", $name) == 0 && !-e $name) ? "ok\\t$rel\\n" : "fail\\t$rel\\n");
}`;

/** The launcher's private temporary folder for a working folder
 * (`$AGENT_HOME/.tmp/<md5 of its path>`, scripts/console/console-agent). */
export const tmpKey = (path: string) => `.tmp/${createHash("md5").update(path).digest("hex")}`;

export interface CleanupOptions {
  store: ConsoleStore;
  launcher: Launcher;
  paths: ConsolePaths;
  /** Agents with a live runtime (a turn, a process): never touched. */
  busy: (agentId: string) => boolean;
  /** Commits the owner's mirror of a GitHub project already has. */
  mirrorHas: (projectId: string, sha: string) => Promise<boolean>;
  now: () => number;
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** What the owner may remove now. */
export async function scanCleanup(o: CleanupOptions): Promise<CleanupItem[]> {
  const home = real(o.paths.agentHome);
  const projects = new Map(o.store.projects().map((p) => [p.id, p]));
  const agents = new Map(o.store.agents().map((a) => [a.id, a]));
  const open = (a: { id: string; state: string }) => a.state !== "closed" && a.state !== "error";
  const inUse = (projectId: string) => [...agents.values()].some((a) => a.projectId === projectId && (open(a) || o.busy(a.id)));
  const listed = await o.launcher.runIn(home, "/usr/bin/perl", ["-e", LIST_SCRIPT, home], 4 * 1024 * 1024);
  if (listed.code !== 0) throw new Error(`The agent's home could not be listed (exit ${listed.code}).`);
  const entries = listed.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t") as ["D" | "L" | "F", string]);
  // Temporary folders still in use: the home itself, open agents' folders
  // and the projects' own repositories.
  const liveTmp = new Set([
    tmpKey(home),
    ...[...agents.values()].filter((a) => a.folder && (open(a) || o.busy(a.id))).map((a) => tmpKey(real(a.folder))),
    ...[...projects.keys()].map((id) => tmpKey(join(home, "projects", `${id}.git`))),
  ]);
  const items: Omit<CleanupItem, "sizeKb">[] = [];
  const projectGone = new Set<string>();
  for (const [kind, rel] of entries) {
    if (kind !== "D") continue; // Links and files are never touched.
    const parts = rel.split("/");
    if (parts[0] === "work" && parts.length === 2 && ID.test(parts[1]) && !projects.has(parts[1]) && !inUse(parts[1])) {
      projectGone.add(parts[1]);
      // The Console no longer knows these clones' history, so whatever they
      // hold may never have been pushed: listed unticked.
      const clones = entries.filter(([k, r]) => k === "D" && r.startsWith(`${rel}/`)).length;
      items.push({
        key: rel,
        what: "A project's folders (the project is no longer in the Console)",
        warning: clones
          ? `The Console no longer knows this project, so it cannot tell whether its ${clones} folder${clones === 1 ? "" : "s"} hold work that was never pushed.`
          : null,
      });
    } else if (parts[0] === "work" && parts.length === 3 && ID.test(parts[1]) && ID.test(parts[2]) && !projectGone.has(parts[1])) {
      const a = agents.get(parts[2]);
      if (a && (open(a) || o.busy(a.id) || a.projectId !== parts[1])) continue;
      items.push({
        key: rel,
        what: a ? `${a.name}'s folder (${a.state === "closed" ? "closed" : "could not be set up"}) in ${projects.get(parts[1])?.name ?? "a removed project"}` : "A folder no agent in the Console owns",
        warning: a
          ? await unpushed(o, a.id, a.projectId, join(home, rel))
          : "No agent in the Console owns this folder, so it cannot tell whether it holds work that was never pushed.",
      });
    } else if (parts[0] === "projects" && parts.length === 2 && /^[a-z][0-9a-f]{12}\.git$/.test(parts[1]) && !projects.has(parts[1].slice(0, -4)) && !inUse(parts[1].slice(0, -4)))
      items.push({ key: rel, what: "A removed project's own repository", warning: null });
    else if (parts[0] === ".tmp" && parts.length === 2 && /^[0-9a-f]{32}$/.test(parts[1]) && !liveTmp.has(rel))
      items.push({ key: rel, what: "Temporary files of a folder no longer in use", warning: null });
  }
  // Sizes, as `agent` (du never follows links).
  const sizes = new Map<string, number>();
  for (let i = 0; i < items.length; i += 100) {
    const batch = items.slice(i, i + 100).map((x) => x.key);
    const du = await o.launcher.runIn(home, "/usr/bin/du", ["-sk", "--", ...batch], 1024 * 1024);
    for (const line of du.stdout.split("\n")) {
      const m = /^(\d+)\t(.+)$/.exec(line);
      if (m) sizes.set(m[2], Number(m[1]));
    }
  }
  return [...items.map((x) => ({ ...x, sizeKb: sizes.get(x.key) ?? null })), ...scanShared(o, agents, projects)];
}

/** Work in a closed agent's folder that would be lost: changes never
 * committed (a commit that failed, a turn cut by a restart), and commits
 * never pushed (a GitHub project) or only in this folder. */
async function unpushed(o: CleanupOptions, agentId: string, projectId: string, folder: string): Promise<string | null> {
  const project = o.store.project(projectId);
  if (!project || project.source === "none") return null;
  const status = await o.launcher.git(folder, ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).console-tmp", ":(exclude).console-uploads"], 64 * 1024);
  const dirty = status.code !== 0 || !!status.stdout.trim() ? "It has changes that were never committed." : null;
  const commits = await lostCommits(o, agentId, project, folder);
  return [commits, dirty].filter(Boolean).join(" ") || null;
}
async function lostCommits(o: CleanupOptions, agentId: string, project: { id: string; source: string }, folder: string): Promise<string | null> {
  const projectId = project.id;
  const { branch, baseCommit } = o.store.agentBase(agentId);
  if (!baseCommit) return null;
  const head = await o.launcher.git(folder, ["rev-parse", "--verify", "--quiet", "HEAD"], 4096);
  const sha = head.code === 0 ? head.stdout.trim() : "";
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return null;
  const count = await o.launcher.git(folder, ["rev-list", "--count", `${baseCommit}..${sha}`], 4096);
  const n = count.code === 0 ? Number(count.stdout.trim()) : NaN;
  if (n === 0) return null;
  const commits = Number.isFinite(n) ? `${n} commit${n === 1 ? "" : "s"}` : "Commits";
  if (project.source === "github") {
    if (await o.mirrorHas(projectId, sha).catch(() => false)) return null;
    return `${commits} on ${branch ?? "its branch"} ${n === 1 ? "was" : "were"} never pushed to GitHub.`;
  }
  return `${commits} ${n === 1 ? "exists" : "exist"} only in this folder.`;
}

/** The shared folder's leftovers (the worker's own files): bundles and MCP
 * settings of projects and agents that are gone, and hand-off copies older
 * than an hour. */
function scanShared(o: CleanupOptions, agents: Map<string, { state: string }>, projects: Map<string, unknown>): CleanupItem[] {
  const items: CleanupItem[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(o.paths.shared);
  } catch {
    return items;
  }
  for (const name of names) {
    let stat;
    try {
      stat = lstatSync(join(o.paths.shared, name));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const id = /^([a-z][0-9a-f]{12})\.(bundle|json)$/.exec(name);
    let what: string | null = null;
    if (id?.[2] === "bundle" && !projects.has(id[1])) what = "A removed project's bundle";
    else if (id?.[2] === "json" && ["closed", "error", undefined].includes(agents.get(id[1])?.state) && !o.busy(id[1]))
      what = "A closed agent's tool settings";
    else if (/^(review-.+\.bundle|upload-\d+-[0-9a-f]+)$/.test(name) && o.now() - stat.mtimeMs > STALE_SHARED_MS) what = "A hand-off copy left by an interrupted step";
    if (what) items.push({ key: `shared/${name}`, what, sizeKb: Math.ceil(stat.size / 1024), warning: null });
  }
  return items;
}

/** Remove what the owner chose, if a fresh scan still lists it. */
export async function runCleanup(o: CleanupOptions, keys: string[]): Promise<CleanupDone> {
  const current = new Map((await scanCleanup(o)).map((i) => [i.key, i]));
  const done: CleanupDone = { removed: [], skipped: [] };
  const home: string[] = [];
  for (const key of new Set(keys)) {
    if (!current.has(key)) {
      done.skipped.push({ key, reason: "Not listed any more (it is in use, or already gone)." });
      continue;
    }
    if (key.startsWith("shared/")) {
      const name = key.slice(7);
      const path = join(o.paths.shared, name);
      try {
        if (!lstatSync(path).isFile()) throw new Error("not a plain file");
        rmSync(path);
        done.removed.push(key);
      } catch (error) {
        done.skipped.push({ key, reason: (error as Error).message });
      }
    } else if (HOME_KEY.test(key)) home.push(key);
    else done.skipped.push({ key, reason: "Not a path the cleanup removes." });
  }
  const root = real(o.paths.agentHome);
  for (let i = 0; i < home.length; i += 50) {
    const r = await o.launcher.runIn(root, "/usr/bin/perl", ["-e", REMOVE_SCRIPT, root, ...home.slice(i, i + 50)], 256 * 1024, 600_000);
    const seen = new Set<string>();
    for (const line of r.stdout.split("\n")) {
      const [state, key] = line.split("\t");
      if (!key) continue;
      seen.add(key);
      if (state === "ok") done.removed.push(key);
      else done.skipped.push({ key, reason: state === "skip" ? "A link, or not a plain folder: left alone." : "Removing it failed." });
    }
    for (const key of home.slice(i, i + 50)) if (!seen.has(key)) done.skipped.push({ key, reason: `Not removed (exit ${r.code}).` });
  }
  return done;
}
