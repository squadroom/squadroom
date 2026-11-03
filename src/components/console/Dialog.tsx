import Icon from "./Icon";
import { useDialogFocus } from "./useDialogFocus";
import styles from "./console.module.css";

/** A Settings section's screen: shown in place, under the page's own
 * heading, instead of over the page. */
export function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={`${styles.dialog} ${styles.inPage}`} aria-label={title}>
      {children}
    </section>
  );
}

/** The Console's dialog: a titled box over the page, closed by its ✕, by
 * Escape or by a click outside it. Focus moves into it on open,
 * stays inside it, and goes back to where it was on close (a dialog under
 * it, or the opener). */
export default function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const { box, overlay } = useDialogFocus(onClose);
  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={title} {...overlay}>
      <div ref={box} tabIndex={-1} className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <header className={styles.dialogHeader}>
          <h2>{title}</h2>
          <button className={styles.iconButton} onClick={onClose} aria-label="Close" title="Close (Esc)">
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
