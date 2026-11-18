// The team tools: what agents in one tab call to message each other and
// share their work, which of them each agent is offered, and the note in
// every agent's instructions that explains them. Pure.

/** The tools every agent in a tab has. `team_push` only for an editing
 * agent of a GitHub project. */
export const TEAM_TOOLS = [
  {
    name: "team_list",
    description: "List the agents in your tab: names, roles, kinds and what each is doing now.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "team_project",
    description:
      "See where every tab of your project stands: each tab's agents, what each is doing, its branch and, in a GitHub project, its last push (or why it failed), whether GitHub has the branch and which commits are not pushed yet, its pull request and its checks; then the base branch's latest commit. Use it before asking the owner to look anything up on GitHub. Read-only: names and states, never anyone's conversation or files.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "team_send",
    description:
      "Send a message to a teammate in your tab. It is delivered when they are free; no answer is expected. Not a reply to an ask: answer asks with team_reply.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string", description: "The teammate's name." }, message: { type: "string" } },
      required: ["to", "message"],
    },
  },
  {
    name: "team_ask",
    description:
      "Ask a teammate in your tab something. This does not wait: end your turn, and their answer arrives as your next message, with the same correlation id.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string", description: "The teammate's name." }, message: { type: "string" } },
      required: ["to", "message"],
    },
  },
  {
    name: "team_reply",
    description:
      "Answer one ask you were given, by its correlation id. An ask you do not answer this way is answered with your final message of the turn.",
    inputSchema: {
      type: "object",
      properties: { correlation_id: { type: "string" }, message: { type: "string" } },
      required: ["correlation_id", "message"],
    },
  },
  {
    name: "team_report",
    description:
      "Put a note or a question for the owner in their Needs you tray: a blocker, a decision only they can make, something they should know. It does not wait for an answer; the owner answers, if at all, with a message in your window. Keep it short (at most 4000 characters); at most 3 per turn.",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
  {
    name: "team_propose_tab",
    description:
      "Propose a new tab with a team of its own, for work better done apart from your tab. The owner creates it, changes it or declines it in their Needs you tray, and you are told which; this does not wait. Once it exists, its Orchestrator (a pair: its Lead) is linked to you: team_list shows it, and team_send, team_ask and team_reply work between the two of you. It is given your goal as its first message and sends you its result. A wrong kind, model or role is answered with the list to choose from.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The new tab's name." },
        goal: { type: "string", description: "What the new team should do: its first message, so make it complete." },
        pair: { type: "boolean", description: "True for a pair with no Orchestrator: the first member is the Lead (Code edit), which the others check." },
        orchestrator: {
          type: "object",
          description: "The Orchestrator's AI (not for a pair). Left out: Claude Code with its usual model.",
          properties: { kind: { type: "string" }, model: { type: "string" }, effort: { type: "string" } },
        },
        members: {
          type: "array",
          description: "1 to 7 members; at least one with access \"edit\".",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              access: { type: "string", enum: ["edit", "look"], description: "edit: Code edit, in a folder of its own. look: Code analysis, never writes." },
              kind: { type: "string", description: "Its AI, such as claude-code or codex." },
              model: { type: "string" },
              effort: { type: "string", description: "Its thinking level." },
              role: { type: "string", description: "A role from the library, such as lead or reviewer." },
              note: { type: "string", description: "One line on what it is for." },
            },
            required: ["name", "access"],
          },
        },
      },
      required: ["name", "goal", "members"],
    },
  },
  {
    name: "team_pull",
    description:
      "Bring a teammate's latest committed work into your branch (their uncommitted edits never come along), or, in a GitHub project, the base branch as GitHub has it now: team_pull(from: \"main\"), with the base branch's own name. Your own changes so far are committed first. A clean merge is committed for you; with conflicts, the files are listed: resolve the markers in your turn and the Console commits the merge when the turn ends, or call team_pull_abort.",
    inputSchema: { type: "object", properties: { from: { type: "string", description: "The teammate's name or id, or the base branch's name." } }, required: ["from"] },
  },
  {
    name: "team_pull_abort",
    description: "Abandon a merge from team_pull that has conflicts; your branch goes back to how it was before the pull.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "team_claim",
    description:
      "Tell your teammates you are editing these paths (files, folders or globs such as src/auth/**), with a note. Claude teammates cannot write there until you release them (or the claim expires).",
    inputSchema: {
      type: "object",
      properties: { paths: { type: "array", items: { type: "string" } }, note: { type: "string" } },
      required: ["paths", "note"],
    },
  },
  {
    name: "team_release",
    description: "Release your claims on these paths (or all of them when paths is empty).",
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } } },
  },
  {
    name: "team_hold",
    description:
      "Ask a teammate to hang on: after its current turn, no team messages reach it until you call team_resume (or the owner resumes, or the hold times out).",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, reason: { type: "string" } },
      required: ["to", "reason"],
    },
  },
  {
    name: "team_resume",
    description: "Lift your hold on a teammate.",
    inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
  },
  {
    name: "team_push",
    description:
      "Ask to push your console/ branch to GitHub and open its pull request (the owner approves it). It is pushed after this turn ends and its changes are committed. The Console tells you whether it went out, then the result of GitHub's checks on it once they finish, starting a turn if you are not working; so end your turn instead of waiting. Give the pull request a title and a description in Markdown: what changed and why, the files, the checks you ran, and what the owner should test. If the owner has switched Codex reviews on, a new pull request gets one; on later pushes, set review to true to ask for another.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The pull request's title, at most 120 characters." },
        body: { type: "string", description: "The pull request's description (Markdown)." },
        review: { type: "boolean", description: "Ask Codex to review again when the pull request already exists (only when the owner has switched Codex reviews on)." },
      },
    },
  },
  {
    name: "team_pr",
    description:
      "Read your branch's open pull request on GitHub: its state, whether your newer commits are pushed (and, if your last push failed, why), Codex's review state, every open review thread (with its id) and the conversation, each comment whole with its formatting and a number. With comment (that number) or thread (an id), read just that one in full, however long. Read-only; GitHub projects.",
    inputSchema: {
      type: "object",
      properties: {
        comment: { type: "integer", minimum: 1, description: "A conversation comment's number, to read it in full." },
        thread: { type: "string", description: "A review thread's id, to read all of it." },
      },
    },
  },
  {
    name: "team_checks",
    description:
      "Read the checks GitHub ran on your pull request's latest pushed commit (GitHub Actions: tests, builds, browsers you cannot run here): each job and whether it passed, failed or still runs. With job, the end of that job's log. After your team_push, the Console tells you when these checks finish, so there is no need to keep looking. Commits you have not pushed are not checked.",
    inputSchema: { type: "object", properties: { job: { type: "integer", minimum: 1, description: "A job's number from team_checks, to read the end of its log." } } },
  },
  {
    name: "team_pr_reply",
    description:
      "Answer one review thread on your pull request (the owner approves it): say what you changed and in which commit, or why you are not changing it. resolve: true also resolves the thread. Push the fix with team_push first.",
    inputSchema: {
      type: "object",
      properties: { thread: { type: "string", description: "The thread id team_pr shows." }, message: { type: "string" }, resolve: { type: "boolean" } },
      required: ["thread", "message"],
    },
  },
  {
    name: "team_merge",
    description:
      "Ask for an open pull request to be merged into the base branch (squash and merge): your own, or with pull_request another agent's of your project by its number, which is how a Lead merges several agents' work in the order it needs. The owner approves each merge in their Needs you; the Console then merges it on GitHub at the commit the owner saw. Ask when it is ready: pushed, every check passed (team_checks) and the review answered (team_pr). It is refused, with the reason, when the pull request is not open or is a draft, conflicts with the base branch (bring the base in with team_pull, then push), has a check that failed or still runs, or has commits not pushed yet. This does not wait: the Console tells you the result as soon as it comes, starting a turn if you are not working. Use it instead of asking the owner to merge on GitHub.",
    inputSchema: {
      type: "object",
      properties: { pull_request: { type: "integer", minimum: 1, description: "Another agent's pull request of your project, by its number. Leave it out for your own." } },
    },
  },
  {
    name: "team_read",
    description:
      "Read the rest of a long message you received (a teammate's final message, routed to you or answering your ask, is cut and says so). Give its message_id and offset as the message says. Read-only.",
    inputSchema: {
      type: "object",
      properties: { message_id: { type: "number" }, offset: { type: "number" } },
      required: ["message_id"],
    },
  },
  {
    name: "team_diff",
    description:
      "Read a teammate's work: its branch's changes against the commit it started from, as of its last finished turn (work in a turn still running is not in it). Without path: the changed files and as much of the patch as fits; with path (a file, folder or glob such as src/**): that part's patch. Read-only.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string", description: "The teammate's name or id." }, path: { type: "string" } },
      required: ["from"],
    },
  },
];
export const TEAM_TOOL_NAMES = new Set(TEAM_TOOLS.map((t) => t.name));

