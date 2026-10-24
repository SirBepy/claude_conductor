// Shared fixtures for the Projects tab tests: one single-project snapshot and
// one four-repo group snapshot, shaped like the daemon's DashboardSnapshot.
// Fields the daemon always sends (pinned_actions, a row's open flag) are always
// present here too, so a test can never pass on a shape the real wire never has.

const NOW = Date.now();
const min = (n) => NOW - n * 60_000;

export const CONDUCTOR = { cwd: "C:/Projects/conductor", name: "conductor", project_id: "p1" };

export function projectRow(over = {}) {
  return {
    target: { kind: "project", id: "p1", name: "claude_usage_in_taskbar", repos: [CONDUCTOR] },
    last_active_ms: NOW - 10_000,
    live_count: 2, question_count: 1, working_count: 1, open: true, ...over,
  };
}

export const ZIRTUE_REPOS = ["zng-app", "zng-admin", "zng-biller", "zng-api"].map((n, i) => ({
  cwd: `C:/Projects/${n}`, name: n, project_id: `z${i}`,
}));

export function groupRow(over = {}) {
  return {
    target: { kind: "group", id: "g1", name: "Zirtue", repos: ZIRTUE_REPOS },
    last_active_ms: min(4), live_count: 0, question_count: 0, working_count: 1, open: true, ...over,
  };
}

const ship = (cwd, name, branch, ahead, dirty) => ({
  cwd, name, branch, ahead, behind: 0, has_upstream: true, dirty_count: dirty,
  recent_commits: ahead ? [{ short_sha: "dd1af90", message: "phone question sheet", timestamp_ms: min(30), pushed: false }] : [],
});

export function projectSnapshot(over = {}) {
  return {
    target: projectRow().target,
    your_todos: [{ id: "t1", project_id: "p1", text: "Check Console for the haiku call", origin_session_id: null, repo_cwd: CONDUCTOR.cwd, by_ai: true }],
    chats_running: [{ session_id: "s-w", title: "Loop todos cycle 3", status: "working", repo_cwd: CONDUCTOR.cwd, at_ms: min(12) }],
    chats_recent: [{ session_id: "s-old", title: "Phone question sheet peek", status: "ended", repo_cwd: CONDUCTOR.cwd, at_ms: min(40) }],
    plan: [
      { id: "1264", text: "Hyperfocus the mobile todos", section: "Priorities", priority: true, repo_cwd: CONDUCTOR.cwd },
      { id: "506", text: "Android push via FCM", section: "Backlog", priority: false, repo_cwd: CONDUCTOR.cwd },
    ],
    scheduled: [{ id: "sc1", label: "/loop-todos cycle", fire_at_ms: NOW + 3_600_000, repo_cwd: CONDUCTOR.cwd }],
    ship: [ship(CONDUCTOR.cwd, "conductor", "master", 2, 0)],
    servers: [{ name: "vite dev server", port: 1420, repo_cwd: CONDUCTOR.cwd }],
    cards: [], hidden_builtins: [], pinned_actions: [], ...over,
  };
}

/** A custom card. `extra` carries the optional config fields the backend adds (action). */
export const card = (id, title, display, result, enabled = true, extra = {}) => ({
  config: {
    id, scope: { kind: "group", id: "g1" }, title, enabled, refresh_secs: null, display,
    source: { kind: "command", program: "x", args: [], cwd: null, env: {} }, ...extra,
  },
  result,
});

/** A project row the user closed from the Projects list. */
export function closedRow(id = "p9", name = "old_project") {
  return {
    target: { kind: "project", id, name, repos: [{ cwd: `C:/Projects/${name}`, name, project_id: id }] },
    last_active_ms: NOW - 3 * 86_400_000, live_count: 0, question_count: 0, working_count: 0, open: false,
  };
}

/** Five live chats in mixed statuses, in the order the daemon sends them. */
export function mixedChats(cwd = CONDUCTOR.cwd) {
  const c = (session_id, status, m) => ({ session_id, title: session_id, status, repo_cwd: cwd, at_ms: min(m) });
  return [c("work-a", "working", 12), c("ask-a", "question", 2), c("work-b", "working", 5), c("wait-a", "waiting", 25), c("done-a", "your_turn", 9)];
}

