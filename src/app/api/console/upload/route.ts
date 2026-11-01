import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consoleUploadsDir } from "@/lib/console/config";
import { checkUpload, UPLOAD_MAX_BYTES } from "@/lib/console/files";
import { consoleAccess, consoleJson, consoleStore } from "@/lib/console/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Uploads to an agent. The page sends the raw file (same session, Origin
// and same-origin rules as every owner command); this route only stages it
// in the owner's own folder. The worker places it in the agent's folder,
// as the agent, and the next prompt says so.

export async function POST(request: Request) {
  const gate = consoleAccess(request, "POST");
  if (gate.denied) return gate.denied;
  const params = new URL(request.url).searchParams;
  const store = consoleStore();
  const agent = store.agent(params.get("agentId") ?? "");
  if (!agent || agent.state !== "ready") return consoleJson({ error: "That agent is not ready for uploads." }, 409);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > UPLOAD_MAX_BYTES) return consoleJson({ error: `Files up to ${UPLOAD_MAX_BYTES / 1024 / 1024} MB can be uploaded.` }, 413);
  let name = "";
  try {
    name = decodeURIComponent(request.headers.get("x-file-name") ?? "");
  } catch {
    return consoleJson({ error: "The file name is not valid." }, 400);
  }
  // Read with a hard bound whatever the declared length says.
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (!reader) return consoleJson({ error: "Send the file." }, 400);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > UPLOAD_MAX_BYTES) {
      await reader.cancel();
      return consoleJson({ error: `Files up to ${UPLOAD_MAX_BYTES / 1024 / 1024} MB can be uploaded.` }, 413);
    }
    chunks.push(value);
  }
  const checked = checkUpload(name, size);
  if (!checked.ok) return consoleJson({ error: checked.reason }, 400);
  const dir = consoleUploadsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const staged = join(dir, `${Date.now()}-${randomBytes(8).toString("hex")}`);
  // A staged file without its upload row is removed here; one left by a
  // process that stopped in between is removed by the worker's start sweep.
  try {
    writeFileSync(staged, Buffer.concat(chunks), { mode: 0o600 });
    const id = store.queueUpload({ agentId: agent.id, name: checked.name, size, staged, replace: params.get("replace") === "1", hold: params.get("hold") === "1" });
    return consoleJson({ uploadId: id, name: checked.name });
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
}
