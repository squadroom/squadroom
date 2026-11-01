import { setting } from "../../config/server-env.ts";

// Dead-man's switch, run by the Console worker. The server cannot report
// its own outage, so the worker pings Healthchecks.io every 5 minutes, and
// only when the whole app works: the web process can read the Console's
// store and the worker can write it. Otherwise it sends the check's
// failure signal at once. When the worker itself is down the pings stop,
// and Healthchecks.io emails the owner.

export interface HealthSettings {
  /** The check's ping URL (https://hc-ping.com/<uuid>): a worker-only secret. */
  pingUrl: string;
  /** The web process's health endpoint. Required: a heartbeat that did not
   * check the web process would report a whole-app health it never saw. */
  webUrl: string;
}

export function healthSettings(env: Record<string, string | undefined>): HealthSettings | null {
  const ping = setting(env, "CONSOLE_HEALTHCHECK_URL")?.trim();
  if (!ping) return null;
  if (new URL(ping).protocol !== "https:")
    throw new Error("CONSOLE_HEALTHCHECK_URL must be an https URL.");
  const web = setting(env, "CONSOLE_WEB_HEALTH_URL")?.trim();
  if (!web)
    throw new Error(
      "CONSOLE_HEALTHCHECK_URL needs CONSOLE_WEB_HEALTH_URL (the web server's http://127.0.0.1:<port>/api/console?health=1).",
    );
  return { pingUrl: ping.replace(/\/$/, ""), webUrl: web };
}

async function webReads(settings: HealthSettings, fetcher: typeof fetch) {
  try {
    const response = await fetcher(settings.webUrl, {
      headers: { "x-workspace-request": "1" },
      signal: AbortSignal.timeout(10_000),
    });
    // Dispose of the body so the connection is released.
    await response.body?.cancel().catch(() => {});
    return response.status === 200;
  } catch {
    return false;
  }
}

/** One heartbeat. Returns which signal was sent; the ping URL is never logged.
 * A failed web check is retried once after `retryMs`, so a web server that is
 * starting or reloading does not raise an outage alert. */
export async function healthBeat(
  settings: HealthSettings,
  probeWrite: () => void,
  fetcher: typeof fetch = fetch,
  retryMs = 10_000,
): Promise<"ok" | "fail" | "unsent"> {
  let healthy = await webReads(settings, fetcher);
  if (!healthy) {
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    healthy = await webReads(settings, fetcher);
  }
  try {
    probeWrite();
  } catch {
    healthy = false;
  }
  try {
    const response = await fetcher(healthy ? settings.pingUrl : `${settings.pingUrl}/fail`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel().catch(() => {});
    return response.ok ? (healthy ? "ok" : "fail") : "unsent";
  } catch {
    return "unsent";
  }
}
