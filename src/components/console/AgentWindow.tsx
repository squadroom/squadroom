import type { ConsoleCommand } from "@/lib/console/commands";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { agentModel } from "@/lib/console/agents";
import type { AgentView } from "@/lib/console/views";
import { FOLDER_LISTING, resolveAgentPath } from "@/lib/console/files";
import { gaugeLine } from "@/lib/console/gauge";
import { taskLine } from "@/lib/console/tasks";
import { transcript } from "@/lib/console/transcript";
import { STATUS_TEXT } from "@/lib/console/tree";
import { PERMISSION_LABELS, type AgentStatus, type ConsoleEvent } from "@/lib/console/types";
import { elapsed, fileLinks, pastedName, plural } from "@/lib/console/ui";
import { atEnd } from "@/lib/console/view-state";
import type { Run } from "./api";
import BlockView from "./BlockView";
import Icon from "@/components/shared/Icon";
import InlineRename from "./InlineRename";
import KindBadge from "./KindBadge";
import { MenuButton, type MenuItem } from "./Menu";
import { useComposer } from "./useComposer";
import styles from "./console.module.css";

/** What a window's status pill says: the tree's words, and Closed. */
const STATUS_LABELS: Record<AgentStatus, string> = { ...STATUS_TEXT, closed: "Closed" };

/** One agent's window: its header and menu, helpers and task list,
 * the live transcript, queued messages and the composer. */
