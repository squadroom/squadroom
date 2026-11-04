import { chmodSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BLOB_MAX_BYTES, TEXT_MAX_BYTES, UPLOADS_DIR, agentFilePath, fileKind, formatSize } from "./files.ts";
import { DESIGN_DIR } from "./image-tools.ts";
import type { Launcher } from "./launcher.ts";
import { inside } from "./permissions.ts";
import type { Redactor } from "./redact.ts";

// Reading a file for the panel, and placing an upload. The worker does both
// as the `agent` user through the launcher, only inside the agent's own
// folder: links are refused, content is bounded, and text is redacted before
// it is stored for the page.

export interface FileView {
  path: string;
  kind: "markdown" | "text" | "image" | "other" | "error";
  size?: number;
  language?: string | null;
  mime?: string | null;
  /** Text (markdown, text), redacted. */
  text?: string;
  /** Bytes (images, downloads), base64. */
  base64?: string;
  truncated?: boolean;
  message?: string;
}

const refuse = (path: string, message: string): FileView => ({ path, kind: "error", message });

/** The folder's real path, as the worker sees it (the script checks it
 * again from inside, as the agent). */
function realFolder(folder: string): string {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
}

/**
 * Read a file as the agent, atomically, with every check made as the agent
 * (the owner cannot look inside the agent's private folders): the script
 * runs in the folder, whose real path must be `root`; the file is opened
 * with O_NOFOLLOW (a link at the last step is refused); the opened file's
 * real path (F_GETPATH on macOS; /proc/self/fd on Linux, where CI runs
 * the tests) must lie inside the folder (a link swapped in anywhere above
 * it is caught too); it must be a regular file. The first line printed is
 * that handle's size (fstat); then at most `max` bytes from the same
 * handle, or none when `whole` is set and the file is larger. Perl ships
 * with macOS.
 */
const READ_SCRIPT = `use Fcntl qw(O_RDONLY O_NOFOLLOW S_ISREG); use Cwd qw(getcwd);
my ($root, $path, $max, $whole) = @ARGV;
my $here = getcwd(); exit 5 unless defined $here && $here eq $root;
sysopen(my $f, $path, O_RDONLY | O_NOFOLLOW) or exit($!{ELOOP} ? 7 : ($!{ENOENT} || $!{ENOTDIR}) ? 3 : 4);
my $where;
if ($^O eq "darwin") { $where = "\\0" x 1024; fcntl($f, 50, $where) or exit 4; $where =~ s/\\0.*//s; }
else { $where = readlink("/proc/self/fd/" . fileno($f)); exit 4 unless defined $where; }
exit 5 unless index($where, "$root/") == 0;
my @s = stat($f); exit 6 unless S_ISREG($s[2]);
binmode STDOUT; print "$s[7]\\n"; exit 0 if $whole eq "1" && $s[7] > $max;
my $n = 0;
while ($n < $max) { my $r = sysread($f, my $c, ($max - $n > 65536 ? 65536 : $max - $n)); last unless $r; print $c; $n += $r; }
exit 0;`;
/** Longer than any credential, so one across the panel's cut is read whole. */
const READ_OVERLAP = 4096;
const READ_ERRORS: Record<number, string> = {
  3: "That file does not exist (any more).",
  4: "The file could not be read.",
  5: "That file is outside this agent's folder.",
  6: "That is not a file.",
  7: "Links are not opened here.",
};

/** `blobLimit`: the most of a non-text file read (the panel's display
 * limit by default; the image tools read inputs up to the upload limit). */
