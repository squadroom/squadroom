// After `next build`: fail when any server file trace lists Git data, docs,
// tests or scripts. Offline; reads .next.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { forbiddenTracePath } from "../src/config/build-trace.ts";

const root = process.cwd();
const traces: string[] = [];
const walk = (dir: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".nft.json")) traces.push(path);
  }
};
walk(join(root, ".next", "server"));
const found: string[] = [];
for (const trace of traces) {
  const { files } = JSON.parse(readFileSync(trace, "utf8")) as { files: string[] };
  for (const file of files) {
    const path = relative(root, resolve(dirname(trace), file));
    if (forbiddenTracePath(path)) found.push(`${relative(root, trace)}: ${path}`);
  }
}
if (found.length) {
  console.error(`The build's file trace carries ${found.length} path(s) it must not:\n${found.slice(0, 20).join("\n")}`);
  process.exit(1);
}
console.log(`Build trace checked: ${traces.length} trace files, nothing excluded is carried.`);
