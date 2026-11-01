import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

// The MCP transport of the Console's tools: MCP over Streamable HTTP, on a
// loopback listener with an OS-assigned port, in the process that runs
// turns. A minimal hand-written JSON-RPC server: POST only, JSON responses,
// no server-sent events, no sessions, tools only.

/** A tool call's result, as MCP's `tools/call` returns it. */
export interface ToolContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 256 * 1024;
/** The name a server reports. */
export interface ServerInfo {
  name: string;
  version: string;
}

export interface McpBackend {
  /** A token that opens a session for this turn. */
  authorized(token: string): boolean;
  /** The tools offered on this token's session (each agent sees only the
   * ones it may use). */
  tools(token: string): unknown[];
  call(token: string, name: string, args: unknown): Promise<ToolResult>;
}
export interface McpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}
export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

const json = (status: number, value: unknown, headers: Record<string, string> = {}): McpResponse => ({
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  body: JSON.stringify(value),
});
type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** One HTTP request. `host` is the listener's own `127.0.0.1:<port>`: any
 * other Host header (DNS rebinding) and any browser Origin are refused. */
export async function handleMcp(
  request: McpRequest,
  backend: McpBackend,
  host: string,
  info: ServerInfo,
): Promise<McpResponse> {
  if (request.path !== "/mcp") return json(404, { error: "not_found" });
  const port = host.split(":")[1];
  if (request.headers.host !== host && request.headers.host !== `localhost:${port}`)
    return json(403, { error: "forbidden" });
  if (request.headers.origin) return json(403, { error: "forbidden" });
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "POST" });
  const token = /^Bearer ([\w-]{20,200})$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body);
  } catch {
    return json(400, rpcError(null, -32700, "Parse error"));
  }
  const messages = (Array.isArray(parsed) ? parsed : [parsed]) as Message[];
  // A tool call after the turn ended gets a tool error (below); everything
  // else needs a live token.
  const onlyCalls = messages.every((m) => m?.method === "tools/call" || m?.id === undefined);
  if (!backend.authorized(token) && !(token && onlyCalls)) return json(401, { error: "invalid_token" });
  const responses = [];
  for (const message of messages) {
    const response = await handleMessage(message, backend, token, info);
    if (response) responses.push(response);
  }
  if (!responses.length) return { status: 202, headers: {} };
  return json(200, Array.isArray(parsed) ? responses : responses[0]);
}

async function handleMessage(message: Message, backend: McpBackend, token: string, info: ServerInfo) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string")
    return rpcError(message?.id, -32600, "Invalid Request");
  if (message.id === undefined) return null; // A notification.
  const params = (message.params ?? {}) as Record<string, unknown>;
  switch (message.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: typeof asked === "string" && MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: info,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id: message.id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id: message.id, result: { tools: backend.tools(token) } };
    case "tools/call": {
      if (typeof params.name !== "string") return rpcError(message.id, -32602, "Invalid params");
      const result = await backend.call(token, params.name, params.arguments ?? {});
      return { jsonrpc: "2.0", id: message.id, result };
    }
    default:
      return rpcError(message.id, -32601, "Method not found");
  }
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        resolve(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
  });
}

/** The loopback listener. Not a Next.js route, so neither a public proxy
 * nor the web service reaches it. */
export async function startMcpServer(
  backend: McpBackend,
  info: ServerInfo,
  /** 0: no limit (the Console's permission prompts may wait for the owner). */
  options: { requestTimeoutMs?: number } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  let host = "";
  const server = createServer(async (request, response) => {
    const body = request.method === "POST" ? await readBody(request) : "";
    if (body === null) {
      response.writeHead(413).end();
      return;
    }
    let result: McpResponse;
    try {
      result = await handleMcp(
        {
          method: request.method ?? "",
          path: (request.url ?? "").split("?")[0],
          headers: {
            host: request.headers.host,
            origin: request.headers.origin,
            authorization: request.headers.authorization,
          },
          body,
        },
        backend,
        host,
        info,
      );
    } catch {
      result = json(500, { error: "internal" });
    }
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = options.requestTimeoutMs ?? 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${port}`;
  return {
    url: `http://${host}/mcp`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
