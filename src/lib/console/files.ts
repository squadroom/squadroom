// Files in an agent's folder: the file panel and uploads. Browser-safe and
// pure: no Node imports.

/** Where uploads go inside an agent's folder. Never committed (the turn's
 * commit leaves it out) and never pushed (a push whose commits add a file
 * here is refused); read-only for a Code analysis agent (its sandbox denies
 * writes to its whole folder). */
export const UPLOADS_DIR = ".console-uploads";
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** What the panel shows at most. */
export const TEXT_MAX_BYTES = 512 * 1024;
export const BLOB_MAX_BYTES = 3 * 1024 * 1024;

type FileKind = "markdown" | "text" | "image" | "other";

const TEXT_EXT: Record<string, string> = {
  txt: "text", md: "markdown", markdown: "markdown", json: "json", jsonl: "json", csv: "csv", tsv: "text", ts: "typescript", tsx: "tsx",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript", py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", css: "css",
  scss: "scss", html: "html", xml: "xml", svg: "xml", yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", sql: "sql",
  sh: "bash", zsh: "bash", env: "text", log: "text", gitignore: "text", dockerfile: "dockerfile", graphql: "graphql",
};
const IMAGE_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** Uploads accepted: text and code, images, PDFs. */
const UPLOAD_EXT = new Set([...Object.keys(TEXT_EXT), ...Object.keys(IMAGE_EXT), "pdf"]);

const ext = (name: string) => {
  const base = name.split("/").pop() ?? name;
  if (/^dockerfile$/i.test(base)) return "dockerfile";
  const at = base.lastIndexOf(".");
  return at > 0 ? base.slice(at + 1).toLowerCase() : at === 0 ? base.slice(1).toLowerCase() : "";
};

export function fileKind(name: string): { kind: FileKind; language: string | null; mime: string | null } {
  const e = ext(name);
  if (e === "md" || e === "markdown") return { kind: "markdown", language: "markdown", mime: "text/markdown" };
  if (IMAGE_EXT[e]) return { kind: "image", language: null, mime: IMAGE_EXT[e] };
  if (TEXT_EXT[e]) return { kind: "text", language: TEXT_EXT[e], mime: "text/plain" };
  return { kind: "other", language: null, mime: null };
}

/**
 * A link or path an agent wrote, as a path relative to its folder; null
 * when it is not a file in that folder (a web link, a path elsewhere, `..`).
 * Accepts `file://`, absolute paths inside the folder, relative paths, and
 * drops a line suffix (`:12`, `:12:3`, `#L12`).
 */
export function resolveAgentPath(folder: string, href: string): string | null {
  if (!folder || typeof href !== "string") return null;
  let path = href.trim();
  if (!path) return null;
  // Every URI scheme but file: is a link elsewhere, never a file here.
  if (path.startsWith("file://")) path = path.slice(7);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (path.startsWith("#") || path.startsWith("//") || path.includes("\0")) return null;
  // A link's query and fragment are not part of the file name.
  return agentFilePath(folder, path.replace(/[?#].*$/, "").replace(/:\d+(:\d+)?$/, ""));
}

/**
 * An exact file path (from Git or a file tool, never a link), as a path
 * relative to the agent's folder; null outside it. No URL handling: `#`,
 * `?`, `%`, `:` and the like are part of the name.
 */
export function agentFilePath(folder: string, path: string): string | null {
  if (!folder || typeof path !== "string" || !path || path.includes("\0")) return null;
  const root = folder.replace(/\/+$/, "");
  let rel: string;
  if (path.startsWith("/")) {
    if (path !== root && !path.startsWith(`${root}/`)) return null;
    rel = path.slice(root.length + 1);
  } else rel = path.replace(/^\.\//, "");
  const parts: string[] = [];
  for (const part of rel.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

/** Paths a file tool row names (Claude's file tools; Codex's Edit lists
 * several, comma-separated). */
export function toolPaths(name: string, summary: string): string[] {
  if (!/^(Write|Edit|MultiEdit|Read|NotebookEdit|NotebookRead)$/.test(name)) return [];
  return summary
    .split(", ")
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith("…"));
}

/** An upload's name: a plain file name of an accepted type, or why not. */
export function checkUpload(name: string, size: number): { ok: true; name: string } | { ok: false; reason: string } {
  const base = (name.split(/[\\/]/).pop() ?? "").normalize("NFC").trim();
  if (!base || base.startsWith(".") || base.length > 100 || !/^[\p{L}\p{N} ._()-]+$/u.test(base))
    return { ok: false, reason: "Use a plain file name (letters, digits, spaces, . _ - ( ), not starting with a dot)." };
  if (!UPLOAD_EXT.has(ext(base))) return { ok: false, reason: "Only text, code, image and PDF files can be uploaded." };
  if (!Number.isSafeInteger(size) || size < 0) return { ok: false, reason: "The file size is not valid." };
  if (size > UPLOAD_MAX_BYTES) return { ok: false, reason: `Files up to ${UPLOAD_MAX_BYTES / 1024 / 1024} MB can be uploaded.` };
  return { ok: true, name: base };
}

/** What the next prompt tells the agent about new uploads. Bounded: at most
 * 20 files are listed; the rest are counted. */
export function uploadsNote(uploads: { name: string; size: number }[]): string {
  if (!uploads.length) return "";
  const shown = uploads.slice(0, 20);
  const lines = shown.map((u) => `- ${UPLOADS_DIR}/${u.name} (${formatSize(u.size)})`);
  const more = uploads.length - shown.length;
  return `The owner uploaded ${uploads.length === 1 ? "a file" : `${uploads.length} files`} to your folder:\n${lines.join("\n")}${
    more ? `\n- and ${more} more in ${UPLOADS_DIR}/` : ""
  }\n\n`;
}

/** A link inside a document from the agent's folder, resolved against that
 * document's own folder; null when it leaves the agent's folder. */
export function resolveFromDocument(folder: string, documentPath: string, href: string): string | null {
  const h = href.trim();
  if (!h || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//") || h.startsWith("#")) return h.startsWith("file:") ? resolveAgentPath(folder, h) : null;
  if (h.startsWith("/")) return resolveAgentPath(folder, h);
  const parts = documentPath.split("/").slice(0, -1);
  for (const part of h.replace(/[?#].*$/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? resolveAgentPath(folder, parts.join("/")) : null;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
