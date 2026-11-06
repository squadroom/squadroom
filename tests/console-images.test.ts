import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { getEventListeners } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DESIGN_MODELS } from "../src/config/design-models.ts";
import { needsFreshCode, runCommand } from "../src/lib/console/commands.ts";
import { IMAGE_TOOLS, ImageError, listPrice, parseImageCall } from "../src/lib/console/image-tools.ts";
import { writeKeyFile } from "../src/lib/console/keys.ts";
import type { Launcher } from "../src/lib/console/launcher.ts";
import { overviewView } from "../src/lib/console/overview.ts";
import { pause } from "../src/lib/console/worker/images.ts";
import { editSize, KREA_API } from "../src/lib/shared/krea.ts";
import { GIT_TOKEN, harness, TOKEN } from "./helpers/console-harness.ts";

// the Console's image tools, offline, against a fake Krea
// through KreaClient's injected fetcher. No provider call, no spend.

const KREA = "krea-test-key-0000000000000000000000QRST";
const CAP = { usd: 10, url: "https://www.krea.ai/docs/developers/api-keys-and-billing", checkedAt: "2026-10-30" };
/** A PNG header sniffImage reads (64×32), and some bytes after it. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 0, 64, 0, 0, 0, 32]),
  Buffer.from("rest of the image"),
]);

function fakeKrea() {
  const calls: { method: string; url: string; auth: string | null; body: string | null }[] = [];
  const state = { status: "completed", bytes: PNG, urls: true };
  let jobs = 0;
  // Krea serves an edit's output from app-uploads.krea.ai, a generation's from gen.krea.ai (live check, 2026-10-31).
  const hosts = new Map<string, string>();
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ method, url, auth: new Headers(init.headers).get("authorization"), body: typeof init.body === "string" ? init.body : null });
    if (url === `${KREA_API}/assets`) return Response.json({ image_url: "https://gen.krea.ai/assets/in.png" });
    if (url.startsWith(`${KREA_API}/generate/`)) {
      hosts.set(`job-${++jobs}`, url.includes("kontext") ? "app-uploads.krea.ai" : "gen.krea.ai");
      return Response.json({ job_id: `job-${jobs}` });
    }
    if (url.startsWith(`${KREA_API}/jobs/`)) {
      if (method === "DELETE") return new Response(null, { status: 200 });
      const done = state.status === "completed";
      return Response.json({ status: state.status, result: done ? { urls: state.urls ? [`https://${hosts.get(url.split("/").pop()!)}/out/1.png`] : [] } : null, error: state.status === "failed" ? { code: "internal" } : null });
    }
    if (/^https:\/\/(gen|app-uploads)\.krea\.ai\//.test(url)) return new Response(new Uint8Array(state.bytes));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const provider = () => calls.filter((c) => c.url.startsWith(KREA_API));
  return { fetcher, calls, state, provider, submits: () => calls.filter((c) => c.url.includes("/generate/")).length };
}

const keys = (cap: typeof CAP | null = CAP) => ({
  keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN }, CONSOLE_GIT_TOKEN: { value: GIT_TOKEN }, KREA_API_KEY: { value: KREA, ...(cap ? { cap } : {}) } },
  projects: {},
});

async function setup(t: TestContext, limits = {}) {
  const krea = fakeKrea();
  const runs: { cwd: string; program: string; args: string[] }[] = [];
  /** Holds the agent's file reads (a source image) while set. */
  const gate: { hold: Promise<void> | null; hit: boolean } = { hold: null, hit: false };
  const launcher = (l: Launcher) => {
    const runIn = l.runIn.bind(l);
    l.runIn = async (cwd, program, args, ...rest) => {
      runs.push({ cwd, program, args });
      if (gate.hold && String(args[1]).includes("O_NOFOLLOW S_ISREG")) {
        gate.hit = true;
        await gate.hold;
      }
      return runIn(cwd, program, args, ...rest);
    };
    return l;
  };
  const h = await harness(t, limits, false, { kreaFetch: krea.fetcher, launcher });
  writeKeyFile(h.keysFile, keys());
  runCommand(h.store, { action: "setImageTools", projectId: h.project.id, on: true });
  await h.worker.start();
  const lead = h.agent();
  await h.ready(lead.id);
  const folder = h.store.agent(lead.id)!.folder;
  /** A running, validated turn that waits (Stop ends it). */
  const running = async (agentId = lead.id) => {
    const turnId = h.send(agentId, "hang");
    await h.started(turnId);
    await h.until(() => h.worker.runtimes.get(agentId)?.turn?.validated === true, "validated");
    return { turnId, rt: h.worker.runtimes.get(agentId)! };
  };
  const stop = async (turnId: number, agentId = lead.id) => {
    runCommand(h.store, { action: "stop", agentId });
    await h.ended(turnId);
  };
  return { h, krea, lead, folder, running, stop, runs, gate };
}
const generate = { prompt: "a red cube", name: "hero" };

