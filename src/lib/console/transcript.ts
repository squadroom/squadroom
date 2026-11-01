import type { ConsoleEvent, TurnStatus } from "./types.ts";

// A window's transcript from its stored events: owner messages, the
// agent's text (coalesced rows joined back together), thinking collapsed,
// one-line tool rows with their output, refused permissions, and how a turn
// ended when it did not simply finish. Browser-safe and pure.

// ACP tool kinds (ACP's ToolKind), as the window shows them. Not "Read" or
// "Edit": those names make `toolPaths` treat the summary as file paths.
const ACP_TOOL_LABELS: Record<string, string> = {
  read: "Read file",
  edit: "Edit file",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run command",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Switch mode",
};

// The Console's own team tools, as each client names them: Claude Code
// "mcp__console__team_send", Codex "console:team_send", some ACP clients
// "console__team_send". The summary is the call's arguments as JSON,
// possibly cut short ("…").
const TEAM_TOOL = /^(?:mcp__console__|console:|console__)(team_[a-z_]+)$/;

/** The call's arguments from a summary, also when it was cut short. */
function teamArgs(summary: string): Record<string, unknown> | null {
  const cut = summary.endsWith("…");
  const text = cut ? summary.slice(0, -1) : summary;
  if (!text.startsWith("{")) return null;
  for (const end of cut ? ['"}', '"]}', "]}", "}"] : [""]) {
    try {
      const v: unknown = JSON.parse(text + end);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if (!cut) return v as Record<string, unknown>;
        // The last string field read is the one that was cut.
        const out = { ...(v as Record<string, unknown>) };
        const last = Object.keys(out).at(-1);
        if (last && typeof out[last] === "string") out[last] += "…";
        return out;
      }
    } catch {
      // Try the next way to close it.
    }
  }
  return null;
}

/** A team tool call's readable row ("Message to Backend" and the message),
 * or null for any other tool. */
export function teamToolLabel(name: string, summary: string): { name: string; summary: string } | null {
  const tool = TEAM_TOOL.exec(name)?.[1];
  if (!tool) return null;
  const args = teamArgs(summary);
  // Claude Code's summary is a plain path for team_diff (it picks `path`).
  const plain = args ? "" : summary;
  const str = (key: string) => (args && typeof args[key] === "string" ? (args[key] as string) : "");
  const who = (key: string, none: string) => str(key) || none;
  const list = (key: string) => (args && Array.isArray(args[key]) ? (args[key] as unknown[]).map(String).join(", ") : "");
  switch (tool) {
    case "team_list":
      return { name: "List the team", summary: "" };
    case "team_send":
      return { name: `Message to ${who("to", "a teammate")}`, summary: str("message") || plain };
    case "team_ask":
      return { name: `Question to ${who("to", "a teammate")}`, summary: str("message") || plain };
    case "team_reply":
      return { name: "Answer to an ask", summary: str("message") || plain };
    case "team_report":
      return { name: "Note for you (Needs you)", summary: str("message") || plain };
    case "team_pull":
      return { name: `Pull ${who("from", "a teammate")}'s work`, summary: plain };
    case "team_pull_abort":
      return { name: "Abandon the pull", summary: "" };
    case "team_claim":
      return { name: "Claim paths", summary: [list("paths"), str("note")].filter(Boolean).join(" — ") || plain };
    case "team_release":
      return { name: "Release claims", summary: list("paths") || plain };
    case "team_hold":
      return { name: `Hold ${who("to", "a teammate")}`, summary: str("reason") || plain };
    case "team_resume":
      return { name: `Resume ${who("to", "a teammate")}`, summary: "" };
    case "team_push":
      return { name: "Push and open a pull request", summary: str("title") || plain };
    case "team_pr":
      return { name: "Read the pull request", summary: "" };
    case "team_pr_reply":
      return { name: "Reply on the pull request", summary: str("message") || plain };
    case "team_read":
      return { name: "Read the rest of a message", summary: "" };
    case "team_diff":
      return { name: `Read ${args ? who("from", "a teammate") : "a teammate"}'s changes`, summary: str("path") || plain };
    default:
      return { name: tool.slice(5).replace(/_/g, " ").replace(/^./, (c) => `Team ${c}`), summary: plain };
  }
}

/** An ACP tool call's row title. A known kind keeps the client's title as
 * its summary; an unknown kind or "other" shows the client's own tool name
 * ("list_dir" becomes "List dir") instead of the word "other". */
export function acpToolLabel(kind: string, title: string): { name: string; summary: string } {
  const team = teamToolLabel(title, "");
  if (team) return team;
  const label = ACP_TOOL_LABELS[kind];
  if (label) return { name: label, summary: title === kind ? "" : title };
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(title)) {
    const words = title.replace(/[_-]+/g, " ").trim();
    return { name: words.charAt(0).toUpperCase() + words.slice(1), summary: "" };
  }
  return { name: "Tool", summary: title };
}

