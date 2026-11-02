import { useCallback, useState } from "react";
import type { changesView } from "@/lib/console/views";
import { nextPolled, type Polled } from "@/lib/console/polled";
import { approvalLine } from "@/lib/console/ui";
import { api, usePolled, type Run } from "./api";
import Dialog from "./Dialog";
import styles from "./console.module.css";

/** Changed files (exact names from Git), each opening the file panel. */
function StatFiles({ files, onOpenFile }: { files: string[]; onOpenFile: (path: string) => void }) {
  if (!files.length) return null;
  return (
    <div className={styles.uploads}>
      {files.map((f) => (
        <button key={f} className={styles.linkish} onClick={() => onOpenFile(f)}>
          {f}
        </button>
      ))}
    </div>
  );
}

type Approval = NonNullable<ReturnType<typeof changesView>>["approval"];

/** The approve gate: approve the branch's current commit, optionally only
 * after a Look only teammate reviewed it; a later commit cancels the approval. */
function ApproveGate({ agentId, approval, run }: { agentId: string; approval: Approval; run: Run }) {
  const [reviewerId, setReviewerId] = useState("");
  const reviewer = approval.reviewers.find((r) => r.id === reviewerId);
  const approvedNow = approval.current?.current && approval.current.sha === approval.head;
  return (
    <div className={styles.pushRow}>
      <span className={styles.hint}>{approvalLine(approval)}</span>
      {approval.head && !approvedNow && (
        <>
          {approval.reviewers.length > 0 && (
            <select aria-label="Reviewed by" value={reviewerId} onChange={(e) => setReviewerId(e.target.value)}>
              <option value="">No review needed</option>
              {approval.reviewers.map((r) => (
                <option key={r.id} value={r.id}>
                  After {r.name}&apos;s review{r.reviewed ? " (done)" : " (not yet)"}
                </option>
              ))}
            </select>
          )}
          <button disabled={!!reviewer && !reviewer.reviewed} onClick={() => void run({ action: "approve", agentId, sha: approval.head!, reviewerId: reviewerId || null })}>
            Approve {approval.head.slice(0, 7)}
          </button>
        </>
      )}
      {approval.current && (
        <button className={styles.linkButton} onClick={() => void run({ action: "revokeApproval", agentId })}>
          Withdraw approval
        </button>
      )}
    </div>
  );
}

/** The changes view: each turn's commit and the branch against its base,
 * produced as the agent user with Git's hooks off. An editing agent in a
 * GitHub project also gets Push branch and Open pull request. */
export default function ChangesView({ agentId, onClose, run, onOpenFile }: { agentId: string; onClose: () => void; run: Run; onOpenFile: (path: string) => void }) {
  const [polled, setPolled] = useState<Polled<NonNullable<ReturnType<typeof changesView>>> | null>(null);
  const changes = polled?.value ?? null;
  const [failed, setFailed] = useState<string | null>(null);
  // A later answer clears an earlier error; an unchanged one is not drawn
  // again.
  const load = useCallback(
    () =>
      void api(undefined, `?changes=${encodeURIComponent(agentId)}`)
        .then((data) => {
          setFailed(null);
          setPolled((last) => nextPolled(last, data));
        })
        .catch((e: Error) => setFailed(e.message)),
    [agentId],
  );
  usePolled(load, 3_000);
  const pushing = changes?.push?.state === "queued" || changes?.push?.state === "running";
  return (
    <Dialog title="Changes" onClose={onClose}>
      {failed && <p className={styles.errorLine}>{failed}</p>}
      {!changes ? (
        <p className={styles.hint}>Loading…</p>
      ) : (
        <>
          <p className={styles.hint}>
            {changes.branch ? `Branch ${changes.branch}` : "Folder"} · {changes.folder}
          </p>
          {changes.source === "github" && changes.branch && (
            <div className={styles.pushRow}>
              <button
                className={styles.primary}
                disabled={pushing}
                title="The agent writes the pull request's title and description, then the Console pushes the branch, opens the pull request (and asks Codex to review it, when Codex reviews are on)"
                onClick={() => void run({ action: "openPullRequest", agentId })}
              >
                Open pull request
              </button>
              <button
                disabled={pushing}
                title="Push now; the pull request is opened (or updated) from the agent's latest report, and Codex is asked to review when Codex reviews are on"
                onClick={() => void run({ action: "push", agentId })}
              >
                {pushing ? "Pushing…" : "Push branch"}
              </button>
              {changes.push?.state === "done" && changes.push.url && (
                <a className={styles.linkButton} href={changes.push.url} target="_blank" rel="noreferrer">
                  {/\/pull\/\d+/.test(changes.push.url) ? "View pull request" : "Open on GitHub"}
                </a>
              )}
              {changes.push?.state === "failed" && <span className={styles.errorLine}>{changes.push.message}</span>}
              {changes.push?.state === "done" && <span className={styles.hint}>{changes.push.message}</span>}
            </div>
          )}
          {changes.approval.editing && <ApproveGate agentId={agentId} approval={changes.approval} run={run} />}
          <h3 className={styles.subhead}>All changes{changes.baseBranch && changes.source === "github" ? ` against ${changes.baseBranch}` : ""}</h3>
          {changes.diff && <StatFiles files={changes.diff.files ?? []} onOpenFile={onOpenFile} />}
          {changes.diff?.stat ? (
            <details className={styles.tool}>
              <summary>{changes.diff.stat.split("\n").at(-1)}</summary>
              <pre>{changes.diff.stat}</pre>
              <pre>{changes.diff.patch}</pre>
            </details>
          ) : (
            <p className={styles.hint}>No changes yet.</p>
          )}
          <h3 className={styles.subhead}>Each turn</h3>
          {changes.commits.length === 0 && <p className={styles.hint}>No turn has changed files yet.</p>}
          {changes.commits.map((c) => (
            <div key={c.id}>
              <details className={styles.tool}>
                <summary>
                  Turn {c.turnId} · {c.sha.slice(0, 8)} · {c.stat.split("\n").at(-1)}
                </summary>
                <pre>{c.stat}</pre>
                <pre>{c.patch}</pre>
              </details>
              <StatFiles files={c.files ?? []} onOpenFile={onOpenFile} />
            </div>
          ))}
        </>
      )}
    </Dialog>
  );
}
