import assert from "node:assert/strict";
import { test } from "node:test";
import { addMenu, agentMenu, modelMenu, projectMenu, tabMenu, type AgentMenuContext, type MenuContext } from "../src/lib/console/menus.ts";
import { AGENT_KINDS } from "../src/lib/console/agents.ts";
import { SPEND_PAUSE, type ConsoleProject } from "../src/lib/console/types.ts";
import type { AgentView, ProjectView } from "../src/lib/console/views.ts";

// The page's menus, built from what the page shows.

type Tab = ProjectView["tabs"][number];

const project = (id: string, more: Partial<ConsoleProject> = {}): ConsoleProject => ({
  id,
  name: id.toUpperCase(),
  source: "folder",
  repo: null,
  baseBranch: "main",
  state: "ready",
  error: null,
  paused: false,
  pauseReason: null,
  archivedAt: null,
  acpNetwork: false,
  acpNetworkPending: null,
  imageTools: false,
  createdAt: 0,
  ...more,
});

const tab = (id: string, more: Partial<Tab> = {}) =>
  ({ id, name: `Tab ${id}`, paused: false, pauseReason: null, steps: null, spend: { usd: 0.5, limitUsd: 10 }, ...more }) as unknown as Tab;

/** A context whose dialogs and commands are recorded. */
function context(tabs: Tab[], more: Partial<MenuContext> = {}) {
  const opened: unknown[] = [];
  const ran: unknown[] = [];
  const ctx: MenuContext = {
    view: { project: project("p"), tabs, closedTabs: [], agents: [], codexRunning: 0 } as unknown as ProjectView,
    projects: [project("p"), project("q"), project("old", { archivedAt: 1 })],
    templates: [],
    activeTab: tabs[0]?.id ?? null,
    withFiles: true,
    open: (modal) => opened.push(modal),
    run: async (body) => ran.push(body),
    renameTab: () => {},
    renameProject: () => {},
    selectProject: () => {},
    ...more,
  };
  return { ctx, opened, ran };
}

const item = (items: { label: string }[], label: string) => {
  const found = items.find((i) => i.label === label);
  assert.ok(found, `no ${label} in ${items.map((i) => i.label).join(", ")}`);
  return found as (typeof items)[number] & { onSelect: () => void; disabled?: boolean; hint?: string; icon?: string; title?: string; value?: string; checked?: boolean; selected?: boolean };
};

test("a tab's menu: Pause or Resume or Reset spend by why it is paused, Steps only with steps, and the last tab cannot close", () => {
  const { ctx, opened, ran } = context([tab("a")]);
  const one = tabMenu(ctx.view!.tabs[0], ctx);
  item(one, "Pause tab…").onSelect();
  assert.deepEqual(opened, [{ kind: "pause", scope: "tab", id: "a", name: "Tab a" }]);
  assert.equal(one.some((i) => i.label === "Steps…"), false);
  const close = item(one, "Close tab…");
  assert.equal(close.disabled, true);
  assert.equal(close.title, "A project keeps one open tab");
  // Spend with a limit, and with none.
  assert.equal(item(one, "Spend limit…").value, "$0.50 of $10.00");
  assert.equal(item(tabMenu(tab("a", { spend: { usd: 0.5, limitUsd: null } } as Partial<Tab>), ctx), "Spend limit…").value, "$0.50");

  item(tabMenu(tab("a", { paused: true, pauseReason: "Paused by you" }), ctx), "Resume tab").onSelect();
  item(tabMenu(tab("a", { paused: true, pauseReason: `${SPEND_PAUSE}$10.00` }), ctx), "Reset spend").onSelect();
  assert.deepEqual(ran, [
    { action: "resume", scope: "tab", id: "a" },
    { action: "resetSpend", tabId: "a" },
  ]);

  const two = context([tab("a"), tab("b", { steps: { index: 1, steps: [{ name: "x", files: [] }, { name: "y", files: [] }] } } as Partial<Tab>)]);
  const menu = tabMenu(two.ctx.view!.tabs[1], two.ctx);
  assert.equal(item(menu, "Steps…").value, "2 of 2");
  assert.equal(item(menu, "Close tab…").disabled, false);
});

test("the project's menu: open projects to switch to (the current one ticked), and items by its source", () => {
  const selected: string[] = [];
  const { ctx } = context([tab("a")], { selectProject: (id) => selected.push(id) });
  const menu = projectMenu(ctx.projects[0], ctx);
  // Archived projects are not offered.
  assert.equal(menu.some((i) => i.label === "OLD"), false);
  assert.equal(item(menu, "P").selected, true);
  assert.equal(item(menu, "Q").selected, false);
  item(menu, "Q").onSelect();
  assert.deepEqual(selected, ["q"]);
  assert.equal(item(menu, "Image tools").checked, false);
  assert.equal(item(menu, "Closed tabs…").disabled, true);
  // A folder project has folders but no GitHub page.
  assert.ok(menu.some((i) => i.label === "Folders…"));
  assert.equal(menu.some((i) => i.label === "Open on GitHub"), false);

  const github = projectMenu(project("p", { source: "github", repo: "o/r", imageTools: true }), ctx);
  assert.equal(item(github, "Open on GitHub").title, "o/r");
  assert.equal(item(github, "Image tools").checked, true);
  const none = projectMenu(project("p", { source: "none" }), ctx);
  assert.equal(none.some((i) => i.label === "Folders…"), false);
});

