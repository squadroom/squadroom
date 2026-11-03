import { isOpen, type ConsoleAgent, type TurnStatus } from "../types.ts";
import type { ConsoleStore } from "../store.ts";
import { circlePair, continuation, READ_PAGE, SHARE_MAX, TeamError, type TeamMessage } from "../team.ts";
import { MESSAGES, newId, safeCut, teamMessage, type Row } from "./rows.ts";

type Named = TeamMessage & { fromName: string; toName: string };
type Route = { id: number; from: string; fromName: string; to: string; toName: string; phrase: string };

// The mailbox: team messages, asks and their answers, routes, and the
// instruction limits and circle detector.
export const mailbox = {
  /** team_send and team_ask: the message and the call's record commit
   * together, so a repeated call (same turn, same call) returns the first
   * result instead of sending twice. */
  sendTeamMessage(
    this: ConsoleStore,
    epoch: number,
    m: { turnId: number; from: ConsoleAgent; to: ConsoleAgent; kind: "send" | "ask"; body: string; key: string; summary: string },
  ): string {
    const tool = m.kind === "ask" ? "team_ask" : "team_send";
    return this.callOnce(epoch, { turnId: m.turnId, agentId: m.from.id, key: m.key, tool, summary: m.summary }, () => {
      const t = this.turn(m.turnId);
      if (!t) throw new TeamError("This turn has ended.");
      // Read again here: the owner may have closed it meanwhile.
      if (!isOpen(this.agent(m.to.id))) throw new TeamError(`${m.to.name} can no longer take messages.`);
      const correlationId = m.kind === "ask" ? newId("c") : null;
      this.run(
        "INSERT INTO console_messages (tab_id, from_agent, to_agent, kind, correlation_id, body, state, from_turn, instruction_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
        m.from.tabId, m.from.id, m.to.id, m.kind, correlationId, m.body, m.turnId, t.instructionId, this.now(),
      );
      this.chargePayload(m.turnId, Buffer.byteLength(m.body, "utf8"));
      return m.kind === "ask"
        ? `Asked ${m.to.name} (correlation id ${correlationId}). Do not wait for it: end your turn, and the answer arrives as your next message.`
        : `Sent to ${m.to.name}.`;
    });
  },
  /** team_reply: answers one ask delivered to this agent in this turn,
   * exactly once. */
  replyTeamMessage(this: ConsoleStore, epoch: number, r: { turnId: number; from: ConsoleAgent; correlationId: string; body: string; key: string; summary: string }): string {
    return this.callOnce(epoch, { turnId: r.turnId, agentId: r.from.id, key: r.key, tool: "team_reply", summary: r.summary }, () => {
      const ask = this.get(`${MESSAGES} WHERE m.kind = 'ask' AND m.correlation_id = ?`, r.correlationId);
      if (!ask || ask.to_agent !== r.from.id) throw new TeamError("No ask with that correlation id was given to you.");
      if (ask.state === "answered") throw new TeamError("That ask is already answered.");
      if (ask.state !== "in_turn" || ask.turn_id !== r.turnId) throw new TeamError("That ask is not part of this turn.");
      this.answer(ask, r.body, this.now(), false);
      this.chargePayload(r.turnId, Buffer.byteLength(r.body, "utf8"));
      return `Answered ${(ask.from_name as string | null) ?? "the asker"}.`;
    });
  },
  /** Mark an ask answered and queue the answer to its asker. `shared`: the
   * body is the turn's final message, carried in part. */
  answer(this: ConsoleStore, ask: Row, body: string, now: number, shared: boolean) {
    this.run("UPDATE console_messages SET state = 'answered', ended_at = ? WHERE id = ?", now, ask.id as number);
    const id = this.insert(
      "INSERT INTO console_messages (tab_id, from_agent, to_agent, kind, correlation_id, body, state, from_turn, instruction_id, created_at) VALUES (?, ?, ?, 'reply', ?, ?, 'queued', ?, ?, ?)",
      ask.tab_id as string, ask.to_agent as string, ask.from_agent as string, ask.correlation_id as string,
      shared ? body.slice(0, safeCut(body, SHARE_MAX)) : body, ask.turn_id as number, ask.instruction_id as number | null, now,
    );
    if (shared) this.passOn(ask.turn_id as number, id, body);
  },
  /** A message the Console made from a finishing turn's final message (a
   * route, an automatic answer). Longer than SHARE_MAX, it is carried only
   * in part, and says how its recipient reads the rest. It counts toward
   * that turn's bound too. Past the bound it is not refused, which would
   * lose the turn's end: its text becomes a short notice, the recipient
   * told why. */
  passOn(this: ConsoleStore, turnId: number, messageId: number, full: string) {
    if (full.length > SHARE_MAX) {
      const cut = safeCut(full, SHARE_MAX);
      this.run("UPDATE console_messages SET body = ?, shared = 1 WHERE id = ?", full.slice(0, cut) + continuation(messageId, full.length - cut, cut), messageId);
    }
    const body = this.get("SELECT body FROM console_messages WHERE id = ?", messageId)!.body as string;
    const used = this.turnBytes(turnId);
    let bytes = Buffer.byteLength(body, "utf8");
    if (used + bytes > this.turnBytesLimit) {
      const notice = "(This turn reached its storage limit, so its final message is not passed on. Ask its agent for what you need.)";
      this.run("UPDATE console_messages SET body = ?, shared = 0 WHERE id = ?", notice, messageId);
      // The notice is counted only as far as room is left: the bound holds.
      bytes = Math.max(0, Math.min(Buffer.byteLength(notice, "utf8"), this.turnBytesLimit - used));
    }
    this.addBytes(turnId, bytes);
  },
  /** team_read: more of a shortened message, for its recipient only. Any
   * other message id is unknown to it (ids run across every tab). */
  readMessage(this: ConsoleStore, agentId: string, messageId: number, offset: number): string | null {
    const text = this.get(
      "SELECT m.id, t.final_text FROM console_messages m JOIN console_turns t ON t.id = m.from_turn WHERE m.id = ? AND m.to_agent = ? AND m.kind IN ('route', 'reply') AND m.shared = 1",
      messageId, agentId,
    )?.final_text as string | null | undefined;
    if (!text || text.length <= SHARE_MAX) return null;
    const start = Math.max(0, Math.min(offset, text.length));
    const end = safeCut(text, start + READ_PAGE);
    return text.slice(start, end) + (end < text.length ? continuation(messageId, text.length - end, end) : "\n\n[End of the message.]");
  },
  /** A turn's delivered messages settle with it: done (each ask still
   * unanswered is answered by the final message), or interrupted. */
  settle(this: ConsoleStore, turnId: number, status: TurnStatus, finalText: string | null, now: number) {
    for (const m of this.all("SELECT * FROM console_messages WHERE turn_id = ? AND state = 'in_turn' ORDER BY id", turnId)) {
      if (status !== "done") this.run("UPDATE console_messages SET state = 'interrupted', ended_at = ? WHERE id = ?", now, m.id as number);
      else if (m.kind === "ask") this.answer(m, finalText?.trim() || "(The turn ended without a final message.)", now, true);
      else this.run("UPDATE console_messages SET state = 'done', ended_at = ? WHERE id = ?", now, m.id as number);
    }
  },
  /** Messages waiting for an agent, oldest first. */
  queuedMessages(this: ConsoleStore, agentId: string): (TeamMessage & { fromName: string })[] {
    return this.all(`${MESSAGES} WHERE m.to_agent = ? AND m.state = 'queued' ORDER BY m.id`, agentId).map(teamMessage);
  },
  /** Agents with queued messages. */
  agentsWithMail(this: ConsoleStore): string[] {
    return this.all("SELECT DISTINCT to_agent FROM console_messages WHERE state = 'queued'").map((r) => r.to_agent as string);
  },
  /** Deliver queued messages as one team turn (batching), when the
   * agent has no open turn. Null when that changed meanwhile. */
  deliver(this: ConsoleStore, epoch: number, agentId: string, ids: number[], prompt: string): number | null {
    return this.transaction(() => {
      const a = this.agent(agentId);
      if (!a || a.state !== "ready" || this.openTurns().some((t) => t.agentId === agentId)) return null;
      if (!ids.length) return null;
      const list = ids.map(() => "?").join(", ");
      const rows = this.all(`${MESSAGES} WHERE m.id IN (${list}) AND m.state = 'queued' AND m.to_agent = ? ORDER BY m.id`, ...ids, agentId).map(teamMessage);
      if (rows.length !== ids.length) return null;
      const now = this.now();
      const instruction = Math.max(...rows.map((m) => m.instructionId ?? 0)) || null;
      const resendOf = Math.max(...rows.map((m) => m.resendAfter ?? 0)) || null;
      const id = this.insert(
        "INSERT INTO console_turns (agent_id, trigger, prompt, status, instruction_id, resend_of, created_at) VALUES (?, 'team', ?, 'queued', ?, ?, ?)",
        agentId, prompt, instruction, resendOf, now,
      );
      this.run(`UPDATE console_messages SET state = 'in_turn', turn_id = ? WHERE id IN (${list})`, id, ...ids);
      const messages = rows.map((m) => ({ from: m.fromName, kind: m.kind, correlationId: m.correlationId, text: m.body }));
      this.insertEvent(id, a, "team", { text: prompt, messages }, now);
      return id;
    }, epoch);
  },
  /** The tab's newest messages, oldest first (the team timeline), each body
   * read only up to `bodyMax` characters. */
  timeline(this: ConsoleStore, tabId: string, limit = 200, bodyMax = Number.MAX_SAFE_INTEGER): Named[] {
    return this.all(
      "SELECT * FROM (SELECT m.id, m.tab_id, m.from_agent, m.to_agent, m.kind, m.correlation_id, substr(m.body, 1, ?) AS body, m.state, m.turn_id, m.from_turn, m.instruction_id, m.resend_after, m.created_at, f.name AS from_name, t.name AS to_name FROM console_messages m LEFT JOIN console_agents f ON f.id = m.from_agent LEFT JOIN console_agents t ON t.id = m.to_agent WHERE m.tab_id = ? ORDER BY m.id DESC LIMIT ?) ORDER BY id",
      bodyMax, tabId, limit,
    ).map(teamMessage);
  },
  /** Asks in a tab still waiting for an answer. */
  openAsks(this: ConsoleStore, tabId: string): number {
    return Number(this.get("SELECT COUNT(*) AS n FROM console_messages WHERE tab_id = ? AND kind = 'ask' AND state IN ('queued', 'in_turn')", tabId)!.n);
  },
  /** Interrupted messages (Needs you), oldest first. */
  interruptedMessages(this: ConsoleStore): (Named & { projectId: string })[] {
    return this.all(
      "SELECT m.*, f.name AS from_name, t.name AS to_name, t.project_id FROM console_messages m LEFT JOIN console_agents f ON f.id = m.from_agent JOIN console_agents t ON t.id = m.to_agent JOIN console_tabs tb ON tb.id = t.tab_id JOIN console_projects p ON p.id = t.project_id WHERE m.state = 'interrupted' AND tb.archived_at IS NULL AND p.archived_at IS NULL ORDER BY m.id",
    ).map((r) => ({ ...teamMessage(r), projectId: r.project_id as string }));
  },
  /** Re-send (a new attempt, told what the interrupted one already did) or
   * Discard. Never automatic. */
  settleInterrupted(this: ConsoleStore, messageId: number, resend: boolean) {
    this.transaction(() => {
      const m = this.get("SELECT * FROM console_messages WHERE id = ? AND state = 'interrupted'", messageId);
      if (!m) throw new Error("That message is no longer waiting.");
      if (!resend) {
        this.run("UPDATE console_messages SET state = 'discarded', ended_at = ? WHERE id = ?", this.now(), messageId);
        return;
      }
      if (!isOpen(this.agent(m.to_agent as string))) throw new Error("Its agent is closed, so it cannot be sent again. Discard it.");
      this.run("UPDATE console_messages SET state = 'queued', resend_after = COALESCE(turn_id, resend_after), turn_id = NULL, ended_at = NULL WHERE id = ?", messageId);
    });
  },

  // ── Routes ───────────────────────────────────────────
  /** A finished turn's final message, queued to each route's agent (in the
   * transaction that ends the turn). */
  route(this: ConsoleStore, turnId: number, finalText: string, now: number) {
    const from = this.agentOf(turnId);
    const tab = this.tab(from.tabId);
    if (!tab || tab.archivedAt !== null || this.project(from.projectId)?.archivedAt != null) return;
    const instruction = (this.get("SELECT instruction_id FROM console_turns WHERE id = ?", turnId)?.instruction_id as number | null) ?? null;
    const lower = finalText.toLowerCase();
    for (const r of this.routes(from.tabId)) {
      if (r.from !== from.id || (r.phrase && !lower.includes(r.phrase.toLowerCase()))) continue;
      const to = this.agent(r.to);
      if (!isOpen(to)) continue;
      const id = this.insert(
        "INSERT INTO console_messages (tab_id, from_agent, to_agent, kind, correlation_id, body, state, from_turn, instruction_id, created_at) VALUES (?, ?, ?, 'route', NULL, ?, 'queued', ?, ?, ?)",
        from.tabId, from.id, to!.id, finalText.slice(0, safeCut(finalText, SHARE_MAX)), turnId, instruction, now,
      );
      this.passOn(turnId, id, finalText);
    }
  },
  /** A tab's working routes, oldest first, with the agents' names: one
   * whose agent is not open (`isOpen`) is not listed. */
  routes(this: ConsoleStore, tabId: string): Route[] {
    return this.all(
      "SELECT r.*, f.name AS from_name, t.name AS to_name FROM console_routes r JOIN console_agents f ON f.id = r.from_agent JOIN console_agents t ON t.id = r.to_agent WHERE r.tab_id = ? AND r.removed_at IS NULL AND f.state NOT IN ('closed', 'error') AND t.state NOT IN ('closed', 'error') ORDER BY r.id",
      tabId,
    ).map((r) => ({
      id: r.id as number,
      from: r.from_agent as string,
      fromName: r.from_name as string,
      to: r.to_agent as string,
      toName: r.to_name as string,
      phrase: r.phrase as string,
    }));
  },
  addRoute(this: ConsoleStore, input: { tabId: string; from: string; to: string; phrase: string }): Route {
    return this.transaction(() => {
      const tab = this.tab(input.tabId);
      if (!tab || tab.archivedAt !== null || this.project(tab.projectId)?.archivedAt != null) throw new Error("That tab is closed.");
      const from = this.agent(input.from);
      const to = this.agent(input.to);
      if (!from || !to || from.tabId !== tab.id || to.tabId !== tab.id || from.state === "closed" || to.state === "closed")
        throw new Error("Both agents must be open in this tab.");
      // A failed agent never finishes a turn nor takes messages.
      if (from.state === "error" || to.state === "error") throw new Error("An agent whose setup failed cannot be part of a route.");
      if (from.id === to.id) throw new Error("A route goes from one agent to another.");
      const same = this.routes(tab.id).find((r) => r.from === from.id && r.to === to.id && r.phrase.toLowerCase() === input.phrase.toLowerCase());
      if (same) throw new Error("That route is already there.");
      const id = this.insert("INSERT INTO console_routes (tab_id, from_agent, to_agent, phrase, created_at) VALUES (?, ?, ?, ?, ?)", tab.id, from.id, to.id, input.phrase, this.now());
      return this.routes(tab.id).find((r) => r.id === id)!;
    });
  },
  removeRoute(this: ConsoleStore, routeId: number): boolean {
    return this.run("UPDATE console_routes SET removed_at = ? WHERE id = ? AND removed_at IS NULL", this.now(), routeId) === 1;
  },

  // ── Instructions ──────────────────────────────────────────────
  /** How far an instruction has gone in a tab since its last Resume. */
  instructionUse(this: ConsoleStore, instructionId: number, tabId: string): { turns: number; startedAt: number } {
    const t = this.get("SELECT count_from, resumed_at FROM console_tabs WHERE id = ?", tabId);
    const turns = Number(
      this.get(
        "SELECT COUNT(*) AS n FROM console_turns c JOIN console_agents a ON a.id = c.agent_id WHERE c.instruction_id = ? AND a.tab_id = ? AND c.id > ?",
        instructionId, tabId, (t?.count_from as number) ?? 0,
      )!.n,
    );
    const start = this.get("SELECT created_at FROM console_turns WHERE id = ?", instructionId)?.created_at as number | undefined;
    return { turns, startedAt: Math.max(start ?? this.now(), (t?.resumed_at as number) ?? 0) };
  },
  /**
   * The circle detector: the two agents of a tab that have exchanged at
   * least `limit` messages since the tab's latest commit, owner message or
   * Resume, with their names; else null. Messages from a turn that is
   * `unsettled` (still open, or its commit not yet checked) are left out:
   * that turn may yet turn out to be progress.
   */
  circle(this: ConsoleStore, tabId: string, limit: number, unsettled: (from: string, fromTurn: number) => boolean = () => false): { a: string; b: string; count: number } | null {
    const one = (sql: string) => Number((this.get(sql, tabId)?.n as number | null) ?? 0);
    const since = Math.max(
      // The latest commit by any agent of the tab: the Console's, or any
      // that moved the branch (the agent's own git commit, a merge).
      one("SELECT MAX(COALESCE(c.progress_mark, c.turn_id)) AS n FROM console_commits c JOIN console_agents a ON a.id = c.agent_id WHERE a.tab_id = ?"),
      one("SELECT MAX(COALESCE(t.progress_mark, t.id)) AS n FROM console_turns t JOIN console_agents a ON a.id = t.agent_id WHERE a.tab_id = ? AND t.progressed = 1"),
      // The owner's latest message: a turn of its own, or delivered as mail.
      one("SELECT MAX(t.id) AS n FROM console_turns t JOIN console_agents a ON a.id = t.agent_id WHERE a.tab_id = ? AND t.trigger = 'owner' AND t.status <> 'withdrawn'"),
      // An owner's edit of a queued message.
      one("SELECT circle_from AS n FROM console_tabs WHERE id = ?"),
      one("SELECT MAX(turn_id) AS n FROM console_messages WHERE tab_id = ? AND from_agent IS NULL"),
      // The owner's latest Resume.
      one("SELECT count_from AS n FROM console_tabs WHERE id = ?"),
    );
    // Only messages from turns checked for progress: a turn not checked yet
    // (running, or its check failed and waits for a restart) may be progress.
    const rows = this.all(
      "SELECT m.from_agent, m.to_agent, m.from_turn FROM console_messages m JOIN console_turns ft ON ft.id = m.from_turn WHERE m.tab_id = ? AND m.from_agent IS NOT NULL AND m.from_turn > ? AND ft.progressed <> 0",
      tabId, since,
    );
    const pair = circlePair(
      rows.map((r) => ({ from: r.from_agent as string, to: r.to_agent as string, fromTurn: r.from_turn as number })).filter((m) => !unsettled(m.from, m.fromTurn)),
      since,
      limit,
    );
    if (!pair) return null;
    const name = (id: string) => this.agent(id)?.name ?? id;
    return { a: name(pair.a), b: name(pair.b), count: pair.count };
  },
};
