import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { ConsoleStore } from "../src/lib/console/store.ts";
import { healthBeat, healthSettings } from "../src/lib/shared/healthcheck.ts";
import { useSignedInEnv } from "./helpers/signed-in.ts";
import { harness } from "./helpers/console-harness.ts";

// the dead-man's switch on the Console worker. Its web check is
// `/api/console?health=1` on the internal Host; its write is a fenced lease
// renewal. Fake fetches; no request leaves the process.

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier.startsWith("@/") ? new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href : specifier,
      context,
    );
  },
});
const route = await import("../src/app/api/console/route.ts");
hooks.deregister();

const PING = "https://hc-ping.com/0000aaaa-bbbb-cccc-dddd-eeeeffff0000";
const WEB = "http://127.0.0.1:3011/api/console?health=1";

test("the heartbeat pings only when the web process can read and the worker can write", async () => {
  const pinged: string[] = [];
  const fetcher = (web: number | "down") =>
    (async (url: string) => {
      if (url.includes("health=1")) {
        if (web === "down") throw new Error("refused");
        return new Response(null, { status: web });
      }
      pinged.push(url);
      return new Response("OK", { status: 200 });
    }) as unknown as typeof fetch;
  const settings = { pingUrl: "https://hc-ping.com/uuid", webUrl: "http://127.0.0.1:3011/api/console?health=1" };
  const ok = () => {};
  const broken = () => {
    throw new Error("disk full");
  };
  assert.equal(await healthBeat(settings, ok, fetcher(200), 0), "ok");
  assert.equal(await healthBeat(settings, ok, fetcher(503), 0), "fail");
  assert.equal(await healthBeat(settings, ok, fetcher("down"), 0), "fail");
  assert.equal(await healthBeat(settings, broken, fetcher(200), 0), "fail");
  assert.deepEqual(pinged, [
    "https://hc-ping.com/uuid",
    "https://hc-ping.com/uuid/fail",
    "https://hc-ping.com/uuid/fail",
    "https://hc-ping.com/uuid/fail",
  ]);
  // A web server that is still starting gets one more look before /fail.
  let tries = 0;
  const starting = (async (url: string) => {
    if (url.includes("health=1")) return new Response(null, { status: tries++ === 0 ? 503 : 200 });
    pinged.push(url);
    return new Response("OK");
  }) as unknown as typeof fetch;
  assert.equal(await healthBeat(settings, ok, starting, 0), "ok");
  assert.equal(tries, 2);
});

test("a ping URL needs the web check, and both must be set by hand", () => {
  assert.equal(healthSettings({}), null);
  assert.throws(() => healthSettings({ CONSOLE_HEALTHCHECK_URL: "https://hc-ping.com/u" }), /needs CONSOLE_WEB_HEALTH_URL/);
  assert.deepEqual(
    healthSettings({ CONSOLE_HEALTHCHECK_URL: "https://hc-ping.com/u/", CONSOLE_WEB_HEALTH_URL: "http://127.0.0.1:3011/api/console?health=1" }),
    { pingUrl: "https://hc-ping.com/u", webUrl: "http://127.0.0.1:3011/api/console?health=1" },
  );
  assert.throws(() => healthSettings({ CONSOLE_HEALTHCHECK_URL: "http://hc-ping.com/u", CONSOLE_WEB_HEALTH_URL: "x" }), /https/);
});

test("the health check answers the internal Host with no data, and nothing else", async (t) => {
  const state = globalThis as typeof globalThis & { consoleStore?: ConsoleStore };
  const restore = useSignedInEnv();
  state.consoleStore = new ConsoleStore(":memory:");
  t.after(() => {
    state.consoleStore?.close();
    delete state.consoleStore;
    restore();
  });
  const ok = await route.GET(new Request(WEB, { headers: { host: "127.0.0.1:3011" } }));
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "");
  // Through the public address (any other Host), with or without the header.
  for (const headers of [{ host: "console.example" } as Record<string, string>, { host: "console.example", "x-workspace-request": "1" }, { host: "127.0.0.1:3000" }])
    assert.equal((await route.GET(new Request("https://console.example/api/console?health=1", { headers }))).status, 404);
  // A store the web process cannot read is reported, still with no data.
  state.consoleStore.close();
  const down = await route.GET(new Request(WEB, { headers: { host: "127.0.0.1:3011" } }));
  assert.equal(down.status, 503);
  state.consoleStore = new ConsoleStore(":memory:");
});

test("the Console worker beats: /fail once its lease is lost, and the ping URL is masked", async (t) => {
  const pinged: string[] = [];
  const lines: string[] = [];
  const healthFetch = (async (url: string) => {
    if (url === WEB) return new Response(null, { status: 200 });
    pinged.push(url);
    return new Response("OK");
  }) as unknown as typeof fetch;
  // The beat is driven by the test, not the timer.
  const h = await harness(t, {}, false, {
    options: { health: { pingUrl: PING, webUrl: WEB }, healthFetch, healthMs: 3_600_000, healthRetryMs: 0, log: (line: string) => lines.push(line) },
  });
  await h.worker.start();
  const before = h.store.lease()!.renewedAt;
  await h.worker.heartbeat();
  assert.deepEqual(pinged, [PING]);
  assert.ok(h.store.lease()!.renewedAt >= before);
  assert.equal(h.worker.redactor.text(`url=${PING}`).includes(PING), false);
  // Another worker took the lease: the write is refused, so /fail is sent.
  h.store.releaseLease(h.store.lease()!.epoch);
  h.store.takeLease("other", Date.now());
  await h.worker.heartbeat();
  assert.deepEqual(pinged, [PING, `${PING}/fail`]);
  assert.ok(lines.some((l) => l === "health check: failure signal sent"));
});