test("image tools: argument checks, the models and prices in the descriptions, and the fresh code for on only", () => {
  const bad: [string, Record<string, unknown>, RegExp][] = [
    ["image_generate", { name: "x" }, /prompt/],
    ["image_generate", { prompt: "p", name: "../x" }, /name/],
    ["image_generate", { prompt: "p", name: "a.png" }, /name/],
    ["image_generate", { prompt: "p".repeat(4001), name: "a" }, /at most 4000/],
    ["image_generate", { prompt: "p", name: "a", model: "flux-kontext-dev" }, /Choose a model/],
    ["image_generate", { prompt: "p", name: "a", aspect_ratio: "5:1" }, /aspect ratio/],
    ["image_generate", { prompt: "p", name: "a", style_references: ["1", "2", "3", "4", "5"] }, /at most 4/],
    ["image_generate", { prompt: "p", name: "a", style_references: "a.png" }, /at most 4/],
    ["image_edit", { prompt: "p", name: "a" }, /image to edit/],
    ["image_wait", { prompt: "p", name: "a" }, /Unknown tool/],
  ];
  for (const [tool, args, error] of bad) assert.throws(() => parseImageCall(tool, args), (e: Error) => e instanceof ImageError && error.test(e.message), JSON.stringify(args));
  const plain = parseImageCall("image_generate", { prompt: " p ", name: "hero_1" });
  assert.deepEqual([plain.model.id, plain.prompt, plain.aspectRatio, plain.priceUsd], ["krea-2-turbo", "p", "1:1", 0.015]);
  assert.equal(parseImageCall("image_generate", { prompt: "p", name: "a", model: "krea-2-large", style_references: ["s.png"] }).priceUsd, 0.065);
  const edit = parseImageCall("image_edit", { prompt: "p", name: "a", source: "design/a.png" });
  assert.deepEqual([edit.model.id, edit.source, edit.priceUsd], ["flux-kontext-dev", "design/a.png", 0.02]);
  // Every model and its price is in a description; there is no wait tool.
  const described = IMAGE_TOOLS.map((t) => t.description).join("\n");
  for (const m of DESIGN_MODELS) assert.ok(described.includes(m.id) && described.includes(listPrice(m.prices.base)), m.id);
  assert.deepEqual(IMAGE_TOOLS.map((t) => t.name), ["image_generate", "image_edit"]);
  assert.equal(listPrice(0.015), "$0.015");
  assert.equal(needsFreshCode({ action: "setImageTools", projectId: "p", on: true }), true);
  assert.equal(needsFreshCode({ action: "setImageTools", projectId: "p", on: false }), false);
});