export async function readAgentFile(launcher: Launcher, folder: string, path: string, redactor: Redactor, blobLimit = BLOB_MAX_BYTES): Promise<FileView> {
  const rel = agentFilePath(folder, path);
  if (!rel || !inside(folder, join(folder, rel))) return refuse(path, "That is not a file in this agent's folder.");
  const { kind, language, mime } = fileKind(rel);
  const text = kind === "markdown" || kind === "text";
  const limit = text ? TEXT_MAX_BYTES : blobLimit;
  // Text is read past the cut, so a credential across it is masked whole.
  const read = text ? limit + READ_OVERLAP : limit;
  const r = await launcher.runIn(folder, "/usr/bin/perl", ["-e", READ_SCRIPT, realFolder(folder), `./${rel}`, String(read), text ? "0" : "1"], read + 32);
  if (r.code !== 0) return refuse(rel, READ_ERRORS[r.code] ?? "The file could not be read.");
  const newline = r.bytes.indexOf(10);
  const size = Number(r.bytes.subarray(0, Math.max(newline, 0)).toString("latin1"));
  if (newline < 1 || !Number.isSafeInteger(size)) return refuse(rel, "The file could not be read.");
  const bytes = r.bytes.subarray(newline + 1);
  if (!text && size > limit) return { path: rel, kind: "error", size, message: `This file is ${formatSize(size)}; ${blobLimit === BLOB_MAX_BYTES ? "the panel shows" : "this reads"} up to ${formatSize(limit)}.` };
  // Nothing the Console handed to an agent is ever stored for the page:
  // text is redacted; other content holding one is not shown at all.
  if (text && !bytes.includes(0)) {
    const shown = redactor.cut(bytes.toString("utf8"), limit);
    return { path: rel, kind, size, language, text: shown.text, truncated: shown.truncated || size > bytes.length };
  }
  if (redactor.holdsSecret(bytes.toString("latin1")))
    return refuse(rel, "This file holds a credential the Console handed to an agent, so it is not shown.");
  if (text) return refuse(rel, "This file holds binary content, so it is not shown.");
  return { path: rel, kind, size, mime: mime ?? "application/octet-stream", base64: bytes.toString("base64") };
}

interface UploadPlacement {
  state: "done" | "failed" | "exists";
  message: string;
  path: string;
}

/**
 * Place an upload as the agent, atomically, with every check made as the
 * agent: the script runs in the folder, whose real path must be `root`; the
 * uploads folder (made if missing, never a link) becomes the working
 * directory, and its real path must be `root/.console-uploads`. From there
 * on every step is relative to that pinned directory, so swapping the
 * folder for a link later changes nothing: the content goes to a new,
 * randomly named file (O_EXCL | O_NOFOLLOW), which takes its name by
 * link(2), failing if the name exists (no clobber), or, when the owner
 * confirmed a replacement, by rename(2), which replaces a link itself and
 * never writes through it.
 */
const PLACE_SCRIPT = `use Fcntl qw(O_WRONLY O_CREAT O_EXCL O_NOFOLLOW O_RDONLY); use Cwd qw(getcwd);
my ($from, $root, $dir, $tmp, $name, $replace, $mode) = @ARGV;
my $here = getcwd(); exit 5 unless defined $here && $here eq $root;
exit 5 if -l $dir; my $made = !-e $dir; mkdir($dir, oct($mode)) if $made;
chdir($dir) or exit 5; $here = getcwd(); exit 5 unless defined $here && $here eq "$root/$dir";
chmod(oct($mode), ".") if $made;
sysopen(my $in, $from, O_RDONLY) or exit 3;
sysopen(my $out, $tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0640) or exit 4;
binmode $in; binmode $out;
while (my $r = sysread($in, my $c, 65536)) { syswrite($out, $c) == $r or do { unlink $tmp; exit 4 } }
close $out or do { unlink $tmp; exit 4 };
if ($replace eq "1") { rename($tmp, $name) and exit 0; unlink $tmp; exit 6 }
if (link($tmp, $name)) { unlink $tmp; exit 0 }
my $e = $! + 0; unlink $tmp; exit($e == 17 ? 7 : 6);`;

