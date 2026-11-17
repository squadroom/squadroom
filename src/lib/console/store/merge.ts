import { deniedNote, mergeAsked, mergeRunning, mergeUnknown, mergeWaiting, type MergeAsk } from "../merge.ts";
import type { ConsoleJob } from "../types.ts";
import type { ConsoleStore } from "../store.ts";
import { BASE_TIP } from "./git.ts";

// team_merge: the request in Needs you (a notice of kind
// "merge", as a proposed tab is one), the owner's answer, the merge job the
// worker runs (in the push jobs' queue) and what the agents are told.
export const merges = {
  /** team_merge: the call's record and its Needs you item, in one
   * transaction. One item per pull request: the same commit asked for
   * again adds nothing, and a new commit replaces the item (the owner
   * approves one commit). */
  askMerge(this: ConsoleStore, epoch: number, r: { turnId: number; agentId: string; projectId: string; key: string; text: string; merge: MergeAsk }): string {
    return this.callOnce(epoch, { turnId: r.turnId, agentId: r.agentId, key: r.key, tool: "team_merge", summary: `team_merge pull request #${r.merge.number}` }, () => {
      const inProject = "agent_id IN (SELECT id FROM console_agents WHERE project_id = ?)";
      // Another agent asking for the same merge is told its outcome too.
      const joined = (owner: string, ask: MergeAsk) =>
        owner === r.agentId || ask.alsoAsked?.includes(r.agentId) ? null : JSON.stringify({ ...ask, alsoAsked: [...(ask.alsoAsked ?? []), r.agentId] });
      for (const j of this.all(`SELECT id, agent_id, request FROM console_jobs WHERE kind = 'merge' AND state IN ('queued', 'running') AND ${inProject}`, r.projectId)) {
        const ask = JSON.parse(j.request as string) as MergeAsk;
        if (ask.number !== r.merge.number) continue;
        const data = joined(j.agent_id as string, ask);
        if (data) this.run("UPDATE console_jobs SET request = ? WHERE id = ?", data, j.id as number);
        return mergeRunning(r.merge.number);
      }
      for (const n of this.all(`SELECT id, agent_id, data FROM console_notices WHERE kind = 'merge' AND dismissed = 0 AND ${inProject}`, r.projectId)) {
        const open = JSON.parse(n.data as string) as MergeAsk;
        if (open.number !== r.merge.number) continue;
        if (open.sha === r.merge.sha) {
          const data = joined(n.agent_id as string, open);
          if (data) this.run("UPDATE console_notices SET data = ? WHERE id = ?", data, n.id as number);
          return mergeWaiting(open);
        }
        this.run("UPDATE console_notices SET dismissed = 1 WHERE id = ?", n.id as number);
      }
      const data = JSON.stringify(r.merge);
      this.run("INSERT INTO console_notices (agent_id, text, kind, data, created_at) VALUES (?, ?, 'merge', ?, ?)", r.agentId, r.text, data, this.now());
      this.chargePayload(r.turnId, Buffer.byteLength(data, "utf8") + Buffer.byteLength(r.text, "utf8"));
      return mergeAsked(r.merge);
    });
  },
  /** The owner's answer to a merge request, once: its Needs you item goes.
   * Approved, the merge is queued for the worker, which checks everything
   * again before it asks GitHub; denied, every agent that asked is told
   * (as news). Either works after the asking turn has ended. */
  settleMerge(this: ConsoleStore, noticeId: number, approve: boolean): ConsoleJob | null {
    return this.transaction(() => {
      const n = this.get("SELECT agent_id, data FROM console_notices WHERE id = ? AND kind = 'merge' AND dismissed = 0", noticeId);
      if (!n) throw new Error("That merge request has already been answered.");
      this.run("UPDATE console_notices SET dismissed = 1 WHERE id = ?", noticeId);
      const agentId = n.agent_id as string;
      if (!approve) {
        const ask = JSON.parse(n.data as string) as MergeAsk;
        for (const id of new Set([agentId, ...(ask.alsoAsked ?? [])])) this.addNews(id, deniedNote(ask.number));
        return null;
      }
      return this.job(this.insert("INSERT INTO console_jobs (agent_id, kind, state, request, created_at) VALUES (?, 'merge', 'queued', ?, ?)", agentId, n.data as string, this.now()))!;
    });
  },
  /** A merge job ended: its record, the line in each window, what each
   * agent is told next, the owner's note when it did not go through and,
   * when it did, where the base branch now is (so the other agents hear
   * that it moved), in one transaction. */
  finishMerge(
    this: ConsoleStore,
    epoch: number,
    id: number,
    r: { merged: string | null; message: string; url: string | null; windows: string[]; news: { agentId: string; text: string }[]; notice: string | null },
  ) {
    this.transaction(() => {
      this.run("UPDATE console_jobs SET state = ?, message = ?, url = ?, head = ?, ended_at = ? WHERE id = ?", r.merged ? "done" : "failed", r.message, r.url, r.merged, this.now(), id);
      const job = this.job(id);
      const asker = job?.agentId;
      // Agents that joined while the merge ran are told what the asker is.
      const askerNews = r.news.find((n) => n.agentId === asker);
      const joined = (job?.merge?.alsoAsked ?? []).filter((a) => !r.windows.includes(a));
      if (askerNews) r = { ...r, windows: [...r.windows, ...joined], news: [...r.news, ...joined.map((agentId) => ({ agentId, text: askerNews.text }))] };
      for (const agentId of new Set(r.windows)) {
        const a = this.agent(agentId);
        if (a) this.insertEvent(0, a, "push", { text: r.message, url: r.url }, this.now());
      }
      for (const n of r.news) this.addNews(n.agentId, n.text);
      if (r.notice && asker && this.agent(asker)) this.run("INSERT INTO console_notices (agent_id, text, created_at) VALUES (?, ?, ?)", asker, r.notice, this.now());
      const projectId = asker && this.agent(asker)?.projectId;
      if (r.merged && projectId) this.setFlag(BASE_TIP + projectId, r.merged);
    }, epoch);
  },
  /** Merges an earlier worker was running fail visibly: GitHub may or may
   * not have merged, so both the owner and the agent are told to look. */
  failEarlierMerges(this: ConsoleStore, epoch: number) {
    this.transaction(() => {
      for (const row of this.all("SELECT id, agent_id, request FROM console_jobs WHERE kind = 'merge' AND state = 'running'")) {
        const { number, alsoAsked } = JSON.parse(row.request as string) as MergeAsk;
        const agentId = row.agent_id as string;
        this.run("UPDATE console_jobs SET state = 'failed', message = ?, ended_at = ? WHERE id = ?", mergeUnknown(number), this.now(), row.id as number);
        for (const id of new Set([agentId, ...(alsoAsked ?? [])])) this.addNews(id, mergeUnknown(number));
        if (this.agent(agentId)) this.run("INSERT INTO console_notices (agent_id, text, created_at) VALUES (?, ?, ?)", agentId, mergeUnknown(number), this.now());
      }
    }, epoch);
  },
};