const agent = (id: string, more: Partial<AgentView> = {}) =>
  ({ id, name: id, tabId: "a", kind: "claude-code", model: "", effort: null, folder: "/f", askFirst: false, networkAuto: false, summaryWaiting: false, ...more }) as unknown as AgentView;

test("a tab's menu: Network auto switches every agent of the tab that has the setting", () => {
  const view = (agents: AgentView[]) => ({ project: project("p"), tabs: [tab("a"), tab("b")], closedTabs: [], agents, codexRunning: 0 }) as unknown as ProjectView;
  // No agent with the setting: no switch.
  const none = context([tab("a")], { view: view([agent("x", { kind: "acp" as AgentView["kind"] })]) });
  assert.equal(tabMenu(tab("a"), none.ctx).some((i) => i.label === "Network auto"), false);
  // One of two on: the switch is off, says how many, and turns all on.
  const some = context([tab("a")], { view: view([agent("x", { networkAuto: true }), agent("y", { kind: "codex" }), agent("z", { tabId: "b" })]) });
  const off = item(tabMenu(tab("a"), some.ctx), "Network auto");
  assert.equal(off.checked, false);
  assert.equal(off.value, "1 of 2");
  off.onSelect();
  // All on: the switch is on and turns all off.
  const all = context([tab("a")], { view: view([agent("x", { networkAuto: true })]) });
  const on = item(tabMenu(tab("a"), all.ctx), "Network auto");
  assert.equal(on.checked, true);
  on.onSelect();
  assert.deepEqual([...some.ran, ...all.ran], [
    { action: "setNetwork", tabId: "a", auto: true },
    { action: "setNetwork", tabId: "a", auto: false },
  ]);
});

test("an agent's menu: Ask me first is a switch, and Stop shows only while there is a turn", () => {
  const ran: unknown[] = [];
  const ctx: AgentMenuContext = {
    otherCodexRunning: 0,
    busy: false,
    turning: false,
    run: async (body) => ran.push(body),
    confirmed: (_question, body) => () => ran.push(body),
    freshWithSummary: () => {},
    onChanges: () => {},
    onFiles: () => {},
    onRename: () => {},
  };
  const idle = agentMenu(agent("x"), ctx);
  assert.equal(idle.some((i) => i.label === "Stop" || i.label === "Model…" || i.label === "Network…"), false);
  const ask = item(idle, "Ask me first");
  assert.equal(ask.checked, false);
  ask.onSelect();
  assert.deepEqual(ran, [{ action: "setAskFirst", agentId: "x", on: true }]);
  // Codex has no Ask me first.
  assert.equal(agentMenu(agent("x", { kind: "codex" }), ctx).some((i) => i.label === "Ask me first"), false);
  const busy = agentMenu(agent("x"), { ...ctx, busy: true, turning: true });
  assert.ok(busy.some((i) => i.label === "Stop") && busy.some((i) => i.label === "Force stop"));
  assert.equal(item(busy, "Start fresh").disabled, true);
});

test("the model chip's menu: a new model starts at its default thinking level, and the current choice does nothing", () => {
  const kind = AGENT_KINDS.find((k) => k.kind === "claude-code")!;
  const current = kind.models.find((m) => m.efforts.length)!;
  const other = kind.models.find((m) => m.id !== current.id)!;
  const ran: unknown[] = [];
  const menu = modelMenu(agent("x", { model: current.id, effort: current.efforts[0] as AgentView["effort"] }), async (body) => ran.push(body));
  assert.equal(item(menu, current.label).selected, true);
  assert.equal(item(menu, "Default").selected, false);
  // The current model's row keeps its thinking level: nothing is sent.
  item(menu, current.label).onSelect();
  assert.deepEqual(ran, []);
  item(menu, other.label).onSelect();
  item(menu, "Default").onSelect();
  assert.deepEqual(ran, [
    { action: "setAi", agentId: "x", model: other.id, effort: "default" },
    { action: "setAi", agentId: "x", model: current.id, effort: "default" },
  ]);
});

test("Add: Agent needs a tab; Team and From a template need a project with files", () => {
  const opened: unknown[] = [];
  const open = (m: unknown) => opened.push(m);
  const templates = [{ id: "t1" }] as MenuContext["templates"];
  const full = addMenu({ activeTab: "a", withFiles: true, templates, open });
  assert.deepEqual(
    full.map((i) => !!i.disabled),
    [false, false, false],
  );
  item(full, "From a template").onSelect();
  assert.deepEqual(opened, [{ kind: "newTab", template: "t1" }]);

  const talk = addMenu({ activeTab: "a", withFiles: false, templates, open });
  assert.equal(item(talk, "Agent").disabled, false);
  assert.equal(item(talk, "Team").disabled, true);
  assert.equal(item(talk, "Team").hint, "Needs a project with files");
  assert.equal(item(talk, "From a template").disabled, true);
  assert.equal(item(addMenu({ activeTab: null, withFiles: true, templates: [], open }), "Agent").disabled, true);
});
