import { AGENT_KINDS } from "@/lib/console/agents";
import { kindInitials } from "@/lib/console/ui";
import { EVEN_ODD, KIND_LOGOS } from "./kindLogos";
import styles from "./console.module.css";

/** An agent's kind: the maker's small mark in one colour where there is
 * one, otherwise two letters; in its window header and on its sidebar row.
 * The full name is its tooltip and accessible text. */
export default function KindBadge({ kind, small }: { kind: string; small?: boolean }) {
  const label = AGENT_KINDS.find((k) => k.kind === kind)?.label ?? kind;
  const logo = KIND_LOGOS[kind];
  return (
    <span className={small ? `${styles.kindBadge} ${styles.kindBadgeSmall}` : styles.kindBadge} title={label}>
      {logo ? (
        <svg viewBox="0 0 24 24" width={small ? 11 : 13} height={small ? 11 : 13} fill="currentColor" aria-hidden="true" focusable="false">
          <path d={logo} fillRule={EVEN_ODD.has(kind) ? "evenodd" : undefined} />
        </svg>
      ) : (
        <span aria-hidden="true">{kindInitials(label)}</span>
      )}
      <span className={styles.srOnly}>{label}</span>
    </span>
  );
}
