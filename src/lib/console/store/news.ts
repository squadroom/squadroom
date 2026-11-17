import type { ConsoleStore } from "../store.ts";

/** What an agent is told about things that happened while it did not
 * work: a merge it asked for or of its own pull request, its push that
 * went out, the checks GitHub ran on it. By agent, the lines not
 * yet told. A flag (its name is from when it held merges only). */
const NEWS = "merge-news:";
/** The commit of an agent's latest push whose GitHub checks are still being
 * waited for, by agent. A flag. */
const CHECKS_WATCH = "checks-watch:";

/** How the Console's message to an idle agent starts. */
export const WAKE_HEAD = "[Console] While you were not working:";
/** The Console's message to an idle agent: what happened, then carry on. */
export const wakePrompt = (lines: string[]) =>
  `${WAKE_HEAD}\n\n${lines.join("\n\n")}\n\nCarry on from here. If this leaves you nothing to do, say so in one line and end your turn.`;

export type ChecksWatch = { agentId: string; sha: string; number: number; since: number };

// News that wakes an idle agent: the lines, the checks being
// waited for, and the Console's message that tells them.
export const news = {
  /** One more line for an agent (in the caller's transaction); a closed
   * agent is told nothing. */
  addNews(this: ConsoleStore, agentId: string, line: string) {
    const state = this.agent(agentId)?.state;
    if (!state || state === "closed") return;
    this.setFlag(NEWS + agentId, JSON.stringify([...this.news(agentId), line]));
  },
  news(this: ConsoleStore, agentId: string): string[] {
    const flag = this.flag(NEWS + agentId);
    return flag ? (JSON.parse(flag) as string[]) : [];
  },
  /** The agent has been told the first `count` lines (later ones are news). */
  newsTold(this: ConsoleStore, epoch: number, agentId: string, count: number) {
    this.transaction(() => {
      const left = this.news(agentId).slice(count);
      this.setFlag(NEWS + agentId, left.length ? JSON.stringify(left) : null);
    }, epoch);
  },
  /** Wait for GitHub's checks on a pushed commit (in the caller's
   * transaction). A later push replaces the commit waited for. */
  watchChecks(this: ConsoleStore, agentId: string, sha: string, number: number) {
    this.setFlag(CHECKS_WATCH + agentId, JSON.stringify({ sha, number, since: this.now() }));
  },
  checksWatches(this: ConsoleStore): ChecksWatch[] {
    return this.all("SELECT key, value FROM console_flags WHERE key LIKE ? ORDER BY key", `${CHECKS_WATCH}%`).map((r) => ({
      agentId: (r.key as string).slice(CHECKS_WATCH.length),
      ...(JSON.parse(r.value as string) as Omit<ChecksWatch, "agentId">),
    }));
  },
  /** The checks on `sha` finished, or are no longer waited for: `line` (if
   * any) becomes news. Nothing happens when a later push replaced it. */
  endChecksWatch(this: ConsoleStore, epoch: number, agentId: string, sha: string, line: string | null) {
    this.transaction(() => {
      const flag = this.flag(CHECKS_WATCH + agentId);
      if (!flag || (JSON.parse(flag) as ChecksWatch).sha !== sha) return;
      this.setFlag(CHECKS_WATCH + agentId, null);
      if (line) this.addNews(agentId, line);
    }, epoch);
  },
  /** Wake an idle agent with its news: a Console message of the owner's
   * side (as a proposed tab's answer is one). The news stays untold until
   * the turn reaches the agent, which then sends it as it is (the worker
   * rebuilds the text), so a wake that fails first loses nothing. Nothing
   * when the agent got a turn or mail meanwhile (that turn tells it), or
   * when its latest turn is a wake that failed before it was sent: the
   * news then waits for its next turn instead of failing over and over. */
  isWake(this: ConsoleStore, trigger: string, prompt: string): boolean {
    return trigger === "owner" && prompt.startsWith(WAKE_HEAD);
  },
  /** A queued wake with nothing left to tell (another turn told it first). */
  staleWake(this: ConsoleStore, turn: { agentId: string; trigger: string; prompt: string }): boolean {
    return this.isWake(turn.trigger, turn.prompt) && !this.news(turn.agentId).length && !this.failedPush(turn.agentId, true);
  },
  wake(this: ConsoleStore, epoch: number, agentId: string, prompt: string): boolean {
    return this.transaction(() => {
      if (this.agent(agentId)?.state !== "ready") return false;
      if (this.openTurns().some((t) => t.agentId === agentId) || this.agentsWithMail().includes(agentId)) return false;
      const last = this.get("SELECT trigger, prompt, status, prompted FROM console_turns WHERE agent_id = ? AND status <> 'withdrawn' ORDER BY id DESC LIMIT 1", agentId);
      if (last && this.isWake(last.trigger as string, last.prompt as string) && last.status !== "done" && !last.prompted) return false;
      this.ownerTurn(agentId, prompt, null, {});
      return true;
    }, epoch);
  },
};
