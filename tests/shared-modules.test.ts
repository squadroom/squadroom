import assert from "node:assert/strict";
import { test } from "node:test";
import { designModel } from "../src/config/design-models.ts";
import { KreaClient, ProviderCallError, downloadOutput } from "../src/lib/shared/krea.ts";
import { idempotencyKey, nextAttemptDelay, sendWithResend, type MailSettings } from "../src/lib/shared/mail.ts";
import { handleMcp, type McpBackend } from "../src/lib/shared/mcp.ts";

// The shared modules the Console uses, tested on their own. Krea, Resend and the MCP client are
// fakes; no request leaves the process.


const mail: MailSettings = { apiKey: "re_test", from: "Console <console@example.com>", to: "owner@example.com", origin: null };

test("Resend: one POST with the key, JSON body and the same idempotency key; only transient errors are retryable", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let status = 200;
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(status === 200 ? '{"id":"x"}' : '{"message":"secret detail"}', { status });
  }) as unknown as typeof fetch;
  const email = { subject: "Subject", text: "Text", html: "<p>Text</p>" };
  assert.deepEqual(await sendWithResend(mail, "signin_locked:1", email, fetcher), { ok: true });
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer re_test");
  assert.equal(headers["Idempotency-Key"], idempotencyKey("signin_locked:1"));
  assert.ok(headers["Idempotency-Key"].length <= 256);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    from: mail.from,
    to: [mail.to],
    subject: email.subject,
    text: email.text,
    html: email.html,
  });
  for (const [code, retryable] of [[409, true], [429, true], [500, true], [503, true], [401, false], [422, false]] as const) {
    status = code;
    assert.deepEqual(await sendWithResend(mail, "k", email, fetcher), { ok: false, retryable, status: code });
  }
  const offline = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  assert.deepEqual(await sendWithResend(mail, "k", email, offline), { ok: false, retryable: true, status: null });
  assert.deepEqual([nextAttemptDelay(1), nextAttemptDelay(2), nextAttemptDelay(3), nextAttemptDelay(12)], [60_000, 120_000, 240_000, 3_600_000]);
});

test("the Krea adapter sends one job per request with the server key, and maps job states", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const replies: Response[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return replies.shift()!;
  }) as unknown as typeof fetch;
  const krea = new KreaClient("sk-test", fetcher);
  replies.push(Response.json({ job_id: "4f0a2c7e-1111-4222-8333-444455556666", status: "queued" }));
  const id = await krea.submit(designModel("krea-2-medium")!, { prompt: "p", aspectRatio: "4:3", seed: 7, referenceUrls: ["https://gen.krea.ai/r.png"] });
  assert.equal(id, "4f0a2c7e-1111-4222-8333-444455556666");
  assert.equal(seen[0].url, "https://api.krea.ai/generate/image/krea/krea-2/medium");
  assert.equal((seen[0].init.headers as Record<string, string>).authorization, "Bearer sk-test");
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), {
    prompt: "p",
    aspect_ratio: "4:3",
    resolution: "1K",
    seed: 7,
    image_style_references: [{ url: "https://gen.krea.ai/r.png", strength: 0.5 }],
  });
  replies.push(Response.json({ job_id: id, status: "sampling" }));
  assert.equal((await krea.job(id)).status, "pending");
  replies.push(Response.json({ job_id: id, status: "completed", result: { urls: ["https://gen.krea.ai/images/a.png"] } }));
  assert.deepEqual(await krea.job(id), { status: "completed", urls: ["https://gen.krea.ai/images/a.png"] });
  replies.push(Response.json({ job_id: id, status: "failed", error: { code: "nsfw_content" } }));
  assert.equal((await krea.job(id)).error, "content_filtered");
  replies.push(new Response(null, { status: 200 }));
  assert.equal(await krea.cancel(id), true);
  assert.equal(seen.at(-1)!.init.method, "DELETE");
  // A refused request creates no job; a lost response may have.
  replies.push(new Response("{}", { status: 402 }));
  await assert.rejects(krea.submit(designModel("krea-2-turbo")!, { prompt: "p", aspectRatio: "1:1", referenceUrls: [] }), (e: ProviderCallError) => e.kind === "provider_unavailable" && !e.billable);
  replies.push(new Response("{}", { status: 503 }));
  await assert.rejects(krea.submit(designModel("krea-2-turbo")!, { prompt: "p", aspectRatio: "1:1", referenceUrls: [] }), (e: ProviderCallError) => e.billable);
});