export async function placeUpload(
  launcher: Launcher,
  shared: string,
  folder: string,
  upload: { id: number; name: string; staged: string; replace: boolean },
  /** The folder it goes in: the uploads, or `design/` for an image call. */
  dir = UPLOADS_DIR,
): Promise<UploadPlacement> {
  const rel = `${dir}/${upload.name}`;
  // The agent reads the staged copy from the shared folder (0640, its group).
  const handoff = join(shared, `upload-${upload.id}-${randomBytes(6).toString("hex")}`);
  try {
    // Written afresh, never copied: on APFS copyFileSync clones the staged
    // file and keeps its group (staff), which the agent is not in, so it
    // could not read the copy (the read failed with exit 3).
    // A new file in the shared folder takes the folder's group (agent).
    writeFileSync(handoff, readFileSync(upload.staged), { flag: "wx", mode: 0o640 });
    chmodSync(handoff, 0o640);
    const r = await launcher.runIn(folder, "/usr/bin/perl", [
      "-e",
      PLACE_SCRIPT,
      handoff,
      realFolder(folder),
      dir,
      `.upload-${randomBytes(8).toString("hex")}`,
      upload.name,
      upload.replace ? "1" : "0",
      // Uploads stay the agent's own; design/ is committed work the worker
      // (the owner, in the agent's group) checks paths in, like the clone.
      dir === UPLOADS_DIR ? "0700" : "0750",
    ]);
    if (r.code === 0) return { state: "done", message: `Uploaded to ${rel}.`, path: rel };
    if (r.code === 7) return { state: "exists", message: `${rel} already exists. Upload it again to replace it.`, path: rel };
    if (r.code === 5) return { state: "failed", message: `${dir} in this folder is not a plain folder, so nothing was written.`, path: rel };
    return { state: "failed", message: `The upload could not be written (${r.code === 6 ? `${rel} could not take its name` : `exit ${r.code}`}).`, path: rel };
  } finally {
    // Every outcome removes both copies of the owner's file.
    rmSync(handoff, { force: true });
    rmSync(upload.staged, { force: true });
  }
}

/** Remove what an upload interrupted by a restart left behind: the worker's
 * hand-off copies in the shared folder, owner-staged files no upload refers
 * to (older than an hour, so one being queued right now is safe), and (as
 * the agent) temporary files in each folder's uploads. */
export async function sweepUploadLeftovers(
  launcher: Launcher,
  shared: string,
  folders: string[],
  staging?: { dir: string; inUse: Set<string>; now: number },
) {
  const list = (dir: string) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  for (const name of list(shared)) if (/^upload-\d+-[0-9a-f]+$/.test(name)) rmSync(join(shared, name), { force: true });
  if (staging)
    for (const name of list(staging.dir)) {
      const at = /^(\d+)-[0-9a-f]{16}$/.exec(name);
      const path = join(staging.dir, name);
      if (at && Number(at[1]) < staging.now - 60 * 60_000 && !staging.inUse.has(path)) rmSync(path, { force: true });
    }
  for (const folder of folders)
    for (const dir of [UPLOADS_DIR, DESIGN_DIR]) await launcher.runIn(folder, "/usr/bin/perl", ["-e", SWEEP_SCRIPT, realFolder(folder), dir]);
}
/** Only `.upload-*` files directly inside the real (not linked) uploads
 * folder, relative to it once pinned as the working directory. */
const SWEEP_SCRIPT = `use Cwd qw(getcwd); my ($root, $d) = @ARGV;
my $here = getcwd(); exit 0 unless defined $here && $here eq $root;
exit 0 if -l $d || !-d _; chdir($d) or exit 0; $here = getcwd(); exit 0 unless defined $here && $here eq "$root/$d";
opendir(my $h, ".") or exit 0; for my $n (readdir $h) { next unless $n =~ /^\\.upload-[0-9a-f]+$/; unlink $n if -f $n && !-l $n }
exit 0;`;
