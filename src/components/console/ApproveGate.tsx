import { useState } from "react";
import type { Approval } from "@/lib/console/views";
import { approvalLine } from "@/lib/console/ui";
import type { Run } from "./api";
import styles from "./console.module.css";

/** The approve gate: approve the branch's current commit, optionally only
 * after a Code analysis teammate reviewed it; a later commit cancels the
 * approval. One component for Changes and, where a step waits for it, the
 * agent's own window. */
export default function ApproveGate({ agentId, approval, run }: { agentId: string; approval: Approval; run: Run }) {
  // Where a step waits for a review (a tab with steps and a reviewer),
  // only an approval after one is offered, the finished review first.
  const [reviewerId, setReviewerId] = useState(() => (approval.reviewNeeded ? ((approval.reviewers.find((r) => r.reviewed) ?? approval.reviewers[0])?.id ?? "") : ""));
  const reviewer = approval.reviewers.find((r) => r.id === reviewerId);
  const approvedNow = approval.current?.current && approval.current.sha === approval.head;
  // Approved without a review there: it can be approved again, after one.
  const unreviewed = !!approvedNow && approval.reviewNeeded && !approval.current?.reviewerId;
  return (
    <div className={styles.pushRow}>
      <span className={styles.hint}>
        {approvalLine(approval)}
        {unreviewed && " This tab's steps move on only after an approval that follows a review: approve it again."}
      </span>
      {approval.head && (!approvedNow || unreviewed) && (
        <>
          {approval.reviewers.length > 0 && (
            <select aria-label="Reviewed by" value={reviewerId} onChange={(e) => setReviewerId(e.target.value)}>
              {!approval.reviewNeeded && <option value="">No review needed</option>}
              {approval.reviewers.map((r) => (
                <option key={r.id} value={r.id}>
                  After {r.name}&apos;s review{r.reviewed ? " (done)" : " (not yet)"}
                </option>
              ))}
            </select>
          )}
          <button disabled={(!!reviewer && !reviewer.reviewed) || (approval.reviewNeeded && !reviewer)} onClick={() => void run({ action: "approve", agentId, sha: approval.head!, reviewerId: reviewerId || null })}>
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
