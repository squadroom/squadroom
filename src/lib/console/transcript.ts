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

/** An ACP tool call's row title. A known kind keeps the client's title as
 * its summary; an unknown kind or "other" shows the client's own tool name
 * ("list_dir" becomes "List dir") instead of the word "other". */
export function acpToolLabel(kind: string, title: string): { name: string; summary: string } {
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
