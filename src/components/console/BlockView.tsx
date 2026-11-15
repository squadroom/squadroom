import { memo, useState } from "react";
import { formatSize, toolPaths } from "@/lib/console/files";
import type { Block } from "@/lib/console/transcript";
import type { StepsRow } from "@/lib/console/ui";
import { markdownPieces } from "@/lib/shared/markdown-stream";
import RichMarkdown, { type AgentImages } from "./RichMarkdown";
import styles from "./console.module.css";

// One block of an agent's transcript: the owner's message, the agent's text
// and thinking, a tool call, an upload, a permission, a team message, a push,
// a status, an error or a note.

/** One finished piece of a streaming reply: rendered once. */
const Piece = memo(function Piece({ text, onLink, highlight, images }: { text: string; onLink: (href: string) => boolean; highlight: boolean; images?: AgentImages }) {
  return (
    <RichMarkdown onLink={onLink} highlight={highlight} images={images}>
      {text}
    </RichMarkdown>
  );
});

/** An agent's text: its Markdown is parsed and highlighted again only when
 * the text (or the link handler) changes, not on every poll.
 * While it streams (`live`), only its last piece is parsed again on each
 * update, unhighlighted; final, it is rendered whole.
 * A diagram is drawn once its piece is finished, never on each token, and
 * the agent's own images show in place (`images`). */
const TextBlock = memo(function TextBlock({ text, live, onLink, images }: { text: string; live: boolean; onLink: (href: string) => boolean; images?: AgentImages }) {
  if (!live)
    return (
      <div className={styles.text}>
        <RichMarkdown onLink={onLink} images={images}>
          {text}
        </RichMarkdown>
      </div>
    );
  const pieces = markdownPieces(text);
  return (
    <div className={styles.text}>
      {pieces.map((piece, i) => (
        <Piece key={i} text={piece} onLink={onLink} highlight={i < pieces.length - 1} images={images} />
      ))}
    </div>
  );
});

/** A run of tool rows: two or more show as one line that opens
 * to the rows themselves. Open or closed is the owner's choice once made;
 * until then a run with a failed tool is open. A single tool is drawn in
 * the same place, so a row keeps what the owner opened when a second tool
 * joins it. */
export function StepsView({ row, onLink, onOpenFile }: { row: StepsRow; onLink: (href: string) => boolean; onOpenFile: (path: string) => void }) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? row.failed > 0;
  return (
    <div className={styles.steps}>
      {row.line && (
        <button className={row.failed ? `${styles.stepsLine} ${styles.stepsFailed}` : styles.stepsLine} aria-expanded={open} onClick={() => setChosen(!open)}>
          <span aria-hidden="true">{open ? "▼" : "▶"}</span> {row.line}
        </button>
      )}
      <div className={row.line ? `${styles.steps} ${styles.stepsRows}` : styles.steps} hidden={!!row.line && !open}>
        {row.blocks.map((b) => (
          <BlockView key={b.key} block={b} onLink={onLink} onOpenFile={onOpenFile} />
        ))}
      </div>
    </div>
  );
}

/** `live`: the block is the reply still streaming. */
export default function BlockView({
  block,
  live = false,
  onLink,
  images,
  onOpenFile,
}: {
  block: Block;
  live?: boolean;
  onLink: (href: string) => boolean;
  /** The agent whose own image files a reply shows in place. */
  images?: AgentImages;
  onOpenFile: (path: string) => void;
}) {
  switch (block.type) {
    case "owner":
      return (
        <div className={styles.owner}>
          {block.text}
          {block.during && (
            <span className={styles.chip} title="The agent got this message in the middle of the turn it was working on">
              {" "}
              sent during the turn
            </span>
          )}
          {block.edited && (
            <span className={styles.chip} title="Edited while it waited">
              {" "}
              edited
            </span>
          )}
        </div>
      );
    case "text":
      return <TextBlock text={block.text} live={live} onLink={onLink} images={images} />;
    case "upload":
      return (
        <p className={styles.statusLine}>
          You uploaded <button className={styles.linkish} onClick={() => onOpenFile(block.path)}>{block.path}</button> ({formatSize(block.size)})
        </p>
      );
    case "thinking":
      return (
        <details className={styles.thinking}>
          <summary>Thinking</summary>
          <p>{block.text}</p>
        </details>
      );
    case "tool":
      return (
        <details className={block.error ? styles.toolError : styles.tool}>
          <summary>
            <b>{block.name}</b> {block.summary}
          </summary>
          {toolPaths(block.name, block.summary).map((p) => (
            <button key={p} className={styles.linkish} onClick={() => onOpenFile(p)}>
              Open {p.split("/").pop()}
            </button>
          ))}
          {block.output !== null && <pre>{block.output}</pre>}
        </details>
      );
    case "permission":
      return (
        <p className={block.decision === "ask" ? styles.waiting : styles.denied}>
          {block.decision === "ask" ? `Waiting for you (Needs you): ${block.reason}` : block.decision === "allow" ? block.reason : `Refused ${block.tool}: ${block.reason}`}
        </p>
      );
    case "status":
      return (
        <p className={styles.statusLine}>
          {block.status === "stopped" ? "Stopped" : block.status === "interrupted" ? "Interrupted" : "Failed"}
          {block.reason ? `: ${block.reason}` : ""}
        </p>
      );
    case "error":
      return <p className={styles.errorLine}>{block.text}</p>;
    case "team":
      return (
        <div className={styles.team}>
          {block.messages.map((m, i) => (
            <div key={i} className={styles.teamMessage}>
              <b>
                {m.from}
                {m.kind === "ask" ? " asks" : m.kind === "reply" ? " answers" : ""}
              </b>
              {m.correlationId && <span className={styles.chip}>{m.correlationId}</span>}
              <div>{m.text}</div>
            </div>
          ))}
        </div>
      );
    case "push":
      return (
        <p className={styles.statusLine}>
          {block.text}{" "}
          {block.url && (
            <a href={block.url} target="_blank" rel="noreferrer">
              {/\/pull\/\d+/.test(block.url) ? "View pull request" : "Open pull request"}
            </a>
          )}
        </p>
      );
    case "note":
      return <p className={styles.statusLine}>{block.text}</p>;
  }
}
