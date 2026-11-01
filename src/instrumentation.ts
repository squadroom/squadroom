// Startup check: the server refuses to start with an incomplete
// configuration. The proxy, the routes and the page also refuse per request
// (fail closed).
export async function register() {
  // Next.js replaces this literal per runtime, so it stays inline (the one
  // `process.env` read outside src/config/server-env.ts).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { serverSettings } = await import("./config/server-env");
  serverSettings();
}
