import { useEffect, useState } from "react";
import Markdown from "@/components/shared/Markdown";
import type { FileView } from "@/lib/console/agent-files";
import { FOLDER_LISTING, fileKind, formatSize, resolveFromDocument } from "@/lib/console/files";
import { fence, fileLinks } from "@/lib/console/ui";
import { api, awaitJob } from "./api";
import Icon from "@/components/shared/Icon";
import { useFocusReturn } from "./useDialogFocus";
import styles from "./console.module.css";

/** The file panel: a file from an agent's folder, read by the worker as the
 * agent. Markdown renders (with its source a click away), other text is
 * highlighted, images show, anything else downloads. Full screen on the phone.
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
  const [source, setSource] = useState(false);
  const [filter, setFilter] = useState("");
  const listing = helperId === undefined && path === FOLDER_LISTING;
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { readId } = await api<{ readId: number }>(
          helperId !== undefined ? { action: "readHelper", agentId, helperId } : path === FOLDER_LISTING ? { action: "listFiles", agentId } : { action: "readFile", agentId, path },
        );
        // Polled until the worker answers or the request expires (15 min);
        // a busy or stopped worker shows as waiting, not as failed.
        const read = await awaitJob<{ state: string; result: unknown }>(`?fileRead=${readId}`, {
          delay: (i) => (i === 0 ? 150 : i < 60 ? 400 : 2000),
          limitMs: 15 * 60_000,
          alive: () => alive,
          slow: { at: 60, then: () => setWaiting(true) },
          settled: (read) => read.state === "done",
        });
        if (read) return alive && setView(read.result as FileView);
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
        {view?.kind === "markdown" && <button onClick={() => setSource(!source)}>{source ? "Rendered" : "Source"}</button>}
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
        {view?.kind === "markdown" && <Markdown onLink={onLink}>{source ? fence(view.text ?? "", "markdown") : (view.text ?? "")}</Markdown>}
        {view?.kind === "text" && <Markdown>{fence(view.text ?? "", view.language ?? fileKind(path).language)}</Markdown>}
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
