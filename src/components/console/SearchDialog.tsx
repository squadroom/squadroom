import { useCallback, useState } from "react";
import type { searchView } from "@/lib/console/views";
import { elapsed, snippetParts } from "@/lib/console/ui";
import { api, usePolled } from "./api";
import Dialog from "./Dialog";
import styles from "./console.module.css";

// Search: the stored conversations (the owner's messages, team messages
// and each turn's final reply, as stored: redacted). Show opens the agent's
// window. The top bar's box opens it with its words.

type Results = ReturnType<typeof searchView>["results"];

export default function SearchDialog({
  words = "",
  onClose,
  canShow,
  onShow,
}: {
  words?: string;
  onClose: () => void;
  canShow: (agentId: string) => boolean;
  onShow: (agentId: string) => void;
}) {
  const [text, setText] = useState(words);
  const [results, setResults] = useState<Results | null>(null);
  const [status, setStatus] = useState("");
  const search = useCallback(async (text: string) => {
    setStatus("Searching…");
    try {
      setResults((await api<{ results: Results }>(undefined, `?search=${encodeURIComponent(text)}`)).results);
      setStatus("");
    } catch (e) {
      setStatus((e as Error).message);
    }
  }, []);
  // Once, for the words it opened with.
  usePolled(useCallback(() => void (words && search(words)), [words, search]), null);
  return (
    <Dialog title="Search" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void search(text);
        }}
      >
        <input type="search" aria-label="Search the conversations" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Words from a message or reply" />
        <button className={styles.primary} type="submit" disabled={!text.trim()}>
          Search
        </button>
      </form>
      {status && <p className={styles.hint}>{status}</p>}
      {results && !results.length && <p className={styles.hint}>Nothing found.</p>}
      {results?.map((r) => (
        <div key={`${r.turnId}:${r.reply}`} className={styles.need}>
          <p>
            <strong>{r.agentName}</strong> ({r.projectName} › {r.tabName}), {r.reply ? "its reply" : "a message to it"}, {elapsed(r.createdAt)} ago
          </p>
          <p className={styles.needText}>
            {snippetParts(r.snippet).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
          </p>
          {canShow(r.agentId) && <button onClick={() => onShow(r.agentId)}>Show</button>}
        </div>
      ))}
    </Dialog>
  );
}
