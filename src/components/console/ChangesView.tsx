import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import type { changesView } from "@/lib/console/views";
import { nextPolled, type Polled } from "@/lib/console/polled";
import { shownCommits, shownPatch } from "@/lib/console/ui";
import { api, usePolled, type Run } from "./api";
import ApproveGate from "./ApproveGate";
import Dialog from "./Dialog";
import { useBusy } from "./useBusy";
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

type Changes = NonNullable<ReturnType<typeof changesView>>;

/** An opened patch: a very long one is cut, so a phone is not handed it
 * whole, until the rest is asked for. */
function PatchText({ patch }: { patch: string | null }) {
  const [all, setAll] = useState(false);
  if (patch === null) return <pre>Loading…</pre>;
  const shown = shownPatch(patch, all);
  return (
    <>
      <pre>{shown.text}</pre>
      {shown.rest > 0 && (
        <button className={styles.linkButton} onClick={() => setAll(true)}>
          Show the rest ({Math.ceil(shown.rest / 1000)} KB)
        </button>
      )}
    </>
  );
}
type Commit = Changes["commits"][number];

/** One turn's commit: its patch is asked for once, when it is first opened,
 * so the 3-second poll carries the list only. */
function CommitDetails({ agentId, commit }: { agentId: string; commit: Commit }) {
  const [patch, setPatch] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const open = (e: SyntheticEvent<HTMLDetailsElement>) => {
    if (!e.currentTarget.open || asked) return;
    setAsked(true);
    void api<{ patch: string }>(undefined, `?changes=${encodeURIComponent(agentId)}&commit=${commit.id}`)
      .then((data) => setPatch(data.patch))
      .catch((error: Error) => {
        setFailed(error.message);
        setAsked(false);
      });
  };
  return (
    <details className={styles.tool} onToggle={open}>
      <summary>
        Turn {commit.turnId} · {commit.sha.slice(0, 8)} · {commit.stat.split("\n").at(-1)}
      </summary>
      <pre>{commit.stat}</pre>
      {failed ? <p className={styles.errorLine}>{failed}</p> : <PatchText patch={patch} />}
    </details>
  );
}

/** The branch against its base: its patch is asked for while it is open,
 * again whenever the branch changes, so the poll carries the stat only. */
function BranchDetails({ agentId, diff }: { agentId: string; diff: NonNullable<Changes["diff"]> }) {
  const [open, setOpen] = useState(false);
  const [patch, setPatch] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    api<{ patch: string }>(undefined, `?changes=${encodeURIComponent(agentId)}&branch=1`)
      .then((data) => {
        if (!live) return;
        setPatch(data.patch);
        setFailed(null);
      })
      .catch((e: Error) => live && setFailed(e.message));
    return () => {
      live = false;
    };
  }, [open, agentId, diff.updatedAt]);
  return (
    <details className={styles.tool} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{diff.stat.split("\n").at(-1)}</summary>
      <pre>{diff.stat}</pre>
      {failed ? <p className={styles.errorLine}>{failed}</p> : <PatchText patch={patch} />}
    </details>
  );
}

/** The changes view: each turn's commit and the branch against its base,
 * produced as the agent user with Git's hooks off. An editing agent in a
 * GitHub project also gets Push branch and Open pull request. */
export default function ChangesView({ agentId, onClose, run, onOpenFile }: { agentId: string; onClose: () => void; run: Run; onOpenFile: (path: string) => void }) {
  const [polled, setPolled] = useState<Polled<Changes> | null>(null);
  const changes = polled?.value ?? null;
  const [failed, setFailed] = useState<string | null>(null);
  const [allCommits, setAllCommits] = useState(false);
  // A later answer clears an earlier error; an unchanged one is not drawn
  // again.
  const load = useCallback(
    () =>
      api<Changes>(undefined, `?changes=${encodeURIComponent(agentId)}`)
        .then((data) => {
          setFailed(null);
          setPolled((last) => nextPolled(last, data));
        })
        .catch((e: Error) => setFailed(e.message)),
    [agentId],
  );
  usePolled(load, 3_000);
  const commits = shownCommits(changes?.commits ?? [], allCommits);
  const pushing = changes?.push?.state === "queued" || changes?.push?.state === "running";
  // Push and Open pull request: one at a time, so a double click queues one,
  // and busy until the list read after it shows the push.
  const { busy, guard } = useBusy();
  const push = (body: Parameters<Run>[0]) =>
    guard(async () => {
      if (await run(body)) await load();
    });
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
                disabled={pushing || busy}
                title="The agent writes the pull request's title and description, then the Console pushes the branch, opens the pull request (and asks Codex to review it, when Codex reviews are on)"
                onClick={() => push({ action: "openPullRequest", agentId })}
              >
                Open pull request
              </button>
              <button
                disabled={pushing || busy}
                title="Push now; the pull request is opened (or updated) from the agent's latest report, and Codex is asked to review when Codex reviews are on"
                onClick={() => push({ action: "push", agentId })}
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
          {changes.approval.editing && (
            <ApproveGate key={`${changes.approval.head}/${changes.approval.current?.reviewerId ?? ""}`} agentId={agentId} approval={changes.approval} run={run} />
          )}
          <h3 className={styles.subhead}>All changes{changes.baseBranch && changes.source === "github" ? ` against ${changes.baseBranch}` : ""}</h3>
          {changes.diff && <StatFiles files={changes.diff.files ?? []} onOpenFile={onOpenFile} />}
          {changes.diff?.stat ? (
            <BranchDetails agentId={agentId} diff={changes.diff} />
          ) : (
            <p className={styles.hint}>No changes yet.</p>
          )}
          <h3 className={styles.subhead}>Each turn</h3>
          {changes.commits.length === 0 && <p className={styles.hint}>No turn has changed files yet.</p>}
          {commits.shown.map((c) => (
            <div key={c.id}>
              <CommitDetails agentId={agentId} commit={c} />
              <StatFiles files={c.files ?? []} onOpenFile={onOpenFile} />
            </div>
          ))}
          {commits.hidden > 0 && (
            <button className={styles.linkButton} onClick={() => setAllCommits(true)}>
              Show all {changes.commits.length} commits
            </button>
          )}
        </>
      )}
    </Dialog>
  );
}
