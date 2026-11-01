import { NAME_MAX } from "@/lib/console/types";
import styles from "./console.module.css";

/** A name edited in place: a tab, a project or an agent. It opens focused
 * with the name selected; Enter or leaving it saves, Escape keeps the old
 * name. `onDone` gets the new name, or null when nothing changed. */
export default function InlineRename({ name, label, onDone }: { name: string; label: string; onDone: (name: string | null) => void }) {
  return (
    <input
      className={styles.inlineRename}
      aria-label={label}
      defaultValue={name}
      maxLength={NAME_MAX}
      // Focused with its name selected once, not again on each poll.
      ref={(input) => {
        if (input && document.activeElement !== input) {
          input.focus();
          input.select();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.stopPropagation();
          e.currentTarget.value = name;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => {
        const next = e.currentTarget.value.trim();
        onDone(next && next !== name ? next : null);
      }}
    />
  );
}
