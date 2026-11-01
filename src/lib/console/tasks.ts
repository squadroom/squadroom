// The task list: an agent's current checklist, rebuilt from what its
// client already reports. Pure: the worker feeds it, the store keeps the
// result, and nothing here reaches any agent's prompt.
//
// - Claude Code (2.1.282): TodoWrite carries the whole list; TaskCreate adds
//   one task, whose id is in its result ("Task #<id> created successfully");
//   TaskUpdate changes or deletes one task by id. A call counts only once its
//   result reports success.
// - Codex (0.155.1): `turn/plan/updated` carries the whole plan.

export type TaskStatus = "pending" | "in_progress" | "completed";
export interface TaskItem {
  /** The client's task id (TaskCreate); null for a whole-list item. */
  id: string | null;
  text: string;
  status: TaskStatus;
}
export interface TaskListState {
  items: TaskItem[];
  /** Longer than the bound: the first TASKS_MAX items only, no count. */
  incomplete: boolean;
  /** A call's result was lost: shown as "may be out of date". */
  stale: boolean;
}
export type TaskOp =
  | { kind: "list"; items: { text: string; status: TaskStatus }[] }
  | { kind: "create"; text: string }
  | { kind: "update"; taskId: string; status?: TaskStatus | "deleted"; text?: string; label?: string };

export const TASKS_MAX = 100;
export const TASK_TEXT_MAX = 300;
/** A longer call or task id is not followed (the list may be out of date). */
export const TASK_ID_MAX = 100;
const CREATED = /^Task #(\S+) created successfully/;

export const EMPTY_TASKS: TaskListState = { items: [], incomplete: false, stale: false };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
function status(v: unknown): TaskStatus | undefined {
  if (v === "pending" || v === "in_progress" || v === "completed") return v;
  if (v === "inProgress") return "in_progress";
  return undefined;
}
/** One line, bounded. Redaction is the caller's (it holds the redactor). */
function taskText(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TASK_TEXT_MAX ? `${line.slice(0, TASK_TEXT_MAX - 1)}…` : line;
}

/** A Claude Code tool call that changes the task list, or null. A call
 * that does not match the client's own input shape changes nothing. */
export function claudeTaskOp(name: string, input: unknown): TaskOp | null {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (name === "TodoWrite") {
    if (!Array.isArray(i.todos)) return null;
    const items: { text: string; status: TaskStatus }[] = [];
    for (const t of i.todos) {
      const o = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
      const s = status(o.status);
      const text = str(o.content);
      if (!s || text === undefined) return null;
      items.push({ text, status: s });
    }
    return { kind: "list", items };
  }
  if (name === "TaskCreate") {
    const text = str(i.subject);
    return text === undefined ? null : { kind: "create", text };
  }
  if (name === "TaskUpdate") {
    // The client accepts `id` / `task_id` for `taskId`.
    const taskId = str(i.taskId) ?? str(i.id) ?? str(i.task_id);
    if (taskId === undefined) return null;
    const s = i.status === "deleted" ? "deleted" : i.status === undefined ? undefined : status(i.status);
    if (i.status !== undefined && s === undefined) return null;
    if (i.subject !== undefined && typeof i.subject !== "string") return null;
    return { kind: "update", taskId, ...(s ? { status: s } : {}), ...(str(i.subject) !== undefined ? { text: str(i.subject) } : {}) };
  }
  return null;
}

/** Codex's whole plan (`turn/plan/updated`), or null if malformed. */
export function codexPlanOp(plan: unknown): TaskOp | null {
  if (!Array.isArray(plan)) return null;
  const items: { text: string; status: TaskStatus }[] = [];
  for (const p of plan) {
    const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    const s = status(o.status);
    const text = typeof o.step === "string" ? o.step : undefined;
    if (!s || text === undefined) return null;
    items.push({ text, status: s });
  }
  return { kind: "list", items };
}

/** The op with every text passed through `fn` (redaction) and bounded. A
 * task id is redacted too (the created id is read from a result redacted
 * the same way, so they still match), and gives an unseen task its label. */
export function mapTaskText(op: TaskOp, fn: (text: string) => string): TaskOp {
  const t = (text: string) => taskText(fn(text));
  if (op.kind === "list") return { kind: "list", items: op.items.map((i) => ({ ...i, text: t(i.text) })) };
  if (op.kind === "create") return { kind: "create", text: t(op.text) };
  const taskId = fn(op.taskId);
  return { ...op, taskId, label: t(`Task ${taskId}`), ...(op.text !== undefined ? { text: t(op.text) } : {}) };
}
/** A call the Console cannot follow: its call id or task id is too long. */
export function unfollowable(callId: string, op: TaskOp): boolean {
  return !callId || callId.length > TASK_ID_MAX || (op.kind === "update" && op.taskId.length > TASK_ID_MAX);
}

/** Apply one successful call. `resultText` is the call's result (it names
 * a created task's id). */
export function applyTaskOp(state: TaskListState, op: TaskOp, resultText = ""): TaskListState {
  if (op.kind === "list") {
    // A whole list replaces everything, and settles "may be out of date".
    return {
      items: op.items.slice(0, TASKS_MAX).map((i) => ({ id: null, text: i.text, status: i.status })),
      incomplete: op.items.length > TASKS_MAX,
      stale: false,
    };
  }
  if (op.kind === "create") {
    const id = CREATED.exec(resultText.trim())?.[1];
    // A success without an id, or with one over the bound, cannot be
    // followed by its updates.
    if (!id || id.length > TASK_ID_MAX) return { ...state, stale: true };
    if (state.items.some((i) => i.id === id)) return state;
    // Once incomplete, the shown items stay the first ones until a whole
    // list rebuilds them: a later create never fills a deleted one's place.
    if (state.incomplete || state.items.length >= TASKS_MAX) return { ...state, incomplete: true };
    return { ...state, items: [...state.items, { id, text: op.text, status: "pending" }] };
  }
  const at = state.items.findIndex((i) => i.id === op.taskId);
  if (op.status === "deleted") return at < 0 ? state : { ...state, items: state.items.filter((_, n) => n !== at) };
  if (at < 0) {
    // As the client does: an update to a task it never showed adds it. Past
    // the bound it is one of the items left out.
    if (state.incomplete || state.items.length >= TASKS_MAX) return { ...state, incomplete: true };
    return { ...state, items: [...state.items, { id: op.taskId, text: op.text ?? op.label ?? taskText(`Task ${op.taskId}`), status: op.status ?? "pending" }] };
  }
  const items = state.items.slice();
  items[at] = { ...items[at], ...(op.text !== undefined ? { text: op.text } : {}), ...(op.status ? { status: op.status } : {}) };
  return { ...state, items };
}

/** "3 of 7 done", or null while the list is incomplete. */
export function taskCount(state: TaskListState): { done: number; total: number } | null {
  if (state.incomplete) return null;
  return { done: state.items.filter((i) => i.status === "completed").length, total: state.items.length };
}

/** The task list's folded line under the window header, or null for none. */
export function taskLine(
  view: { items: unknown[]; count: { done: number; total: number } | null; stale: boolean } | null,
  taskTools: boolean,
): string | null {
  if (!view || (view.items.length === 0 && !view.stale)) return taskTools ? null : "No task list for this model";
  const count = view.count ? `${view.count.done} of ${view.count.total} done` : `first ${TASKS_MAX} shown, list incomplete`;
  return `Tasks · ${count}${view.stale ? " · may be out of date" : ""}`;
}
