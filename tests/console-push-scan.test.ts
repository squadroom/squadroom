import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../src/lib/console/commands.ts";
import { Launcher } from "../src/lib/console/launcher.ts";
import { ConsoleWorker } from "../src/lib/console/worker.ts";
import { git, GIT_TOKEN, harness, TOKEN } from "./helpers/console-harness.ts";
import { api, origin } from "./helpers/fake-github.ts";

// The check before Push branch: a branch whose commits carry a credential
// anywhere (a binary blob, removed history, a file Git does not diff, a
// commit message) or add the owner's uploads is refused, and every key in
// the key file counts, in a worker that never handed one out. "GitHub" is
// a local bare repository and a fake API; Git is real.

/** Files committed directly in an agent's folder (as the test user), the
 * way an agent's own `git commit` or an earlier turn would leave them. */
function commitFiles(folder: string, message: string, files: Record<string, string | Buffer>) {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(folder, name), content);
  git(folder, "add", "-A");
  git(folder, "-c", "user.name=Agent", "-c", "user.email=a@x", "commit", "--quiet", "--no-verify", "-m", message);
}
/** A commit made outside a turn, recorded as a turn's end would record it
 * (Push branch sends only a recorded head). */
async function recorded(worker: ConsoleWorker, store: ConsoleWorker["store"], agentId: string) {
  await worker.repos.refreshDiff(store.agent(agentId)!, worker.epoch!);
}