export default function AgentWindow({
  agent,
  otherCodexRunning,
  events,
  maximized,
  onMaximize,
  onChanges,
  onModel,
  onOpenFile,
  onOpenHelper,
  run,
}: {
  agent: AgentView;
  otherCodexRunning: number;
  events: ConsoleEvent[];
  maximized: boolean;
  onMaximize: () => void;
  onChanges: () => void;
  /** Change its model and thinking level. */
  onModel: () => void;
  onOpenFile: (agentId: string, path: string) => void;
  onOpenHelper: (helperId: number, name: string) => void;
  run: Run;
}) {
  // The composer lives with the page, not the window.
  const { draft, editing, sending, setDraft, setSending, edit, clearDraft, sent, uploads, uploadIds, uploading, uploadAll, clearUploads } = useComposer(agent);
  /** A command sent once the owner confirms it. */
  const confirmed = (question: string, body: ConsoleCommand) => () => {
    if (window.confirm(question)) void run(body);
  };
  const freshWithSummary = confirmed(
    `Fresh session with summary for ${agent.name}? This costs one turn: it writes a summary of its work, then its next message starts a new conversation that opens with that summary. Its folder and branch stay as they are.`,
    { action: "freshWithSummary", agentId: agent.id },
  );
  const scroller = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => transcript(events), [events]);
  const model = agentModel(agent.kind, agent.model);
  const busy = agent.status === "working" || agent.status === "queued" || agent.status === "needs_you";
  const [renaming, setRenaming] = useState(false);
  // The window's menu, shown by the same Menu component as a tab's menu and Add.
  const turning = agent.status === "working" || agent.status === "needs_you";
  const menu: MenuItem[] = [
    { label: "Changes", hint: "Its commits and changed files", onSelect: onChanges },
    { label: "Files", hint: "Read its documents and other files", disabled: !agent.folder, onSelect: () => onOpenFile(agent.id, FOLDER_LISTING) },
    { label: "Model…", hint: `${model?.label ?? agent.model}${agent.effort ? `, thinking ${agent.effort}` : ""}`, onSelect: onModel },
    { label: "Rename", hint: "Or double-click its name", onSelect: () => setRenaming(true) },
    { label: "Stop", hint: "Ends its turn", disabled: !busy, onSelect: () => void run({ action: "stop", agentId: agent.id }) },
    {
      label: "Force stop",
      hint: otherCodexRunning > 0 ? `Also stops ${plural(otherCodexRunning, "other Codex window")}` : "Ends the turn at once",
      danger: true,
      disabled: !busy,
      onSelect: confirmed(
        `Force stop ${agent.name}?${
          otherCodexRunning > 0
            ? ` Codex windows share one server, so this also stops ${plural(otherCodexRunning, "other running Codex window")}; their messages go to Needs you for a Re-send.`
            : ""
        }`,
        { action: "stop", agentId: agent.id, force: true },
      ),
    },
    ...(agent.kind === "claude-code" || agent.askFirst
      ? [
          {
            label: agent.askFirst ? "Turn Ask me first off" : "Turn Ask me first on",
            hint: "Its file changes and commands wait for you in Needs you, as web access always does. Team tools (such as pulling teammates' work) and image tools don't wait.",
            onSelect: () => void run({ action: "setAskFirst", agentId: agent.id, on: !agent.askFirst }),
          },
        ]
      : []),
    {
      label: "Forget its Always rules",
      hint: "Requests you allowed with Always are asked again",
      onSelect: confirmed(`Forget every "Always for this agent" rule of ${agent.name}? It will ask again.`, { action: "forgetRules", agentId: agent.id }),
    },
    {
      label: "Start fresh",
      hint: "A new conversation; folder and branch stay",
      // A queued message may start fresh; a running turn may not.
      disabled: turning,
      onSelect: confirmed(`Start ${agent.name} fresh? Its next message begins a new conversation; its folder and branch stay as they are.`, {
        action: "fresh",
        agentId: agent.id,
      }),
    },
    { label: "Fresh session with summary", hint: "Costs one turn: it summarises, then starts anew", disabled: turning || agent.summaryWaiting, onSelect: freshWithSummary },
    { label: "Close", hint: "Its folder stays on the Mac", danger: true, onSelect: confirmed(`Close ${agent.name}? Its folder stays on the Mac.`, { action: "close", agentId: agent.id }) },
  ];
  // A window opens at its latest message and follows new output while the
  // reader stays at the end; scrolling up stops that until ↓ (or
  // scrolling back down). The end is held through anything that changes the
  // height: new blocks, late layout, a resized or maximized window.
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const toEnd = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    following.current = atEnd(el.scrollHeight, el.scrollTop, el.clientHeight);
    setShowLatest(!following.current);
  };
  useLayoutEffect(() => {
    if (following.current) toEnd();
  }, [blocks, toEnd]);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current) toEnd();
    });
    if (scroller.current) observer.observe(scroller.current);
    if (body.current) observer.observe(body.current);
    return () => observer.disconnect();
  }, [toEnd]);
  // A link an agent wrote to one of its files opens in the file panel; it
  // never navigates the page, which would land on a "not found". Both
  // handlers stay stable while the agent and its folder do, so the memoized
  // text blocks skip re-rendering their Markdown on every poll.
  const openFile = useCallback((path: string) => onOpenFile(agent.id, path), [onOpenFile, agent.id]);
  const onLink = useMemo(() => fileLinks((href) => resolveAgentPath(agent.folder, href), openFile), [agent.folder, openFile]);
  // Queued-message controls: the one whose Delete waits for a
  // second click (the one being edited is the composer's).
  const [deleting, setDeleting] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // The message box starts at two rows and grows with its text (its CSS
  // caps the height; past that it scrolls).
  const box = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, []);
  useLayoutEffect(fit, [draft, fit]);
  // Measured again when its width changes (maximize, a resized window, the
  // Stop button appearing).
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const watch = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [fit]);
  const send = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    // An edit replaces the queued message in place; refused (it already
    // went to the agent), the text stays here. Files attached while editing
    // go with the edited message. What was typed while it was on its way
    // stays in the box.
    const text = draft;
    const ids = uploadIds;
    const wasEditing = editing !== null;
    const done = (await run(
      editing !== null ? { action: "editQueued", turnId: editing, text, uploadIds: ids } : { action: "send", agentId: agent.id, text, uploadIds: ids },
    )) as { refusedUploads?: string[] } | null;
    setSending(false);
    if (!done) return;
    sent(text, ids);
    if (done.refusedUploads?.length)
      window.alert(`Already announced with an earlier message, so not ${wasEditing ? "added" : "sent again"}: ${done.refusedUploads.join(", ")}.`);
  };
  return (
    <section
      className={dragging ? `${styles.window} ${styles.dropping}` : styles.window}
      aria-label={agent.name}
      data-agent-window={agent.id}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        uploadAll(e.dataTransfer.files);
      }}
    >
      <header className={styles.windowHeader}>
        <KindBadge kind={agent.kind} />
        {renaming ? (
          <InlineRename
            name={agent.name}
            label={`New name for ${agent.name}`}
            onDone={(name) => {
              setRenaming(false);
              if (name) void run({ action: "rename", target: "agent", id: agent.id, name });
            }}
          />
        ) : (
          <strong className={styles.windowName} onDoubleClick={() => setRenaming(true)} title="Double-click to rename">
            {agent.name}
          </strong>
        )}
        <span className={styles.chip}>
          {model?.label ?? agent.model}
          {agent.effort ? ` · ${agent.effort}` : ""}
        </span>
        <span className={styles.windowStatus}>
          <span className={`${styles.dot} ${styles[`dot_${agent.status}`] ?? ""}`} aria-hidden="true" />
          {STATUS_LABELS[agent.status]}
        </span>
        {(() => {
          const g = gaugeLine(agent.gauge);
          // The gauge offers Fresh session with summary.
          return g ? (
            <button
              className={g.high ? `${styles.chip} ${styles.gaugeHigh}` : styles.chip}
              title={`${g.title}\nClick: Fresh session with summary (costs one turn)`}
              onClick={freshWithSummary}
            >
              {g.text}
            </button>
          ) : null;
        })()}
        <span className={styles.badge} title={agent.askFirst ? "Ask me first: its file changes and commands wait for you in Needs you, as web access always does. Team tools (such as pulling teammates' work) and image tools don't wait." : undefined}>
          {PERMISSION_LABELS[agent.permission]}
          {agent.askFirst ? " · ask first" : ""}
        </span>
        {/* One line however many claims: a chip per claim pushed the
            transcript and composer out of a short window. The Team panel
            lists them all. */}
        {agent.claims && agent.claims.length > 0 && (
          <span
            className={`${styles.chip} ${styles.headerLine}`}
            title={agent.claims.map((c) => (c.note ? `${c.pattern}: ${c.note}` : c.pattern)).join("\n")}
          >
            {agent.claims.length === 1
              ? `Editing ${agent.claims[0].pattern}${agent.claims[0].note ? `: ${agent.claims[0].note.slice(0, 40)}` : ""}`
              : `Editing ${agent.claims.length} paths`}
          </span>
        )}
        {agent.heldBy && (
          <span className={`${styles.warning} ${styles.headerHold}`}>
            <span className={styles.headerLine} title={agent.heldBy.reason}>
              On hold by {agent.heldBy.holderName}: {agent.heldBy.reason.slice(0, 60)}
            </span>
            <button onClick={() => void run({ action: "releaseHold", holdId: agent.heldBy!.id })}>Lift</button>
          </span>
        )}
        {agent.merging && (
          <span className={`${styles.warning} ${styles.headerLine}`} title={agent.merging.files.join(", ")}>
            Merging {agent.merging.fromName}&apos;s work: {plural(agent.merging.files.length, "conflict")}
          </span>
        )}
        <span className={styles.headerActions}>
          <button onClick={onMaximize} aria-label={maximized ? "Show all windows" : "Maximize"} title={maximized ? "Show all windows" : "Maximize"}>
            {maximized ? "⤡" : "⤢"}
          </button>
          <MenuButton className={styles.iconButton} label={`${agent.name}'s menu`} title="More: changes, rename, stop, close…" items={menu}>
            <Icon name="more" />
          </MenuButton>
        </span>
      </header>
      {agent.helpers.shown.length > 0 && (
        <div className={styles.helpers} aria-label={`${agent.name}'s helpers`}>
          {agent.helpers.shown.map((h) => (
            <button
              key={h.id}
              className={h.state === "running" ? styles.helper : `${styles.helper} ${styles.helperDone}`}
              disabled={!h.canOpen}
              title={h.canOpen ? "Open its transcript" : "Its transcript is not available"}
              onClick={() => onOpenHelper(h.id, h.name)}
            >
              {h.type}: {h.name}
              {h.state === "running"
                ? ` · ${h.tool ?? "starting"} · ${elapsed(h.startedAt)}`
                : ` · ${h.state}${h.tool ? ` · ${h.tool}` : ""} · ${elapsed(h.startedAt, h.endedAt ?? undefined)}`}
            </button>
          ))}
          {agent.helpers.more > 0 && <span className={styles.chip}>+{agent.helpers.more} more</span>}
        </div>
      )}
      {(() => {
        // The task list, folded under the header.
        const line = taskLine(agent.tasks, agent.taskTools);
        if (!line) return null;
        if (!agent.tasks || agent.tasks.items.length === 0) return <p className={styles.taskNone}>{line}</p>;
        return (
          <details className={styles.tasks}>
            <summary>{line}</summary>
            <ol aria-label={`${agent.name}'s task list`}>
              {agent.tasks.items.map((item, i) => (
                <li key={i} className={item.status === "completed" ? styles.taskDone : item.status === "in_progress" ? styles.taskNow : undefined}>
                  <span aria-hidden>{item.status === "completed" ? "☑" : item.status === "in_progress" ? "◐" : "☐"}</span> {item.text}
                </li>
              ))}
            </ol>
          </details>
        );
      })()}
      {agent.state === "error" && <p className={styles.errorLine}>{agent.error}</p>}
      <div className={styles.transcriptArea}>
        <div className={styles.transcript} ref={scroller} onScroll={onScroll}>
          <div className={styles.transcriptBody} ref={body}>
            {blocks.length === 0 && <p className={styles.hint}>{agent.role ? agent.role : "Send this agent a message to start."}</p>}
            {blocks.map((b, i) => (
              // The last text of a running turn is still streaming.
              <BlockView key={b.key} block={b} live={agent.status === "working" && i === blocks.length - 1} onLink={onLink} onOpenFile={openFile} />
            ))}
          </div>
        </div>
        {showLatest && (
          <button
            className={styles.latest}
            aria-label="Jump to the latest message"
            title="Jump to the latest message"
            onClick={() => {
              following.current = true;
              setShowLatest(false);
              toEnd();
            }}
          >
            ↓
          </button>
        )}
      </div>
      {uploads.length > 0 && (
        <div className={styles.uploads}>
          {uploads.map((u) => (
            <span key={u.key} className={u.state === "failed" ? styles.uploadFailed : styles.chip} title={u.message}>
              {u.state === "uploading" ? `Uploading ${u.name}…` : u.state === "done" ? `✓ ${u.name}` : `${u.name}: ${u.message ?? u.state}`}
            </span>
          ))}
          <button className={styles.linkish} onClick={clearUploads} title="Remove them from this message; they are announced with the next turn">
            Clear
          </button>
        </div>
      )}
      {agent.queued.length > 0 && (
        <ol className={styles.queued} aria-label={`Messages waiting for ${agent.name}`}>
          {agent.queued.map((q) => (
            <li key={q.id} className={editing === q.id ? styles.queuedEditing : undefined}>
              <span className={styles.queuedText} title={q.text}>
                {q.text}
              </span>
              {q.summary && <span className={styles.chip}>summary request</span>}
              {q.next && <span className={styles.chip}>next</span>}
              {q.edited && <span className={styles.chip}>edited</span>}
              {q.files.length > 0 && <span className={styles.chip}>{q.files.length === 1 ? q.files[0] : `${q.files.length} files`}</span>}
              <span className={styles.queuedButtons}>
                <button
                  // The summary request's text is fixed.
                  hidden={q.summary}
                  onClick={() => {
                    edit(q.id, q.text);
                    box.current?.focus();
                  }}
                >
                  Edit
                </button>
                {deleting === q.id ? (
                  <button
                    className={styles.danger}
                    onClick={() => {
                      setDeleting(null);
                      void run({ action: "deleteQueued", turnId: q.id }).then((data) => {
                        // Refused (it already went to the agent): an edit in
                        // progress keeps its text.
                        if (!data) return;
                        if (editing === q.id) clearDraft();
                        const files = (data as { files?: string[] }).files ?? [];
                        if (files.length) window.alert(`Deleted. Its files stay in ${agent.name}'s folder, unannounced: ${files.join(", ")}.`);
                      });
                    }}
                  >
                    Delete?
                  </button>
                ) : (
                  <button onClick={() => setDeleting(q.id)}>Delete</button>
                )}
                {!q.first && (
                  <button title="Deliver it as soon as the current turn ends" onClick={() => void run({ action: "sendNext", turnId: q.id })}>
                    Send next
                  </button>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className={styles.composer}>
        <textarea
          ref={box}
          aria-label={`Message to ${agent.name}`}
          rows={2}
          value={draft}
          placeholder={agent.state === "creating" ? "Setting up its folder…" : `Message ${agent.name}`}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
            if (!images.length) return;
            e.preventDefault();
            uploadAll(images.map((f, i) => new File([f], pastedName(f.type, i), { type: f.type })));
          }}
        />
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) uploadAll(e.target.files);
            e.target.value = "";
          }}
        />
        <div className={styles.composerButtons}>
          <button onClick={() => fileInput.current?.click()} disabled={agent.state !== "ready"} aria-label={`Upload files to ${agent.name}`} title="Upload files">
            Attach
          </button>
          {editing !== null && <button onClick={clearDraft}>Cancel</button>}
          <button
            className={styles.primary}
            disabled={!draft.trim() || sending || agent.state === "error" || uploading}
            title={uploading ? "Waiting for the attached files to finish uploading" : undefined}
            onClick={() => void send()}
          >
            {editing !== null ? "Save edit" : "Send"}
          </button>
          {busy && <button onClick={() => void run({ action: "stop", agentId: agent.id })}>Stop</button>}
        </div>
      </div>
    </section>
  );
}
