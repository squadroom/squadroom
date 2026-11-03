import type { NextConfig } from "next";
import { SECURED_PATHS, securityHeaders } from "./src/lib/security/csp";
import { TRACE_EXCLUDES } from "./src/config/build-trace";
import { setting } from "./src/config/server-env";

// Squadroom is reached at your https address (SERVER_PUBLIC_ORIGIN). The
// development server refuses its own resources to any other origin unless
// that host is listed here, which leaves pages without JavaScript (buttons do
// nothing).
const publicHost = (() => {
  try {
    const origin = setting(process.env, "SERVER_PUBLIC_ORIGIN");
    return origin ? new URL(origin).hostname : null;
  } catch {
    return null;
  }
})();

const nextConfig: NextConfig = {
  ...(publicHost ? { allowedDevOrigins: [publicHost] } : {}),
  // The server file trace keeps to what the routes load: never the
  // repository's Git data, docs, tests or scripts.
  // scripts/check-build-trace.ts checks the result after every build.
  outputFileTracingExcludes: {
    "/*": TRACE_EXCLUDES,
  },
  // No image optimizer: the pages use none, and it would decode images for
  // anyone, signed in or not (src/proxy.ts also answers its path with 404).
  images: { unoptimized: true },
  poweredByHeader: false,
  // Every page: a Content-Security-Policy that keeps the browser to the
  // page's own origin, and no referrer (src/lib/security/csp.ts says why
  // each directive is as it is).
  async headers() {
    const headers = securityHeaders(process.env.NODE_ENV !== "production");
    return SECURED_PATHS.map((source) => ({ source, headers }));
  },
};

export default nextConfig;
