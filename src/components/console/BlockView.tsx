import { memo } from "react";
import Markdown from "@/components/shared/Markdown";
import { formatSize, toolPaths } from "@/lib/console/files";
import type { Block } from "@/lib/console/transcript";
import { markdownPieces } from "@/lib/shared/markdown-stream";
import styles from "./console.module.css";

/** One finished piece of a streaming reply: rendered once. */
const Piece = memo(function Piece({ text, onLink, highlight }: { text: string; onLink: (href: string) => boolean; highlight: boolean }) {
  return (
    <Markdown onLink={onLink} highlight={highlight}>
      {text}
    </Markdown>
  );
});

/** An agent's text: its Markdown is parsed and highlighted again only when
 * the text (or the link handler) changes, not on every poll.
 * While it streams (`live`), only its last piece is parsed again on each
 * update, unhighlighted; final, it is rendered whole. */
const TextBlock = memo(function TextBlock({ text, live, onLink }: { text: string; live: boolean; onLink: (href: string) => boolean }) {
  if (!live)
    return (
      <div className={styles.text}>
        <Markdown onLink={onLink}>{text}</Markdown>
      </div>
    );
  const pieces = markdownPieces(text);
  return (
    <div className={styles.text}>
      {pieces.map((piece, i) => (
        <Piece key={i} text={piece} onLink={onLink} highlight={i < pieces.length - 1} />
      ))}
    </div>
  );
});

/** `live`: the block is the reply still streaming. */
export default function BlockView({
  block,
  live = false,
  onLink,
  onOpenFile,
}: {
  block: Block;
  live?: boolean;
  onLink: (href: string) => boolean;
  onOpenFile: (path: string) => void;
}) {
  switch (block.type) {
    case "owner":
      return (
        <div className={styles.owner}>
          {block.text}
          {block.edited && (
            <span className={styles.chip} title="Edited while it waited">
              {" "}
              edited
            </span>
          )}
        </div>
      );
    case "text":
      return <TextBlock text={block.text} live={live} onLink={onLink} />;
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
