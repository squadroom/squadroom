import { useEffect, useRef, useState } from "react";
import { readAgent } from "./api";
import styles from "./console.module.css";

// An image from an agent's folder, shown in its conversation.
// It is read the way the file panel reads a file (by the worker, as the
// agent, inside its folder only) and shown as a `data:` image: the browser
// never fetches an address an agent wrote.

/** The last images read, so scrolling back does not read them again. The
 * read API hands a whole image over as base64, so a long conversation
 * could hold a great deal: an image is held only while it is on screen,
 * plus the few here, and one here is read again after a minute (an agent
 * redraws its charts). */
const reads = new Map<string, { at: number; src: Promise<string> }>();
const KEEP = 12;
const FRESH_MS = 60_000;

function read(agentId: string, path: string): Promise<string> {
  const key = `${agentId}\n${path}`;
  const had = reads.get(key);
  reads.delete(key);
  if (had && Date.now() - had.at < FRESH_MS) {
    reads.set(key, had);
    return had.src;
  }
  const entry = {
    at: Date.now(),
    src: readAgent({ action: "readFile", agentId, path }).then((view) => {
      if (view?.kind === "image" && view.base64) return `data:${view.mime};base64,${view.base64}`;
      throw new Error(view?.message ?? "The Console worker did not read it.");
    }),
  };
  reads.set(key, entry);
  entry.src.catch(() => reads.get(key) === entry && reads.delete(key));
  if (reads.size > KEEP) reads.delete(reads.keys().next().value!);
  return entry.src;
}

/** Click opens it in the file panel. */
export default function AgentImage({ agentId, path, alt, onOpen }: { agentId: string; path: string; alt: string; onOpen: () => void }) {
  const box = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** Its height while shown, kept when it leaves the screen so the
   * conversation does not jump. */
  const [held, setHeld] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let alive = true;
    let shown = false;
    const show = (on: boolean) => {
      if (on === shown) return;
      shown = on;
      if (!on) {
        setHeld(el.offsetHeight);
        return setSrc(null);
      }
      read(agentId, path).then(
        (data) => alive && shown && setSrc(data),
        (e: Error) => alive && setFailed(e.message),
      );
    };
    if (typeof IntersectionObserver === "undefined") {
      show(true);
      return () => {
        alive = false;
      };
    }
    const observer = new IntersectionObserver((entries) => show(entries[entries.length - 1].isIntersecting));
    observer.observe(el);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [agentId, path]);
  return (
    <button ref={box} className={styles.inlineImage} style={src ? undefined : { minHeight: held || undefined }} onClick={onOpen} title={`Open ${path}`}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt || path} />
      ) : (
        <span>{failed ? `[Image: ${path}: ${failed}]` : `[Image: ${alt || path}]`}</span>
      )}
    </button>
  );
}
