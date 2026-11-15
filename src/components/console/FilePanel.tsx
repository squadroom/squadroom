import { useEffect, useState } from "react";
import Markdown from "@/components/shared/Markdown";
import { EMBED_LEFT_OUT, previewDocument, previewHint, type Preview } from "@/lib/console/preview";
import type { FileView } from "@/lib/console/agent-files";
import { FOLDER_LISTING, fileKind, formatSize, previewKind, resolveFromDocument } from "@/lib/console/files";
import { fence, fileLinks } from "@/lib/console/ui";
import { readAgent } from "./api";
import Icon from "@/components/shared/Icon";
import { cleanDocument } from "./preview.client";
import RichMarkdown from "./RichMarkdown";
import { useFocusReturn } from "./useDialogFocus";
import styles from "./console.module.css";

/** The file panel: a file from an agent's folder, read by the worker as the
 * agent. Markdown renders, with maths and diagrams (its source a click away),
 * other text is highlighted, images show, anything else downloads. An SVG
 * shows as a picture and an HTML file, when asked, in a sealed frame: first
 * with its scripts off, and with them on only after Run scripts. Full screen
 * on the phone.
 * Opened on the folder itself (FOLDER_LISTING) it lists the folder's files,
 * documents first, to open here; a file then has a way back to that list. */
