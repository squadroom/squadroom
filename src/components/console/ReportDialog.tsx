import { useEffect, useState } from "react";
import { markdownFileName } from "@/lib/console/ui";
import { api } from "./api";
import Dialog from "./Dialog";
import styles from "./console.module.css";

// The run report: a tab's run as Markdown from the stored record, shown and
// downloadable as a .md file. No model is called.

export default function ReportDialog({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const [report, setReport] = useState<{ markdown: string; name: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ markdown: string; name: string }>(undefined, `?report=${encodeURIComponent(tabId)}`)
      .then((data) => live && setReport(data))
      .catch((e: Error) => live && setFailed(e.message));
    return () => {
      live = false;
    };
  }, [tabId]);
  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([report.markdown], { type: "text/markdown;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: markdownFileName(report.name) });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Dialog title="Run report" onClose={onClose}>
      {failed && <p className={styles.error}>{failed}</p>}
      {!report && !failed && <p className={styles.hint}>Loading…</p>}
      {report && (
        <>
          <div className={styles.dialogButtons}>
            <button className={styles.primary} onClick={download}>
              Download .md
            </button>
          </div>
          <pre className={styles.filePanelBody}>{report.markdown}</pre>
        </>
      )}
    </Dialog>
  );
}