test("Push branch checks the objects GitHub lacks, not a patch: binary and -diff blobs, removed history, messages and a moved base ref are refused; a clean binary artifact pushes", async (t) => {
  const bare = origin(t);
  const h = await harness(t, {}, false, {
    project: { source: "github", repo: "https://github.com/owner/repo", baseBranch: "main" },
    githubFetch: api(),
    remoteUrl: () => bare,
  });
  await h.worker.start();
  await h.until(() => h.store.project(h.project.id)!.state === "ready", "project ready");
  const names = ["Nul", "Attr", "Moved", "Message", "Clean"] as const;
  const agents = Object.fromEntries(names.map((n) => [n, h.agent(n)])) as Record<(typeof names)[number], { id: string }>;
  await h.ready(...names.map((n) => agents[n].id));
  const folder = (n: (typeof names)[number]) => h.store.agent(agents[n].id)!.folder;
  const branch = (n: (typeof names)[number]) => h.store.agentBase(agents[n].id).branch!;
  const push = async (n: (typeof names)[number]) => {
    await recorded(h.worker, h.store, agents[n].id);
    const { job } = runCommand(h.store, { action: "push", agentId: agents[n].id }) as { job: { id: number } };
    await h.until(() => ["done", "failed"].includes(h.store.job(job.id)!.state), `push ${n}`);
    return h.store.job(job.id)!;
  };
  const refused = async (n: (typeof names)[number]) => {
    const job = await push(n);
    assert.equal(job.state, "failed", `${n}: ${job.message}`);
    assert.match(job.message ?? "", /contains a credential/);
    assert.throws(() => git(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${branch(n)}`), `${n} reached GitHub`);
  };
  // A binary blob (NUL bytes) holding the token: no patch shows it.
  commitFiles(folder("Nul"), "archive", { "archive.bin": Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(TOKEN), Buffer.from([0, 255])]) });
  await refused("Nul");
  // Removed again in a later commit: the history still carries it.
  git(folder("Nul"), "rm", "--quiet", "archive.bin");
  git(folder("Nul"), "-c", "user.name=Agent", "-c", "user.email=a@x", "commit", "--quiet", "--no-verify", "-m", "remove it");
  await refused("Nul");
  // A text file Git is told not to diff.
  commitFiles(folder("Attr"), "attributes", { ".gitattributes": "secret.txt -diff\n", "secret.txt": `token=${TOKEN}\n` });
  await refused("Attr");
  // A plain-text secret behind the clone's own base ref, which the agent
  // controls: the baseline is the owner's mirror, not that ref.
  commitFiles(folder("Moved"), "notes", { "notes.txt": `${TOKEN}\n` });
  git(folder("Moved"), "update-ref", "refs/heads/main", "HEAD");
  await refused("Moved");
  // A commit message holding the token.
  commitFiles(folder("Message"), `debug ${TOKEN}`, { "ok.txt": "fine\n" });
  await refused("Message");
  // A clean binary artifact is pushed as before.
  const icon = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), randomBytes(2048)]);
  commitFiles(folder("Clean"), "icon", { "icon.png": icon });
  const done = await push("Clean");
  assert.equal(done.state, "done", done.message ?? "");
  assert.equal(git(bare, "rev-parse", `refs/heads/${branch("Clean")}`), git(folder("Clean"), "rev-parse", "HEAD"));
  assert.match(git(bare, "ls-tree", "--name-only", `refs/heads/${branch("Clean")}`), /icon\.png/);
});

test("Push branch refuses a branch whose commits add the owner's uploads", async (t) => {
  const bare = origin(t);
  const h = await harness(t, {}, false, {
    project: { source: "github", repo: "https://github.com/owner/repo", baseBranch: "main" },
    githubFetch: api(),
    remoteUrl: () => bare,
  });
  await h.worker.start();
  await h.until(() => h.store.project(h.project.id)!.state === "ready", "project ready");
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  const folder = h.store.agent(lead.id)!.folder;
  const branch = h.store.agentBase(lead.id).branch!;
  // The agent forces an upload into a commit of its own.
  mkdirSync(join(folder, ".console-uploads"), { recursive: true });
  writeFileSync(join(folder, ".console-uploads", "contract.pdf"), "%PDF private\n");
  git(folder, "add", "-f", ".console-uploads/contract.pdf");
  git(folder, "-c", "user.name=Agent", "-c", "user.email=a@x", "commit", "--quiet", "--no-verify", "-m", "upload");
  await recorded(h.worker, h.store, lead.id);
  const { job } = runCommand(h.store, { action: "push", agentId: lead.id }) as { job: { id: number } };
  await h.until(() => ["done", "failed"].includes(h.store.job(job.id)!.state), "push");
  assert.equal(h.store.job(job.id)!.state, "failed");
  assert.match(h.store.job(job.id)!.message ?? "", /add files under \.console-uploads/);
  assert.throws(() => git(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`));
});

test("the push check knows every key in the key file, in a worker that never handed one out", async (t) => {
  const bare = origin(t);
  const h = await harness(t, {}, false, {
    project: { source: "github", repo: "https://github.com/owner/repo", baseBranch: "main" },
    githubFetch: api(),
    remoteUrl: () => bare,
  });
  // A key no Claude Code agent is ever handed, present only in the file.
  const GEMINI = "AIzaSyFAKE-gemini-key-0000000000000000000";
  const keysFile = join(h.root, "keys.json");
  writeFileSync(keysFile, JSON.stringify({ keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN }, CONSOLE_GIT_TOKEN: { value: GIT_TOKEN }, GEMINI_API_KEY: { value: GEMINI } }, projects: {} }), { mode: 0o600 });
  await h.worker.start();
  await h.until(() => h.store.project(h.project.id)!.state === "ready", "project ready");
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  commitFiles(h.store.agent(lead.id)!.folder, "config", { "config.env": `GEMINI_API_KEY=${GEMINI}\n` });
  await recorded(h.worker, h.store, lead.id);
  // A new worker on the same store: it spawned nothing, so it was handed
  // nothing; the key file alone must tell it what to refuse.
  await h.worker.stop();
  const next = new ConsoleWorker({
    store: h.store,
    launcher: new Launcher({ command: [join(h.root, "launcher")] }),
    paths: { agentHome: h.agentHome, shared: h.shared },
    keysFile,
    binary: () => join(h.root, "claude"),
    tickMs: 25,
    renewMs: 100,
    stopGraceMs: 300,
    log: () => {},
    mirrorsDir: join(h.root, "mirrors"),
    githubFetch: api(),
    remoteUrl: () => bare,
    freeBytes: () => 1024 ** 4,
  });
  try {
    await next.start();
    const { job } = runCommand(h.store, { action: "push", agentId: lead.id }) as { job: { id: number } };
    await h.until(() => ["done", "failed"].includes(h.store.job(job.id)!.state), "push refused");
    assert.equal(h.store.job(job.id)!.state, "failed");
    assert.match(h.store.job(job.id)!.message ?? "", /contains a credential/);
    assert.throws(() => git(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${h.store.agentBase(lead.id).branch}`));
  } finally {
    await next.stop();
  }
});

test("a worker that never spawned an agent refuses to push a branch holding a project's own key from the key file", async (t) => {
  const bare = origin(t);
  const h = await harness(t, {}, false, {
    project: { source: "github", repo: "https://github.com/owner/repo", baseBranch: "main" },
    githubFetch: api(),
    remoteUrl: () => bare,
  });
  // The new shape, with the key only in the project's own overrides, and a
  // cap whose link must not block a push that mentions it.
  const OVERRIDE = "sk-proj-FAKE-project-only-key-2222222222222";
  const cap = { usd: 10, url: "https://platform.openai.com/settings/organization/limits", checkedAt: "2026-10-20" };
  const keysFile = join(h.root, "keys.json");
  writeFileSync(
    keysFile,
    JSON.stringify({
      keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN }, CONSOLE_GIT_TOKEN: { value: GIT_TOKEN } },
      projects: { [h.project.id]: { OPENAI_API_KEY: { value: OVERRIDE, cap } } },
    }),
    { mode: 0o600 },
  );
  await h.worker.start();
  await h.until(() => h.store.project(h.project.id)!.state === "ready", "project ready");
  const lead = h.agent("Lead");
  await h.ready(lead.id);
  commitFiles(h.store.agent(lead.id)!.folder, "limits", { "LIMITS.md": `Set the cap at ${cap.url} (checked ${cap.checkedAt}, $${cap.usd}).\n` });
  await recorded(h.worker, h.store, lead.id);
  await h.worker.stop();
  const next = new ConsoleWorker({
    store: h.store,
    launcher: new Launcher({ command: [join(h.root, "launcher")] }),
    paths: { agentHome: h.agentHome, shared: h.shared },
    keysFile,
    binary: () => join(h.root, "claude"),
    tickMs: 25,
    renewMs: 100,
    stopGraceMs: 300,
    log: () => {},
    mirrorsDir: join(h.root, "mirrors"),
    githubFetch: api(),
    remoteUrl: () => bare,
    freeBytes: () => 1024 ** 4,
  });
  try {
    await next.start();
    // The cap's link and date are not secrets: that branch pushes.
    const first = runCommand(h.store, { action: "push", agentId: lead.id }) as { job: { id: number } };
    await h.until(() => ["done", "failed"].includes(h.store.job(first.job.id)!.state), "first push");
    assert.equal(h.store.job(first.job.id)!.state, "done", h.store.job(first.job.id)!.message ?? "");
    // The project's own key is: refused, in a worker that handed out nothing.
    commitFiles(h.store.agent(lead.id)!.folder, "config", { "config.env": `OPENAI_API_KEY=${OVERRIDE}\n` });
    await recorded(next, h.store, lead.id);
    const second = runCommand(h.store, { action: "push", agentId: lead.id }) as { job: { id: number } };
    await h.until(() => ["done", "failed"].includes(h.store.job(second.job.id)!.state), "second push");
    assert.equal(h.store.job(second.job.id)!.state, "failed");
    assert.match(h.store.job(second.job.id)!.message ?? "", /contains a credential/);
  } finally {
    await next.stop();
  }
});