test("a job's polls leave no abort listener behind; an abort still ends the wait at once", async () => {
  const controller = new AbortController();
  for (let i = 0; i < 20; i++) await pause(1, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const waiting = pause(60_000, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  await waiting;
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("image tools are offered to Claude Code at Edit only, with the switch on and a capped Krea key; an MCP round trip lists them", async (t) => {
  const { h, lead } = await setup(t);
  const agent = h.store.agent(lead.id)!;
  const project = h.store.project(h.project.id)!;
  assert.equal(h.worker.imageToolsOffered(agent, project), true);
  assert.equal(h.worker.imageToolsOffered({ ...agent, permission: "look" }, project), false);
  assert.equal(h.worker.imageToolsOffered({ ...agent, kind: "codex" }, project), false);
  assert.equal(h.worker.imageToolsOffered({ ...agent, kind: "opencode" }, project), false);
  // Through the real MCP listener (handleMcp), as the session lists them.
  await h.ended(h.send(lead.id, "tools"));
  assert.match(h.said(lead.id).at(-1)!, /image_generate,image_edit,approve$/);
  // Switched off (no code needed): not offered.
  runCommand(h.store, { action: "setImageTools", projectId: h.project.id, on: false });
  await h.ended(h.send(lead.id, "tools"));
  assert.doesNotMatch(h.said(lead.id).at(-1)!, /image_/);
  // On again, but the Krea key has no cap, or there is none: not offered.
  runCommand(h.store, { action: "setImageTools", projectId: h.project.id, on: true });
  writeKeyFile(h.keysFile, keys(null));
  assert.equal(h.worker.imageToolsOffered(agent, h.store.project(h.project.id)), false);
  writeKeyFile(h.keysFile, { ...keys(), keys: { CLAUDE_CODE_OAUTH_TOKEN: { value: TOKEN } } });
  assert.equal(h.worker.imageToolsOffered(agent, h.store.project(h.project.id)), false);
});

test("a call is charged at submit, waits for its job and writes Krea's bytes as the agent into design/, committed with the turn", async (t) => {
  const { h, krea, lead, folder, runs } = await setup(t);
  await h.ended(h.send(lead.id, `call image_generate ${JSON.stringify(generate)}`));
  assert.match(h.said(lead.id).at(-1)!, /^image_generate: Wrote design\/hero\.png \(image\/png, 64×32, 1 KB\), charged \$0\.015\./);
  assert.deepEqual(readFileSync(join(folder, "design", "hero.png")), PNG);
  // design/ is made group-readable (0750, like the clone), so the worker
  // (the owner, in the agent's group) can check paths in it later.
  assert.equal(statSync(join(folder, "design")).mode & 0o777, 0o750);
  const turnId = h.store.get("SELECT turn_id FROM console_image_calls")!.turn_id as number;
  const [call] = h.store.imageCalls(turnId);
  assert.deepEqual([call.state, call.costUsd, call.priceUsd, call.jobId, call.path], ["done", 0.015, 0.015, "job-1", "design/hero"]);
  assert.equal(h.store.tabSpend(h.tab.id), 0.015);
  assert.ok(h.events(lead.id).some((e) => e.kind === "note" && /image_generate: Krea 2 Turbo, \$0\.015 charged/.test((e.body as { text: string }).text)));
  // The key goes only to Krea; the submit carries the prompt.
  assert.ok(krea.provider().every((c) => c.auth === `Bearer ${KREA}`));
  assert.equal(JSON.parse(krea.calls.find((c) => c.url.includes("/generate/"))!.body!).prompt, "a red cube");
  assert.ok(krea.calls.filter((c) => c.url.startsWith("https://gen.krea.ai/")).length === 1);
  // Written by the placing script, as the agent, into design/.
  assert.ok(runs.some((r) => r.cwd === folder && r.program === "/usr/bin/perl" && r.args.includes("design") && r.args.includes("hero.png")));
  await h.until(() => h.store.commits(lead.id).some((c) => c.files.includes("design/hero.png")), "committed");
  // The Overview counts it, against the Krea key's cap.
  const overview = overviewView(h.store, h.keysFile, Date.now());
  assert.equal(overview.spend.tabs[0].month, 0.015);
  assert.deepEqual(overview.spend.keys.map((k) => [k.name, k.month, k.capUsd]), [["KREA_API_KEY", 0.015, 10]]);
});

test("failed and cancelled jobs are refunded; Reset spend covers image calls", async (t) => {
  const { h, krea, folder, running, stop } = await setup(t);
  const { turnId, rt } = await running();
  krea.state.status = "failed";
  await assert.rejects(h.worker.imageCall(rt, "image_generate", generate), /job failed; the call was refunded/);
  krea.state.status = "cancelled";
  await assert.rejects(h.worker.imageCall(rt, "image_generate", generate), /cancelled the job; the call was refunded/);
  assert.deepEqual(h.store.imageCalls(turnId).map((c) => [c.state, c.costUsd]), [["failed", 0], ["cancelled", 0]]);
  assert.equal(h.store.tabSpend(h.tab.id), 0);
  assert.equal(existsSync(join(folder, "design")), false);
  krea.state.status = "completed";
  await h.worker.imageCall(rt, "image_generate", generate);
  assert.equal(h.store.tabSpend(h.tab.id), 0.015);
  runCommand(h.store, { action: "resetSpend", tabId: h.tab.id });
  assert.equal(h.store.tabSpend(h.tab.id), 0);
  await h.worker.imageCall(rt, "image_generate", { ...generate, model: "krea-2-medium" });
  assert.equal(h.store.tabSpend(h.tab.id), 0.03);
  await stop(turnId);
});

test("the per-turn cap and the tab's limit refuse a call with no provider call; two parallel calls against a limit that fits one", async (t) => {
  const { h, krea, running, stop } = await setup(t, { imageCallsPerTurn: 2, imageUsdPerTurn: 0.04 });
  const { turnId, rt } = await running();
  await h.worker.imageCall(rt, "image_generate", generate);
  const before = krea.calls.length;
  // $1 per turn (here $0.04): a Large call ($0.06) would pass it.
  await assert.rejects(h.worker.imageCall(rt, "image_generate", { ...generate, model: "krea-2-large" }), /past \$0\.04/);
  await h.worker.imageCall(rt, "image_generate", generate);
  const after = krea.calls.length;
  await assert.rejects(h.worker.imageCall(rt, "image_generate", generate), /made its 2 image calls/);
  assert.equal(krea.calls.length, after);
  assert.ok(after > before);
  await stop(turnId);
  // The tab's limit: spend $0.03 so far; a limit of $0.05 fits one more
  // $0.015 call, not two, however they race.
  h.store.setSpendLimit(h.tab.id, 0.05, true);
  const next = await running();
  const submits = krea.submits();
  const results = await Promise.allSettled([h.worker.imageCall(next.rt, "image_generate", generate), h.worker.imageCall(next.rt, "image_generate", { ...generate, name: "other" })]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.match(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /past its limit of \$0\.05/);
  assert.equal(krea.submits(), submits + 1);
  const quiet = krea.calls.length;
  await assert.rejects(h.worker.imageCall(next.rt, "image_generate", generate), /past its limit/);
  assert.equal(krea.calls.length, quiet);
  await stop(next.turnId);
});

test("Stop cancels the open job and refunds it; a call open at a restart stays charged and is never resubmitted", async (t) => {
  const { h, krea, lead, running, stop } = await setup(t);
  const { turnId, rt } = await running();
  krea.state.status = "processing";
  const pending = h.worker.imageCall(rt, "image_generate", generate);
  await h.until(() => h.store.imageCalls(turnId)[0]?.jobId === "job-1", "submitted");
  runCommand(h.store, { action: "stop", agentId: lead.id });
  await assert.rejects(pending, /The turn was stopped; the call was refunded/);
  assert.ok(krea.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/jobs/job-1")));
  assert.deepEqual(h.store.imageCalls(turnId).map((c) => [c.state, c.costUsd]), [["cancelled", 0]]);
  await h.ended(turnId);
  // A call an earlier worker left open (charged, its job unknown).
  const second = await running();
  const admitted = h.store.chargeImageCall(
    h.worker.epoch!,
    { turnId: second.turnId, agent: h.store.agent(lead.id)!, tool: "image_generate", model: "krea-2-turbo", label: "Krea 2 Turbo", priceUsd: 0.015, path: "design/x" },
    { calls: 8, turnUsd: 1 },
  );
  assert.ok("id" in admitted);
  await stop(second.turnId);
  await h.worker.stop();
  const calls = krea.calls.length;
  await h.newWorker().start();
  const [left] = h.store.imageCalls(second.turnId);
  assert.deepEqual([left.state, left.costUsd], ["interrupted", 0.015]);
  assert.match(left.message!, /stays charged and is not resubmitted/);
  assert.equal(h.store.tabSpend(h.tab.id), 0.015);
  assert.equal(krea.calls.length, calls);
});

test("paths: a linked design folder, another agent's claim, a path outside the step and a prompt with a credential are refused", async (t) => {
  const { h, krea, folder, running, stop } = await setup(t);
  const other = h.agent("Other");
  await h.ready(other.id);
  const elsewhere = h.store.agent(other.id)!.folder;
  const { turnId, rt } = await running();
  // design/ links out of the clone: refused before any charge.
  symlinkSync(elsewhere, join(folder, "design"));
  await assert.rejects(h.worker.imageCall(rt, "image_generate", generate), /design\/hero\.png: Writes outside this agent's own folder/);
  assert.equal(krea.calls.length, 0);
  // design/ links inside the clone: the agent's write refuses it (paid,
  // nothing written through the link).
  const inner = join(folder, "inner");
  mkdirSync(inner);
  rmSync(join(folder, "design"));
  symlinkSync(inner, join(folder, "design"));
  await assert.rejects(h.worker.imageCall(rt, "image_generate", generate), /design in this folder is not a plain folder.*charged \$0\.015/);
  assert.equal(existsSync(join(inner, "hero.png")), false);
  rmSync(join(folder, "design"));
  const calls = krea.calls.length;
  // Another agent's claim.
  h.store.run("INSERT INTO console_claims (tab_id, agent_id, pattern, note, created_at, expires_at) VALUES (?, ?, ?, '', ?, ?)", h.tab.id, other.id, "design/**", Date.now(), Date.now() + 60_000);
  await assert.rejects(h.worker.imageCall(rt, "image_generate", generate), /Other is editing design\/\*\*/);
  h.store.run("DELETE FROM console_claims");
  // A tab with steps: only the step's files.
  h.store.setTabSteps(h.tab.id, [{ name: "Draft", files: ["docs/*.md"] }]);
  await assert.rejects(h.worker.imageCall(rt, "image_generate", generate), /This step may change only: docs\/\*\.md/);
  h.store.setTabSteps(h.tab.id, [{ name: "Design", files: ["design/*"] }]);
  // A prompt holding a credential the Console handed out.
  await assert.rejects(h.worker.imageCall(rt, "image_generate", { ...generate, prompt: `logo ${TOKEN}` }), /holds a credential/);
  // A source that is not an image is refused before any charge.
  writeFileSync(join(folder, "notes.png"), "not an image");
  await assert.rejects(h.worker.imageCall(rt, "image_edit", { prompt: "p", name: "e", source: "notes.png" }), /notes\.png: not a PNG, JPEG or WebP image/);
  assert.equal(krea.calls.length, calls);
  // In the step, an edit with a real source goes through (uploaded first).
  writeFileSync(join(folder, "src.png"), PNG);
  assert.match(await h.worker.imageCall(rt, "image_edit", { prompt: "make it blue", name: "edited", source: "src.png" }), /Wrote design\/edited\.png/);
  const submit = JSON.parse(krea.calls.find((c) => c.url.includes("flux-1-kontext"))!.body!);
  assert.equal(submit.image_url, "https://gen.krea.ai/assets/in.png");
  // The edit keeps the source's 2:1 shape, scaled up to 1,024 px (else Kontext makes a square).
  assert.deepEqual([submit.width, submit.height], [1024, 512]);
  assert.deepEqual(editSize({ width: 1376, height: 768 }), { width: 1376, height: 768 });
  assert.deepEqual(editSize({ width: 4000, height: 1000 }), { width: 1568, height: 512 });
  // A source past the file panel's 3 MB (up to the 10 MB a call may write)
  // is still read for an edit.
  writeFileSync(join(folder, "big.png"), Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]));
  assert.match(await h.worker.imageCall(rt, "image_edit", { prompt: "smaller", name: "edited2", source: "big.png" }), /Wrote design\/edited2\.png/);
  await stop(turnId);
});

test("the Krea key never reaches an agent's environment and is redacted", async (t) => {
  const { h, lead, folder } = await setup(t);
  await h.ended(h.send(lead.id, "hello"));
  const names = JSON.parse(readFileSync(join(folder, "env.json"), "utf8")) as string[];
  assert.ok(!names.includes("KREA_API_KEY"));
  assert.ok(!h.log().includes(KREA));
  assert.ok(!h.worker.redactor.text(`key ${KREA}`).includes(KREA));
});

test("a Stop during the source read submits nothing; claims are checked again before writing; a completed job without an image stays charged; the stored tab limit applies", async (t) => {
  const { h, krea, lead, folder, running, stop, gate } = await setup(t);
  writeFileSync(join(folder, "src.png"), PNG);
  const first = await running();
  let release = () => {};
  gate.hold = new Promise<void>((r) => (release = r));
  const pending = h.worker.imageCall(first.rt, "image_edit", { prompt: "p", name: "e", source: "src.png" });
  await h.until(() => gate.hit, "reading the source");
  runCommand(h.store, { action: "stop", agentId: lead.id });
  await h.until(() => !!first.rt.turn?.stopping || first.rt.turn === null, "stopping");
  gate.hold = null;
  release();
  await assert.rejects(pending, /The turn was stopped/);
  assert.equal(krea.calls.length, 0);
  assert.deepEqual(h.store.imageCalls(first.turnId), []);
  assert.equal(existsSync(join(folder, "design", "e.png")), false);
  await h.ended(first.turnId);
  // A claim made while the job ran: the paid image is not written.
  const other = h.agent("Other");
  await h.ready(other.id);
  const second = await running();
  krea.state.status = "processing";
  const late = h.worker.imageCall(second.rt, "image_generate", generate);
  await h.until(() => !!h.store.imageCalls(second.turnId)[0]?.jobId, "submitted");
  h.store.run("INSERT INTO console_claims (tab_id, agent_id, pattern, note, created_at, expires_at) VALUES (?, ?, ?, '', ?, ?)", h.tab.id, other.id, "design/**", Date.now(), Date.now() + 60_000);
  krea.state.status = "completed";
  await assert.rejects(late, /Other is editing design\/\*\*.*nothing was written \(charged \$0\.015\)/);
  assert.equal(existsSync(join(folder, "design", "hero.png")), false);
  h.store.run("DELETE FROM console_claims");
  // Completed without a usable image: billed, so not refunded.
  krea.state.urls = false;
  await assert.rejects(h.worker.imageCall(second.rt, "image_generate", generate), /without an image.*charged \$0\.015/);
  krea.state.urls = true;
  assert.deepEqual(h.store.imageCalls(second.turnId).map((c) => [c.state, c.costUsd]), [["failed", 0.015], ["failed", 0.015]]);
  // The tab's own stored limit.
  h.store.setSpendLimit(h.tab.id, 0.04, true);
  const admitted = h.store.chargeImageCall(
    h.worker.epoch!,
    { turnId: second.turnId, agent: h.store.agent(lead.id)!, tool: "image_generate", model: "krea-2-turbo", label: "Krea 2 Turbo", priceUsd: 0.015, path: "design/x" },
    { calls: 8, turnUsd: 1 },
  );
  assert.deepEqual(admitted, { refused: "This call ($0.015) would take the tab's spend ($0.03) past its limit of $0.04. Ask the owner to raise it or reset spend." });
  // The Console-wide limit holds too, whatever the tab's own limit.
  h.store.setSpendLimit(h.tab.id, null, true);
  h.store.setConsoleSpendLimit(0.04, false);
  const overConsole = h.store.chargeImageCall(
    h.worker.epoch!,
    { turnId: second.turnId, agent: h.store.agent(lead.id)!, tool: "image_generate", model: "krea-2-turbo", label: "Krea 2 Turbo", priceUsd: 0.015, path: "design/x" },
    { calls: 8, turnUsd: 1 },
  );
  assert.deepEqual(overConsole, { refused: "This call ($0.015) would take the Console's spend this month ($0.03) past its limit of $0.04. Ask the owner to raise it or reset it on the Overview." });
  await stop(second.turnId);
});