/** The team tools offered to one agent: the ones the worker would accept
 * from it, so no schema is paid for in every request's prefix for a call
 * that is always refused. An editing agent claims, and pulls unless its
 * project has no files; only an editing agent of a GitHub project pushes,
 * reads or answers its pull request, and asks for a merge. */
export function teamToolsFor(agent: { permission: "look" | "edit" }, project: { source: "folder" | "none" | "github" } | undefined) {
  const edit = agent.permission === "edit";
  const withFiles = edit && !!project && project.source !== "none";
  const github = edit && project?.source === "github";
  const offered = (name: string) => {
    switch (name) {
      case "team_pull":
        return withFiles;
      // A team needs a project with files, and so does its branches' state.
      case "team_propose_tab":
      case "team_project":
        return !!project && project.source !== "none";
      case "team_claim":
        return edit;
      case "team_push":
      case "team_pr":
      case "team_pr_reply":
      case "team_checks":
      case "team_merge":
        return github;
      default:
        return true;
    }
  };
  return TEAM_TOOLS.filter((t) => offered(t.name));
}

/** The agents' instructions about the team (part of each window's system
 * prompt). */
export const TEAM_NOTE = [
  "",
  "You work in a team of agents in one tab of the Console. Use the console tools:",
  "- team_list to see your teammates;",
  "- team_project to see where every tab of the project stands: each tab's agents and what they are doing, their branches and, in a GitHub project, whether a branch reached GitHub (or why its push failed), its pull request and its checks. Look there before asking the owner to check anything on GitHub. It only reads, and shows no conversation or file of another tab;",
  "- team_send(to, message) to tell a teammate something;",
  "- team_ask(to, message) to ask for something (a review, an answer). It never waits: end your turn, and the answer arrives as your next message;",
  "- team_reply(correlation_id, message) to answer an ask you were given; otherwise your final message answers it;",
  "- team_report(message) to put a blocker, a question or a decision for the owner in their Needs you tray. It does not wait: carry on, or end your turn if you cannot go on without the answer;",
  "- team_diff(from, path?) to read a teammate's committed changes. You cannot open other agents' folders, so use this (or your own folder, if you are Code analysis) instead of asking anyone to paste a patch;",
  "- team_push(title, body) to ask the owner to push your branch and open its pull request, which may then get a Codex review (GitHub projects);",
  "- team_pr to read your pull request (Codex's findings, every comment in full; team_pr(comment: n) or team_pr(thread: id) for one long item), and team_pr_reply(thread, message, resolve) to answer a finding. team_push also replaces the pull request's title and description with the ones you give. team_checks shows the checks GitHub ran on your pull request's latest pushed commit, and team_checks(job: n) the end of a failed job's log: use them for what cannot run in your sandbox (other browsers, a local server). GitHub is reached only through these tools: there is no gh login or token in your sandbox, by design, so do not try gh, curl or the web for it;",
  "- team_merge when your pull request is ready (pushed, every check passed, the review answered): it asks the owner to approve the merge in their Needs you, and the Console then merges it on GitHub (squash). Use it instead of telling the owner to merge on GitHub. team_merge(pull_request: n) asks for another agent's pull request of your project, so a Lead can have several merged in the order it needs. It does not wait; the Console tells you the result as soon as it comes, starting a turn if you are not working, so never promise to watch for it yourself. After your pull request is merged, start your next work with team_pull of the base branch (GitHub projects, Code edit agents);",
  "- team_pull(from) to bring a teammate's committed work into your branch (team_pull_abort to give up a conflicted merge). Your folder has no Git remote and never updates from GitHub by itself: in a GitHub project, team_pull with the base branch's name (usually main) brings in what was merged there since your folder was made. The owner has no button for that, so do not ask them to refresh your folder;",
  "- team_claim(paths, note) before editing shared areas, and team_release when done; respect teammates' claims;",
  "- team_hold(to, reason) to ask a teammate to hang on while you change something, and team_resume(to) afterwards;",
  "- team_propose_tab(name, goal, members) to propose a new tab with a team of its own for work better done apart. The owner creates, changes or declines it, and you are told which. An agent of another tab that team_list shows as linked to you takes team_send and team_ask like a teammate (give its id if its name is also a teammate's); the other team tools work only inside your tab.",
].join("\n");