/** Six plan items; the first has a long tail after a " - " cut point. */
export function planItems(cwd = CONDUCTOR.cwd) {
  const p = (id, text) => ({ id, text, section: "Phase 1", priority: false, repo_cwd: cwd });
  return [
    p("68", "low priority: Shortcut hygiene - close sc-54841/54746 and decide on a ticket template"),
    p("88", "wire the Amplitude SDK; then add the login events"),
    p("89", "Short one"),
    p("90", "[P] - BP Amplitude team invite / remove events"),
    p("91", "Amplitude overview (insights, nav, Intercom, page-view)"),
    p("87", "SC-54866 header biller logo. Needs the self-scoped token."),
  ];
}

export function groupSnapshot(over = {}) {
  const [app, admin, biller, api] = ZIRTUE_REPOS;
  return {
    target: groupRow().target,
    your_todos: [],
    chats_running: [
      { session_id: "z-q", title: "Release 2.14 notes", status: "your_turn", repo_cwd: app.cwd, at_ms: min(4) },
      { session_id: "z-w", title: "ACH retry backoff", status: "working", repo_cwd: biller.cwd, at_ms: min(3) },
    ],
    chats_recent: [{ session_id: "z-old", title: "Loan export CSV columns", status: "ended", repo_cwd: admin.cwd, at_ms: min(120) }],
    plan: [], scheduled: [],
    ship: [ship(app.cwd, "zng-app", "release/2.14", 3, 0), ship(admin.cwd, "zng-admin", "sc-4810", 0, 0), ship(biller.cwd, "zng-biller", "sc-4821", 1, 2), ship(api.cwd, "zng-api", "main", 0, 0)],
    servers: [],
    cards: [
      card("c1", "Shortcut: my stories", { kind: "list", items_path: "a", label_path: "b", value_path: "c", link_path: null, limit: null },
        { fetched_at_ms: min(6), stats: [], rows: [{ label: "Retry failed ACH payouts", value: "In progress", link: null }], error: null }),
      card("c2", "Logged hours", { kind: "stats", items: [] },
        { fetched_at_ms: min(60), stats: [{ label: "Today", value: "2h 10m" }], rows: [], error: null }),
      card("c3", "Disabled card", { kind: "stats", items: [] }, null, false),
      card("c5", "Shortcut: updates", { kind: "list", items_path: "a", label_path: "b", value_path: "c", link_path: null, limit: null },
        { fetched_at_ms: min(6), stats: [], rows: [{ label: "sc-4821 Retry ACH", value: "Review", link: null }], error: null,
          headline: "12 updates since /shortcut-priorities ran 2d ago" },
        true, { action: { label: "Run /shortcut-priorities", command: "/shortcut-priorities" } }),
      card("c6", "Clockify", { kind: "stats", items: [] },
        { fetched_at_ms: min(9), stats: [], rows: [], error: null,
          progress: { value: 14.5, max: 20, label: "14h 30m of 20h this week", behind: true },
          headline: "3 workdays not logged: Mon, Tue, Wed", headline_tone: "warn" }),
      card("c4", "Broken card", { kind: "stats", items: [] },
        { fetched_at_ms: min(1), stats: [], rows: [], error: "HTTP 401 from the tracker" }),
    ],
    hidden_builtins: [], pinned_actions: [], ...over,
  };
}

export function history(over = {}) {
  return {
    quick_actions: [{ command: "/pushnbump", count: 9 }, { command: "/pickup", count: 4 }],
    outcomes: [{ session_id: "s-old", title: "Phone question sheet peek", text: "Peeking the sheet shows the latest messages.", at_ms: min(40), repo_cwd: CONDUCTOR.cwd }],
    gallery: [{ id: "img1", session_id: "s-old", title: "Code mode diff tab", at_ms: min(50), repo_cwd: CONDUCTOR.cwd }],
    files: [
      { path: "C:/Projects/conductor/docs/multi-machine.md", session_id: "s-old", chat_title: "Federation gaps", at_ms: min(300), exists: true, repo_cwd: CONDUCTOR.cwd },
      { path: "C:/Projects/conductor/gone.pdf", session_id: "s-old", chat_title: "Release", at_ms: min(900), exists: false, repo_cwd: CONDUCTOR.cwd },
    ],
    ...over,
  };
}
