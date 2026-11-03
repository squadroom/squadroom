import { createHash } from "node:crypto";
import { CONSOLE_CODE_MS, KEY_ACTIONS, storeFailure, type CommandAction, freshCodeContext, runKeysCommand, needsFreshCode, runCommand } from "@/lib/console/commands";
import { archiveImpact, branchPatchView, keysPageView, changesView, commitPatchView, needsView, projectView, projectsView, rolesView, searchView, templatesView, treeView, workerView } from "@/lib/console/views";
import { consoleAccess, consoleHealth, consoleJson, consoleSignIn, consoleStore } from "@/lib/console/web";
import { consoleKeysFile, consoleLogFile } from "@/lib/console/config";
import { readLog } from "@/lib/console/log";
import { overviewView } from "@/lib/console/overview";
import { reportData, runReport } from "@/lib/console/report";
import { Redactor } from "@/lib/console/redact";
import { serverSettings } from "@/config/server-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Squadroom Console's API. Every request needs the signed-in session;
// owner commands also need Origin and a same-origin fetch. The web process
// never starts an agent: the Console worker runs every turn.

type Store = ReturnType<typeof consoleStore>;
/** The worker's jobs the page waits on, read by their id (`?upload=3`): what
 * each answer holds, and the error when the id is unknown. */
const JOBS: Record<string, { read: (store: Store, id: number) => object | undefined; missing: string }> = {
  fileRead: {
    read: (store, id) => {
      const read = store.fileRead(id);
      return read && { state: read.state, result: read.result };
    },
    missing: "That file request has expired.",
  },
  cleanup: { read: (store, id) => store.cleanup(id), missing: "No such cleanup." },
  upload: {
    read: (store, id) => {
      const upload = store.upload(id);
      return upload && { state: upload.state, message: upload.message, name: upload.name };
    },
    missing: "No such upload.",
  },
};

export async function GET(request: Request) {
  const health = consoleHealth(request);
  if (health) return health;
  const gate = consoleAccess(request, "GET");
  if (gate.denied) return gate.denied;
  try {
    const store = consoleStore();
    const worker = workerView(store, Date.now());
    const params = new URL(request.url).searchParams;
    for (const [param, job] of Object.entries(JOBS)) {
      if (!params.has(param)) continue;
      const id = Number(params.get(param));
      const found = Number.isSafeInteger(id) ? job.read(store, id) : undefined;
      return found ? consoleJson(found) : consoleJson({ error: job.missing }, 404);
    }
    const impact = params.get("impact");
    if (impact) {
      const [scope, target] = impact.split(":");
      const view = scope === "project" || scope === "tab" ? archiveImpact(store, scope, target ?? "") : null;
      return view ? consoleJson(view) : consoleJson({ error: "That does not exist." }, 404);
    }
    // The Keys page and connection panels: key names, their last four
    // characters and caps, never a stored value. The signed-in devices are
    // listed there too, by a short handle.
    if (params.has("keys"))
      return consoleJson({ worker, ...keysPageView(store, consoleKeysFile()), devices: consoleSignIn(serverSettings()).devices(gate.session) });
    // The Overview: health, activity, spend and problems.
    if (params.has("overview")) return consoleJson(overviewView(store, consoleKeysFile(), Date.now()));
    // The worker's log: its latest entries, masked again.
    if (params.has("logs")) return consoleJson({ entries: readLog(consoleLogFile()) });
    // The run report: a tab as Markdown, from the store only.
    const report = params.get("report");
    if (report) {
      const data = reportData(store, report, Date.now());
      // Names are not redacted when saved: the whole report, and its title,
      // pass the web's key-shape redactor on the way out.
      const redact = new Redactor();
      return data
        ? consoleJson({ markdown: redact.text(runReport(data)), name: redact.text(`${data.project} - ${data.tab}`) })
        : consoleJson({ error: "That tab does not exist." }, 404);
    }
    // Search over the stored, redacted conversations.
    const search = params.get("search");
    if (search !== null) return consoleJson(searchView(store, search.slice(0, 200)));
    const changes = params.get("changes");
    if (changes) {
      // The dialog's list, every 3 seconds; one commit's patch, or the
      // branch's, when it is opened.
      const commit = params.get("commit");
      const view = commit ? commitPatchView(store, changes, Number(commit)) : params.has("branch") ? branchPatchView(store, changes) : changesView(store, changes);
      return view ? consoleJson(view) : consoleJson({ error: commit ? "That commit does not exist." : "That agent does not exist." }, 404);
    }
    // Polling: a view the page already has is answered with its version
    // only, so an unchanged project is neither sent nor rendered again. The
    // worker's state is always sent.
    const versioned = (view: object) => {
      const version = createHash("sha256").update(JSON.stringify(view)).digest("hex").slice(0, 16);
      return params.get("version") === version ? consoleJson({ worker, unchanged: true, version }) : consoleJson({ worker, ...view, version });
    };
    const projectId = params.get("project");
    if (projectId) {
      const view = projectView(store, projectId);
      return view ? versioned(view) : consoleJson({ error: "That project does not exist." }, 404);
    }
    return versioned({ projects: projectsView(store), needs: needsView(store), tree: treeView(store), roles: rolesView(store), templates: templatesView(store) });
  } catch {
    return consoleJson({ error: "Unable to read the Console's store." }, 500);
  }
}

/** Why a weighty command is refused on a server without mail. */
const MAIL_REQUIRED =
  "This action needs a code e-mailed to you, and e-mail is not configured on this server. Set CONSOLE_RESEND_API_KEY, CONSOLE_MAIL_FROM and CONSOLE_NOTIFY_EMAIL (see docs/setup.md) and restart Squadroom to enable it.";

export async function POST(request: Request) {
  const gate = consoleAccess(request, "POST");
  if (gate.denied) return gate.denied;
  let input: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 64_000) throw new Error();
    input = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
  } catch {
    return consoleJson({ error: "Send a JSON request smaller than 64 KB." }, 400);
  }
  // Weighty commands (`needsFreshCode`) need a code e-mailed to you and
  // entered in the last 8 hours; the page asks for one and sends the command
  // again. Without mail there is no second factor, so they are refused.
  try {
    const store = consoleStore();
    const action = input.action as CommandAction;
    const needsCode = needsFreshCode(input, freshCodeContext(store, input));
    const service = consoleSignIn(serverSettings());
    if (needsCode && !service.emailCodes) return consoleJson({ error: MAIL_REQUIRED }, 403);
    if (needsCode && !service.freshCode(gate.session, CONSOLE_CODE_MS))
      return consoleJson({ error: "This action needs the code we e-mail you, entered in the last 8 hours.", freshCode: true }, 403);
    // Sign out one device: as with Sign out everywhere, a normal session is
    // enough, since ending sessions only takes access away.
    if (action === "signOutDevice") {
      if (!service.signOutDevice(input.id)) return consoleJson({ error: "That device is no longer signed in." }, 409);
      return consoleJson({ signedOut: true });
    }
    return consoleJson(KEY_ACTIONS.has(action) ? runKeysCommand(store, consoleKeysFile(), input) : runCommand(store, input, { freshCode: needsCode }));
  } catch (error) {
    if (!storeFailure(error)) return consoleJson({ error: (error as Error).message }, 409);
    return consoleJson({ error: "Unable to save to the Console's store." }, 500);
  }
}
