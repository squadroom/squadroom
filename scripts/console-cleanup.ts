// Folder cleanup from the terminal: `npm run console:cleanup`. It asks the
// running Console worker to list what no open agent or project uses (sizes,
// and commits that were never pushed), then removes it only after you type
// "yes". The worker does both, as the `agent` user.
import { createInterface } from "node:readline/promises";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { consoleStorePath } from "../src/lib/console/config.ts";
import type { CleanupDone, CleanupItem } from "../src/lib/console/cleanup.ts";
import { formatSize } from "../src/lib/console/files.ts";

const store = new ConsoleStore(consoleStorePath());
async function wait(id: number): Promise<unknown> {
  for (const end = Date.now() + 10 * 60_000; Date.now() < end; ) {
    const c = store.cleanup(id);
    if (c?.state === "done") return c.result;
    if (c?.state === "failed") throw new Error((c.result as { message?: string } | null)?.message ?? "The cleanup failed.");
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("The Console worker did not answer. Is it running (npm run console:worker)?");
}
try {
  const { items } = (await wait(store.queueCleanup("scan"))) as { items: CleanupItem[] };
  if (!items.length) {
    console.log("Nothing to clean up.");
    process.exit(0);
  }
  for (const i of items)
    console.log(`${i.sizeKb === null ? "     ?" : formatSize(i.sizeKb * 1024).padStart(9)}  ${i.key}  ${i.what}${i.warning ? `\n           ⚠ ${i.warning}` : ""}`);
  const total = items.reduce((n, i) => n + (i.sizeKb ?? 0), 0);
  const warned = items.filter((i) => i.warning).length;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\nRemove all ${items.length} (${formatSize(total * 1024)})${warned ? `, including ${warned} with commits that would be lost` : ""}? Type yes to remove: `,
  );
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") {
    console.log("Nothing removed.");
    process.exit(0);
  }
  const done = (await wait(store.queueCleanup("delete", items.map((i) => i.key)))) as CleanupDone;
  console.log(`Removed ${done.removed.length}.`);
  for (const s of done.skipped) console.log(`Left ${s.key}: ${s.reason}`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  store.close();
}
