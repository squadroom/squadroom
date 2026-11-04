import Link from "next/link";
import styles from "./not-found.module.css";

// App-level 404: any bad URL lands here with a way back in, instead of Next's
// dead-end default. Static markup only: no data access, no client JS.
export default function NotFound() {
  return (
    <main className={styles.page}>
      <p className={styles.code}>404</p>
      <h1 className={styles.title}>There&apos;s nothing at this address</h1>
      <p className={styles.note}>The link may be wrong or out of date.</p>
      <Link href="/console" className={styles.link}>
        Open the Console
      </Link>
    </main>
  );
}
