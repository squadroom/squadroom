import { useState } from "react";
import { oneAtATime } from "@/lib/console/busy";

/** A dialog's action, one at a time: `busy` disables
 * its button while it runs, and a second click joins the first. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const [guard] = useState(() =>
    oneAtATime(async (action: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await action();
      } finally {
        setBusy(false);
      }
    }),
  );
  return { busy, guard: (action: () => Promise<unknown>) => void guard(action).catch(() => {}) };
}
