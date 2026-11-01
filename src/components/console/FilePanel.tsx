import { useEffect, useState } from "react";
import Markdown from "@/components/shared/Markdown";
import type { FileView } from "@/lib/console/agent-files";
import { fileKind, formatSize, resolveFromDocument } from "@/lib/console/files";
import { fence, fileLinks } from "@/lib/console/ui";
import { api, awaitJob } from "./api";
import Icon from "./Icon";
import styles from "./console.module.css";

/** The file panel: a file from an agent's folder, read by the worker as the
 * agent. Markdown renders (with its source a click away), other text is
 * highlighted, images show, anything else downloads. Full screen on the phone. */
export default function FilePanel(props: { agentId: string; path: string; helperId?: number; folder: string; onOpen: (path: string) => void; onClose: () => void }) {
  const { agentId, path, helperId, folder, onOpen, onClose } = props;
  // Links in a shown document: its own files open here (resolved against
  // the document's folder); web links open in a new tab.
  const onLink = fileLinks((href) => (folder ? resolveFromDocument(folder, path, href) : null), onOpen);
  const [view, setView] = useState<FileView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [source, setSource] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { readId } = await api(helperId !== undefined ? { action: "readHelper", agentId, helperId } : { action: "readFile", agentId, path });
        // Polled until the worker answers or the request expires (15 min);
        // a busy or stopped worker shows as waiting, not as failed.
        const read = await awaitJob(`?fileRead=${readId}`, {
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
  const name = path.split("/").pop() ?? path;
  return (
    <aside className={styles.filePanel} aria-label={`File ${path}`}>
      <header className={styles.filePanelHeader}>
        <strong className={styles.treeName} title={path}>
          {name}
        </strong>
        {view?.size !== undefined && <span className={styles.chip}>{formatSize(view.size)}</span>}
        {view?.kind === "markdown" && <button onClick={() => setSource(!source)}>{source ? "Rendered" : "Source"}</button>}
        <button className={styles.iconButton} onClick={onClose} aria-label="Close the file" title="Close">
          <Icon name="close" />
        </button>
      </header>
      <p className={styles.hint}>{path}</p>
      <div className={styles.filePanelBody}>
        {failed && <p className={styles.errorLine}>{failed}</p>}
        {!view && !failed && <p className={styles.hint}>{waiting ? "Waiting for the Console worker to read the file…" : "Opening…"}</p>}
        {view?.kind === "error" && <p className={styles.errorLine}>{view.message}</p>}
        {view?.kind === "markdown" && <Markdown onLink={onLink}>{source ? fence(view.text ?? "", "markdown") : (view.text ?? "")}</Markdown>}
        {view?.kind === "text" && <Markdown>{fence(view.text ?? "", view.language ?? fileKind(path).language)}</Markdown>}
        {view?.truncated && <p className={styles.hint}>Only the beginning of this file is shown.</p>}
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