test("outputs download over HTTPS only from the listed hosts, with no redirect elsewhere, within the size limit", async () => {
  const hosts = ["gen.krea.ai"];
  const signal = new AbortController().signal;
  const calls: string[] = [];
  const serve = (routes: Record<string, () => Response>) =>
    (async (url: string) => {
      calls.push(url);
      return routes[url]();
    }) as unknown as typeof fetch;
  const image = new Uint8Array(64).fill(7);
  const ok = serve({ "https://gen.krea.ai/a.png": () => new Response(image) });
  assert.equal((await downloadOutput(ok, hosts, "https://gen.krea.ai/a.png", signal)).length, image.length);
  for (const url of ["http://gen.krea.ai/a.png", "https://evil.example/a.png", "https://gen.krea.ai:8443/a.png", "https://user@gen.krea.ai/a.png"])
    await assert.rejects(downloadOutput(ok, hosts, url, signal), ProviderCallError);
  const redirect = serve({
    "https://gen.krea.ai/r.png": () => new Response(null, { status: 302, headers: { location: "https://evil.example/x.png" } }),
    "https://gen.krea.ai/s.png": () => new Response(null, { status: 302, headers: { location: "/a.png" } }),
    "https://gen.krea.ai/a.png": () => new Response(image),
  });
  calls.length = 0;
  await assert.rejects(downloadOutput(redirect, hosts, "https://gen.krea.ai/r.png", signal), ProviderCallError);
  assert.deepEqual(calls, ["https://gen.krea.ai/r.png"], "the other host is never requested");
  assert.equal((await downloadOutput(redirect, hosts, "https://gen.krea.ai/s.png", signal)).length, image.length);
  const big = serve({ "https://gen.krea.ai/b.png": () => new Response(new Uint8Array(2048)) });
  await assert.rejects(downloadOutput(big, hosts, "https://gen.krea.ai/b.png", signal, 1024), /output_too_large/);
});

test("the MCP transport answers only its own loopback host, a live token and POST", async () => {
  const calls: string[] = [];
  const backend: McpBackend = {
    authorized: (token) => token === "t".repeat(43),
    tools: () => [{ name: "list_design_models", inputSchema: { type: "object" } }],
    call: async (_token, name) => {
      calls.push(name);
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  const host = "127.0.0.1:4555";
  const auth = { host, authorization: `Bearer ${"t".repeat(43)}` };
  const post = (body: unknown, headers: Record<string, string | undefined> = auth, method = "POST", path = "/mcp") =>
    handleMcp({ method, path, headers, body: JSON.stringify(body) }, backend, host, { name: "console", version: "1.0.0" });
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } });
  assert.equal(init.status, 200);
  assert.deepEqual(JSON.parse(init.body!).result.protocolVersion, "2025-06-18");
  const unknownVersion = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(JSON.parse(unknownVersion.body!).result.protocolVersion, "2025-06-18");
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  assert.equal(JSON.parse((await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).body!).result.tools.length, 1);
  assert.equal(JSON.parse((await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_design_models", arguments: {} } })).body!).result.content[0].text, "ok");
  assert.equal(JSON.parse((await post({ jsonrpc: "2.0", id: 4, method: "resources/list" })).body!).error.code, -32601);
  // Refusals: no token, another Host (DNS rebinding), a browser Origin, GET.
  assert.equal((await post({ jsonrpc: "2.0", id: 5, method: "tools/list" }, { host })).status, 401);
  assert.equal((await post({ jsonrpc: "2.0", id: 5, method: "tools/list" }, { ...auth, host: "evil.example:4555" })).status, 403);
  assert.equal((await post({ jsonrpc: "2.0", id: 5, method: "tools/list" }, { ...auth, origin: "https://evil.example" })).status, 403);
  assert.equal((await post({}, auth, "GET")).status, 405);
  // A tool call after the turn ended is a tool error from the backend, not an auth challenge.
  const ended = await post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "generate_image", arguments: {} } }, { host, authorization: `Bearer ${"e".repeat(43)}` });
  assert.equal(ended.status, 200);
  assert.deepEqual(calls, ["list_design_models", "generate_image"]);
});