export default function FilePanel(props: { agentId: string; path: string; helperId?: number; folder: string; onOpen: (path: string) => void; onClose: () => void }) {
  const { agentId, path, helperId, folder, onOpen, onClose } = props;
  // Links in a shown document: its own files open here (resolved against
  // the document's folder); web links open in a new tab.
  const onLink = fileLinks((href) => (folder ? resolveFromDocument(folder, path, href) : null), onOpen);
  const [view, setView] = useState<FileView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  /** Source or the rendered view, once chosen. Until then an HTML file
   * opens as its source: showing an agent's page is the owner's choice. */
  const [chosen, setChosen] = useState<boolean | null>(null);
  /** Run scripts, for an HTML preview. Off for every file opened (the
   * panel is made anew for each) and whenever its source is shown. */
  const [scripts, setScripts] = useState(false);
  const [filter, setFilter] = useState("");
  const listing = helperId === undefined && path === FOLDER_LISTING;
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const read = await readAgent(
          helperId !== undefined ? { action: "readHelper", agentId, helperId } : path === FOLDER_LISTING ? { action: "listFiles", agentId } : { action: "readFile", agentId, path },
          { alive: () => alive, slow: () => setWaiting(true) },
        );
        if (read) return alive && setView(read);
        if (alive) setFailed("The Console worker did not read the file. Is it running?");
      } catch (e) {
        if (alive) setFailed((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [agentId, path, helperId]);
  const name = listing ? "Files" : (path.split("/").pop() ?? path);
  // A whole SVG or HTML file has a preview beside its source.
  const preview = view?.kind === "text" && !view.truncated && helperId === undefined ? previewKind(path) : null;
  const source = chosen ?? preview === "html";
  // An HTML file's page is put together when its preview is asked for:
  // the files of the agent's folder it refers to are read, each as any
  // file here is, and placed in the document (previewDocument), which the
  // browser's parser then checks (cleanDocument). A null document is a
  // page that check could not settle.
  const [page, setPage] = useState<(Omit<Preview, "document"> & { document: string | null }) | null>(null);
  const text = !source && preview === "html" ? (view?.text ?? "") : null;
  useEffect(() => {
    if (text === null) return;
    let alive = true;
    void previewDocument(text, path, (asset) => readAgent({ action: "readFile", agentId, path: asset }, { alive: () => alive }), scripts).then(
      (made) => {
        if (!alive) return;
        const { document, embedded } = cleanDocument(made.document, scripts);
        const noted = made.leftOut.some((l) => l.name === EMBED_LEFT_OUT.name);
        setPage({ document, leftOut: embedded && !noted ? [...made.leftOut, EMBED_LEFT_OUT] : made.leftOut });
      },
    );
    return () => {
      alive = false;
    };
  }, [text, path, agentId, scripts]);
  const shown = (view?.files ?? []).filter((f) => f.toLowerCase().includes(filter.trim().toLowerCase()));
  // Focus moves in, so a file opened from a dialog (Changes) is reachable
  // by keyboard, and goes back on close (to the first panel's opener after
  // following links); Escape closes it.
  const box = useFocusReturn<HTMLElement>(true);
  return (
    <aside
      ref={box}
      tabIndex={-1}
      className={styles.filePanel}
      aria-label={listing ? "Files" : `File ${path}`}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
    >
      <header className={styles.filePanelHeader}>
        <strong className={styles.treeName} title={path}>
          {name}
        </strong>
        {view?.size !== undefined && <span className={styles.chip}>{formatSize(view.size)}</span>}
        {!listing && helperId === undefined && folder && (
          <button onClick={() => onOpen(FOLDER_LISTING)} title="Every file in this agent's folder">
            Files
          </button>
        )}
        {view?.kind === "markdown" && <button onClick={() => setChosen(!source)}>{source ? "Rendered" : "Source"}</button>}
        {preview && (
          <button
            onClick={() => {
              setPage(null);
              setScripts(false);
              setChosen(!source);
            }}
            title={preview === "html" && source ? "Show this page here, in a sealed frame, with its scripts off: it cannot read the Console and loads nothing from the internet" : undefined}
          >
            {source ? "Preview" : "Source"}
          </button>
        )}
        {preview === "html" && !source && (
          <button
            aria-pressed={scripts}
            onClick={() => {
              setPage(null);
              setScripts(!scripts);
            }}
            title={
              scripts
                ? "The page's scripts are running. Click to turn them off again."
                : "Show the page again with its scripts running. It still cannot read the Console, but a script could pass small amounts of the page's own content to the outside."
            }
          >
            {scripts ? "Scripts on" : "Run scripts"}
          </button>
        )}
        <button className={styles.iconButton} onClick={onClose} aria-label="Close the file" title="Close">
          <Icon name="close" />
        </button>
      </header>
      <p className={styles.hint}>{listing ? "This agent's folder as it is now, committed or not. Documents come first." : path}</p>
      <div className={styles.filePanelBody}>
        {view?.kind === "folder" && (
          <>
            <input aria-label="Filter files" placeholder="Filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} />
            {shown.length === 0 && <p className={styles.hint}>{view.files?.length ? "No file matches." : "This folder has no files yet."}</p>}
            <ul className={styles.fileList}>
              {shown.map((f) => (
                <li key={f}>
                  <button className={styles.linkish} onClick={() => onOpen(f)}>
                    {f}
                  </button>
                </li>
              ))}
            </ul>
            {view.truncated && <p className={styles.hint}>Only the first files are listed. Filter by name, or open one from Changes.</p>}
          </>
        )}
        {failed && <p className={styles.errorLine}>{failed}</p>}
        {!view && !failed && <p className={styles.hint}>{waiting ? "Waiting for the Console worker to read the file…" : "Opening…"}</p>}
        {view?.kind === "error" && <p className={styles.errorLine}>{view.message}</p>}
        {view?.kind === "markdown" && <RichMarkdown onLink={onLink}>{source ? fence(view.text ?? "", "markdown") : (view.text ?? "")}</RichMarkdown>}
        {view?.kind === "text" && (source || !preview) && <Markdown>{fence(view.text ?? "", view.language ?? fileKind(path).language)}</Markdown>}
        {preview === "svg" && !source && (
          // As an image an SVG runs no script and loads nothing.
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.fileImage} alt={name} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(view?.text ?? "")}`} />
        )}
        {preview === "html" && !source && !page && <p className={styles.hint}>Putting the page together…</p>}
        {preview === "html" && !source && page && page.document === null && <p className={styles.errorLine}>This page could not be checked, so it is not shown here. Read it as Source.</p>}
        {preview === "html" && !source && page && page.document !== null && (
          // Sealed: an origin of its own (never allow-same-origin), under a
          // policy with no HTTP network; no forms, popups, downloads or
          // navigating the page. Scripts are off (an empty sandbox, and
          // STATIC_CSP) until Run scripts: with them on (allow-scripts,
          // SEALED_CSP) it is not a seal against a script signalling out
          // by DNS. A frame of its own for each mode.
          <iframe key={String(scripts)} className={styles.filePreview} title={`Preview of ${name}`} sandbox={scripts ? "allow-scripts" : ""} referrerPolicy="no-referrer" srcDoc={page.document} />
        )}
        {preview === "svg" && !source && <p className={styles.hint}>Shown as a picture: nothing in it runs, and other files it refers to are not loaded.</p>}
        {preview === "html" && !source && page && <p className={styles.hint}>{previewHint(scripts, page.leftOut)}</p>}
        {view?.truncated && view.kind !== "folder" && <p className={styles.hint}>Only the beginning of this file is shown.</p>}
        {view?.kind === "image" && view.base64 && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.fileImage} alt={name} src={`data:${view.mime};base64,${view.base64}`} />
        )}
        {view?.kind === "other" &&
          (view.base64 ? (
            <a className={styles.linkButton} download={name} href={`data:${view.mime ?? "application/octet-stream"};base64,${view.base64}`}>
              Download {name}
            </a>
          ) : (
            <p className={styles.hint}>This file cannot be shown here.</p>
          ))}
      </div>
    </aside>
  );
}
