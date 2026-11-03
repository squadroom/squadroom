import assert from "node:assert/strict";
import { test } from "node:test";
import { addMenu, projectMenu, tabMenu, type MenuContext } from "../src/lib/console/menus.ts";
import { SPEND_PAUSE, type ConsoleProject } from "../src/lib/console/types.ts";
import type { ProjectView } from "../src/lib/console/views.ts";

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
  return found as (typeof items)[number] & { onSelect: () => void; disabled?: boolean; hint?: string; icon?: string };
};

test("a tab's menu: Pause or Resume or Reset spend by why it is paused, Steps only with steps, and the last tab cannot close", () => {
  const { ctx, opened, ran } = context([tab("a")]);
  const one = tabMenu(ctx.view!.tabs[0], ctx);
  item(one, "Pause tab…").onSelect();
  assert.deepEqual(opened, [{ kind: "pause", scope: "tab", id: "a", name: "Tab a" }]);
  assert.equal(one.some((i) => i.label === "Steps…"), false);
  const close = item(one, "Close tab…");
  assert.equal(close.disabled, true);
  assert.equal(close.hint, "A project keeps one open tab");

  item(tabMenu(tab("a", { paused: true, pauseReason: "Paused by you" }), ctx), "Resume tab").onSelect();
  item(tabMenu(tab("a", { paused: true, pauseReason: `${SPEND_PAUSE}$10.00` }), ctx), "Reset spend").onSelect();
  assert.deepEqual(ran, [
    { action: "resume", scope: "tab", id: "a" },
    { action: "resetSpend", tabId: "a" },
  ]);

  const two = context([tab("a"), tab("b", { steps: { index: 1, steps: [{ name: "x", files: [] }, { name: "y", files: [] }] } } as Partial<Tab>)]);
  const menu = tabMenu(two.ctx.view!.tabs[1], two.ctx);
  assert.equal(item(menu, "Steps…").hint, "Step 2 of 2");
  assert.equal(item(menu, "Close tab…").disabled, false);
});

test("the project's menu: open projects to switch to (the current one ticked), and items by its source", () => {
  const selected: string[] = [];
  const { ctx } = context([tab("a")], { selectProject: (id) => selected.push(id) });
  const menu = projectMenu(ctx.projects[0], ctx);
  // Archived projects are not offered.
  assert.equal(menu.some((i) => i.label === "OLD"), false);
  assert.equal(item(menu, "P").icon, "check");
  assert.equal(item(menu, "Q").icon, "blank");
  item(menu, "Q").onSelect();
  assert.deepEqual(selected, ["q"]);
  assert.equal(item(menu, "Turn image tools on").icon, "blank");
  assert.equal(item(menu, "Closed tabs…").disabled, true);
  // A folder project has folders but no GitHub page.
  assert.ok(menu.some((i) => i.label === "Folders…"));
  assert.equal(menu.some((i) => i.label === "Open on GitHub"), false);

  const github = projectMenu(project("p", { source: "github", repo: "o/r", imageTools: true }), ctx);
  assert.equal(item(github, "Open on GitHub").hint, "o/r");
  assert.equal(item(github, "Turn image tools off").icon, "check");
  const none = projectMenu(project("p", { source: "none" }), ctx);
  assert.equal(none.some((i) => i.label === "Folders…"), false);
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