export type Block =
  | { type: "owner"; key: string; text: string; edited?: boolean }
  | { type: "text"; key: string; text: string }
  | { type: "thinking"; key: string; text: string }
  | { type: "tool"; key: string; name: string; summary: string; output: string | null; error: boolean }
  | { type: "permission"; key: string; tool: string; decision: "allow" | "deny" | "ask"; reason: string }
  | { type: "status"; key: string; status: TurnStatus; reason: string | null }
  | { type: "error"; key: string; text: string }
  | { type: "upload"; key: string; name: string; path: string; size: number }
  | { type: "team"; key: string; messages: { from: string; kind: string; correlationId: string | null; text: string }[] }
  | { type: "push"; key: string; text: string; url: string | null }
  | { type: "note"; key: string; text: string };

/** Statuses worth a line in the transcript (the pill shows the rest). */
const SHOWN: TurnStatus[] = ["stopped", "interrupted", "failed"];

export function transcript(events: ConsoleEvent[]): Block[] {
  const blocks: Block[] = [];
  const tools = new Map<string, Extract<Block, { type: "tool" }>>();
  // A queued message's latest text, and the deleted ones: the
  // events are append-only, so revisions come later in the stream.
  const revised = new Map<number, string>();
  const withdrawn = new Set<number>();
  for (const e of events) {
    if (e.kind === "revised") revised.set(e.turnId, String((e.body as { text?: unknown }).text ?? ""));
    else if (e.kind === "withdrawn") withdrawn.add(e.turnId);
  }
  // The turn each block came from: streamed text joins the last block only
  // when that block is the same turn's. (Comparing with the last event's
  // turn joined a queued turn's reply onto the previous reply, because its
  // "running" status event, which draws no block, came in between.)
  const blockTurn = new WeakMap<Block, number>();
  for (const e of events) {
    // Never interleaved with the running turn's own rows.
    if (e.kind === "revised" || e.kind === "withdrawn") continue;
    if (e.kind === "owner" && withdrawn.has(e.turnId)) continue;
    const body = e.body as Record<string, unknown>;
    const last = blocks.at(-1);
    const key = String(e.id);
    const sameTurn = !!last && blockTurn.get(last) === e.turnId;
    const before = blocks.length;
    switch (e.kind) {
      case "owner": {
        const latest = revised.get(e.turnId);
        blocks.push(latest === undefined ? { type: "owner", key, text: String(body.text ?? "") } : { type: "owner", key, text: latest, edited: true });
        break;
      }
      case "text":
      case "thinking":
        if (sameTurn && last?.type === e.kind) last.text += String(body.text ?? "");
        else blocks.push({ type: e.kind, key, text: String(body.text ?? "") });
        break;
      case "tool": {
        let name = String(body.name ?? "tool");
        let summary = String(body.summary ?? "");
        // Rows stored before readable ACP names carry the bare kind "other".
        if (name === "other") ({ name, summary } = acpToolLabel(name, summary));
        else ({ name, summary } = teamToolLabel(name, summary) ?? { name, summary });
        const block = { type: "tool" as const, key, name, summary, output: null, error: false };
        tools.set(`${e.turnId}:${String(body.id ?? "")}`, block);
        blocks.push(block);
        break;
      }
      case "tool_result": {
        const tool = tools.get(`${e.turnId}:${String(body.id ?? "")}`);
        if (tool) {
          tool.output = String(body.text ?? "");
          tool.error = body.error === true;
        } else blocks.push({ type: "tool", key, name: "Result", summary: "", output: String(body.text ?? ""), error: body.error === true });
        break;
      }
      case "permission":
        // Allowed actions show as their tool rows; refusals, owner requests
        // and the owner's own approvals get a line.
        if (body.decision === "allow" && !/owner/.test(String(body.reason ?? ""))) break;
        blocks.push({
          type: "permission",
          key,
          tool: String(body.tool ?? ""),
          decision: body.decision === "allow" ? "allow" : body.decision === "ask" ? "ask" : "deny",
          reason: String(body.reason ?? ""),
        });
        break;
      case "status":
        if (SHOWN.includes(body.status as TurnStatus))
          blocks.push({ type: "status", key, status: body.status as TurnStatus, reason: (body.reason as string | null) ?? null });
        break;
      case "error":
        blocks.push({ type: "error", key, text: String(body.text ?? "") });
        break;
      case "upload":
        blocks.push({ type: "upload", key, name: String(body.name ?? ""), path: String(body.path ?? ""), size: Number(body.size ?? 0) });
        break;
      case "team": {
        // Messages from teammates, delivered together as one turn.
        const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
        blocks.push({
          type: "team",
          key,
          messages: messages.map((m) => ({
            from: String(m.from ?? ""),
            kind: String(m.kind ?? "send"),
            correlationId: typeof m.correlationId === "string" ? m.correlationId : null,
            text: String(m.text ?? ""),
          })),
        });
        break;
      }
      case "push":
        blocks.push({ type: "push", key, text: String(body.text ?? ""), url: typeof body.url === "string" ? body.url : null });
        break;
      case "note":
        blocks.push({ type: "note", key, text: String(body.text ?? "") });
        break;
    }
    for (let i = before; i < blocks.length; i++) blockTurn.set(blocks[i], e.turnId);
  }
  return blocks;
}

/** The window grid's shape: 1 fills, 2 side by side, 3 one large
 * and two stacked, 4 a 2×2, more scroll in rows of two. */
export function gridShape(count: number): "one" | "two" | "three" | "four" | "many" {
  return count <= 1 ? "one" : count === 2 ? "two" : count === 3 ? "three" : count === 4 ? "four" : "many";
}
