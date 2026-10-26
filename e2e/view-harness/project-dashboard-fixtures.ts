// Fixture data for project-dashboard.view.spec.ts: a realistic single-project
// snapshot and a four-repo group with a Shortcut-style list card and a
// Clockify-style stats card, typed against the dashboard contract so a field
// change there fails typecheck here instead of rotting the spec.
import type {
  CardConfig, CardConfigX, CardResultX, DashboardHistory, DashboardTarget, DashSnapshot, ListRow, RepoShip, TodoStats,
} from "../../src/views/sessions/project-dashboard/types";

export const CONDUCTOR_CWD = "C:/Projects/claude_usage_in_taskbar";
export const ZIRTUE_CWDS = ["zng-app", "zng-admin", "zng-biller", "zng-api"].map((n) => `C:/Projects/${n}`);

const min = (n: number): number => Date.now() - n * 60_000;

export const CONDUCTOR: DashboardTarget = {
  kind: "project", id: "p-conductor", name: "claude_usage_in_taskbar",
  repos: [{ cwd: CONDUCTOR_CWD, name: "claude_usage_in_taskbar", project_id: "p-conductor" }],
};

export const ZIRTUE: DashboardTarget = {
  kind: "group", id: "g-zirtue", name: "Zirtue",
  repos: ZIRTUE_CWDS.map((cwd, i) => ({ cwd, name: cwd.split("/").pop()!, project_id: `p-z${i}` })),
};

export const LIST_ROWS: ListRow[] = [
  { target: CONDUCTOR, last_active_ms: Date.now() - 20_000, live_count: 2, question_count: 1, working_count: 1 },
  { target: ZIRTUE, last_active_ms: min(4), live_count: 2, question_count: 1, working_count: 1 },
  {
    target: { kind: "project", id: "p-soccer", name: "head_soccer_v_fable_oneshot", repos: [{ cwd: "C:/Projects/head_soccer", name: "head_soccer_v_fable_oneshot", project_id: "p-soccer" }] },
    last_active_ms: min(12), live_count: 1, question_count: 0, working_count: 1,
  },
  { target: { kind: "project", id: "p-dash", name: "dashboard-a", repos: [{ cwd: "C:/Projects/dashboard-a", name: "dashboard-a", project_id: "p-dash" }] }, last_active_ms: min(65), live_count: 0, question_count: 0, working_count: 0 },
  // Idle projects with no live chats.
  ...[["p-count", "countoff"], ["p-sahur", "sahur_starting_point"], ["p-stop", "annoying_stopwatch"]].map(([id, name], i): ListRow => ({
    target: { kind: "project", id: id!, name: name!, repos: [{ cwd: `C:/Projects/${name}`, name: name!, project_id: id! }] },
    last_active_ms: min(60 * 26 * (i + 1)), live_count: 0, question_count: 0, working_count: 0,
  })),
];

// [created, done, open] for forty days ending today, taken from this repo's
// own .claude/todos/ on 2026-10-26, so the screenshots show real-shaped data:
// quiet days, and big batches in and out.
const TODO_DAYS: Array<[number, number, number]> = [
  [0, 0, 29], [0, 0, 29], [0, 0, 29], [0, 0, 29], [0, 0, 29], [9, 0, 38], [7, 0, 45], [10, 1, 54], [9, 15, 48], [15, 23, 40],
  [4, 0, 44], [15, 1, 58], [18, 19, 57], [24, 21, 60], [10, 25, 45], [12, 28, 29], [6, 1, 34], [6, 0, 40], [7, 0, 47], [35, 36, 46],
  [4, 34, 16], [14, 12, 18], [0, 0, 18], [0, 0, 18], [0, 0, 18], [0, 0, 18], [6, 8, 16], [5, 2, 19], [1, 0, 20], [11, 10, 21],
  [13, 7, 27], [47, 9, 65], [17, 38, 44], [33, 35, 42], [17, 36, 23], [6, 10, 19], [30, 37, 12], [25, 18, 19], [31, 29, 21], [4, 0, 25],
];

function todoStats(): TodoStats {
  const days = TODO_DAYS.map(([created, done, open], i) => ({
    date: new Date(Date.now() - (TODO_DAYS.length - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    created, done, open,
  }));
  return { days, open_now: 25, claimed_now: 1 };
}

const EMPTY_TODO_STATS: TodoStats = { days: [], open_now: 0, claimed_now: 0 };

const ship = (cwd: string, name: string, branch: string, ahead: number, dirty: number, commits: RepoShip["recent_commits"] = []): RepoShip => ({
  cwd, name, branch, ahead, behind: 0, has_upstream: true, dirty_count: dirty, recent_commits: commits,
});

const PINNED_CONDUCTOR = ["/pickup", "/autopilot", "/plan-todos", "/batch-todos", "/code-check", "/audit", "/recall", "/status", "/e2e", "/deploy"];
const PINNED_ZIRTUE = [
  "/shortcut-priorities", "/clockify-reconciliator", "/ticket", "/pickup", "/flutter-e2e", "/shortcut-done-audit",
  "/zirtue-release-backfill", "/work-recap", "/obsidian-pickup-ticket",
];

export function conductorSnapshot(): DashSnapshot {
  return {
    target: CONDUCTOR,
    your_todos: [
      { id: "t1", project_id: "p-conductor", text: "Check Console for the 21:45 UTC haiku call on key test2", origin_session_id: "s-q", repo_cwd: CONDUCTOR_CWD, by_ai: true },
    ],
    chats_running: [
      { session_id: "s-w", title: "Loop todos: cycle 3", status: "working", repo_cwd: CONDUCTOR_CWD, at_ms: min(12) },
      { session_id: "s-q", title: "Projects dashboard brainstorm", status: "question", repo_cwd: CONDUCTOR_CWD, at_ms: min(2) },
      { session_id: "s-w2", title: "Phone question sheet follow-up", status: "working", repo_cwd: CONDUCTOR_CWD, at_ms: min(5) },
      { session_id: "s-wait", title: "Release CI watch", status: "waiting", repo_cwd: CONDUCTOR_CWD, at_ms: min(25) },
      { session_id: "s-done", title: "Hidden chats offline owner", status: "your_turn", repo_cwd: CONDUCTOR_CWD, at_ms: min(9) },
    ],
    chats_recent: [
      { session_id: "h1", title: "Phone question sheet peek", status: "ended", repo_cwd: CONDUCTOR_CWD, at_ms: min(40) },
      { session_id: "h2", title: "Hidden chats offline owner", status: "ended", repo_cwd: CONDUCTOR_CWD, at_ms: min(120) },
      { session_id: "h3", title: "claude.ai publish guard", status: "ended", repo_cwd: CONDUCTOR_CWD, at_ms: min(180) },
    ],
    plan: [
      { id: "1264", text: "Hyperfocus the mobile/Android todos with the phone on USB", section: "Priorities", priority: true, repo_cwd: CONDUCTOR_CWD },
      { id: "926", text: "Turn result line sometimes never arrives", section: "Priorities", priority: true, repo_cwd: CONDUCTOR_CWD },
      { id: "506", text: "Android push via FCM", section: "Blocked", priority: false, repo_cwd: CONDUCTOR_CWD },
    ],
    todo_stats: todoStats(),
    scheduled: [
      { id: "sc1", label: "/loop-todos cycle", fire_at_ms: Date.now() + 5 * 3_600_000, repo_cwd: CONDUCTOR_CWD },
      { id: "sc2", label: "Check release CI", fire_at_ms: Date.now() + 26 * 3_600_000, repo_cwd: CONDUCTOR_CWD },
    ],
    ship: [ship(CONDUCTOR_CWD, "claude_usage_in_taskbar", "master", 2, 0, [
      { short_sha: "dd1af90", message: "phone question sheet shows latest messages", timestamp_ms: min(30), pushed: false },
      { short_sha: "2c23674", message: "hidden-chats pre-check comment", timestamp_ms: min(80), pushed: false },
      { short_sha: "1ca182f", message: "option-preview card waits on image read", timestamp_ms: min(200), pushed: true },
      { short_sha: "714fa30", message: "claude.ai publish trusts verified result", timestamp_ms: min(300), pushed: true },
    ])],
    servers: [{ name: "vite dev server", port: 1420, repo_cwd: CONDUCTOR_CWD }],
    cards: [], hidden_builtins: [], pinned_actions: PINNED_CONDUCTOR,
  };
}

export function zirtueSnapshot(): DashSnapshot {
  const [app, admin, biller, api] = ZIRTUE_CWDS as [string, string, string, string];
  const listDisplay: CardConfig["display"] = { kind: "list", items_path: "stories", label_path: "name", value_path: "state", link_path: null, limit: 5 };
  const statsDisplay: CardConfig["display"] = { kind: "stats", items: [] };
  const cfg = (id: string, title: string, display: CardConfig["display"]): CardConfigX => ({
    id, title, display, enabled: true, refresh_secs: null, action: null,
    scope: { kind: "group", id: ZIRTUE.id } as const,
    source: { kind: "http", method: "GET", url: "https://api.app.shortcut.com/api/v3/search", headers: {}, body: null } as const,
  });
  const withAction = (c: CardConfigX, label: string, command: string): CardConfigX => ({ ...c, action: { label, command } });
  return {
    target: ZIRTUE,
    your_todos: [],
    chats_running: [
      { session_id: "z-q", title: "Release 2.14 notes", status: "question", repo_cwd: app, at_ms: min(4) },
      { session_id: "z-w", title: "ACH retry backoff", status: "working", repo_cwd: biller, at_ms: min(3) },
    ],
    chats_recent: [
      { session_id: "zh1", title: "Loan export CSV columns", status: "ended", repo_cwd: admin, at_ms: min(120) },
      { session_id: "zh2", title: "Quote endpoint load test", status: "ended", repo_cwd: api, at_ms: min(60 * 26) },
      { session_id: "zh3", title: "Biller invite email copy", status: "ended", repo_cwd: biller, at_ms: min(60 * 30) },
      { session_id: "zh4", title: "Payout retry dashboards", status: "ended", repo_cwd: biller, at_ms: min(60 * 48) },
      { session_id: "zh5", title: "Release 2.13 hotfix", status: "ended", repo_cwd: app, at_ms: min(60 * 72) },
      { session_id: "zh6", title: "Admin role audit", status: "ended", repo_cwd: admin, at_ms: min(60 * 96) },
    ],
    plan: [
      { id: "68", text: "low priority: Shortcut hygiene, close sc-54841/54746, decide on a ticket template", section: "Phase 1 - start now", priority: false, repo_cwd: admin },
      { id: "88", text: "wire the Amplitude SDK into zng-biller", section: "Phase 1 - start now", priority: false, repo_cwd: biller },
      { id: "89", text: "[P] - BP Amplitude login / email-verify / logout events", section: "Phase 1 - start now", priority: false, repo_cwd: biller },
      { id: "90", text: "[P] - BP Amplitude team invite / remove events", section: "Phase 1 - start now", priority: false, repo_cwd: biller },
      { id: "91", text: "[P] - BP Amplitude overview / insights / nav / Intercom / page-view events", section: "Phase 1 - start now", priority: false, repo_cwd: biller },
      { id: "87", text: "[P] - SC-54866 header biller logo (needs stevan's self-scoped token)", section: "Phase 2 - blocked on others", priority: false, repo_cwd: biller },
    ],
    todo_stats: EMPTY_TODO_STATS,
    scheduled: [],
    ship: [
      ship(app, "zng-app", "release/2.14", 3, 0),
      ship(admin, "zng-admin", "sc-4810", 0, 0),
      ship(biller, "zng-biller", "sc-4821", 1, 2),
      ship(api, "zng-api", "main", 0, 0),
    ],
    servers: [],
    cards: [
      {
        config: withAction(cfg("c-sc", "Shortcut · my stories", listDisplay), "Run /shortcut-priorities", "/shortcut-priorities"),
        result: {
          fetched_at_ms: min(6), error: null, stats: [], headline_tone: null, progress: null,
          headline: "12 updates since /shortcut-priorities ran 2d ago",
          rows: [
            { label: "sc-4821 Retry failed ACH payouts", value: "In progress", link: null },
            { label: "sc-4810 Loan export as CSV", value: "Review", link: null },
            { label: "sc-4807 Rate-limit the public quote endpoint", value: "Ready", link: null },
          ],
        } as CardResultX,
      },
      {
        config: withAction(cfg("c-ck", "Clockify", statsDisplay), "Run /clockify-reconciliator", "/clockify-reconciliator"),
        result: {
          fetched_at_ms: min(60), error: null, rows: [], stats: [],
          progress: { value: 14.5, max: 20, label: "14h 30m of 20h this week", behind: true },
          headline: "3 workdays not logged: Mon, Tue, Wed", headline_tone: "warn",
        } as CardResultX,
      },
    ],
    hidden_builtins: [], pinned_actions: PINNED_ZIRTUE,
  };
}

export function conductorHistory(): DashboardHistory {
  return {
    quick_actions: [
      { command: "/pushnbump", count: 14 }, { command: "/pickup", count: 9 }, { command: "/autopilot", count: 6 },
      { command: "/code-check", count: 5 }, { command: "/wdio-sweep", count: 3 },
    ],
    outcomes: [
      { session_id: "h1", title: "Phone question sheet peek", text: "Peeking the question sheet now shows the latest messages, and the composer no longer shows through it. Shipped in dd1af90, vitest and typecheck green.", at_ms: min(40), repo_cwd: CONDUCTOR_CWD },
      { session_id: "h3", title: "claude.ai publish guard", text: "Publish only trusts a verified tool result and refuses a second concurrent publish of the same preview. Not pushed yet.", at_ms: min(180), repo_cwd: CONDUCTOR_CWD },
      { session_id: "h2", title: "Hidden chats offline owner", text: "An update now names every owner up front, so an offline owner fails it before anything is applied. One wdio spec still to run.", at_ms: min(60 * 26), repo_cwd: CONDUCTOR_CWD },
    ],
    gallery: ["Code mode diff tab", "Projects list, populated", "Account chip on phone", "Unpushed changes", "@-mention picker", "Clean titlebar"]
      .map((title, i) => ({ id: `img-${i}`, session_id: "h1", title, at_ms: min(50 + i * 30), repo_cwd: CONDUCTOR_CWD })),
    files: [
      { path: `${CONDUCTOR_CWD}/.for_bepy/mockups/mockup-drafts-live.html`, session_id: "h1", chat_title: "Drafts redesign", at_ms: min(60 * 48), exists: true, repo_cwd: CONDUCTOR_CWD },
      { path: `${CONDUCTOR_CWD}/docs/multi-machine.md`, session_id: "h2", chat_title: "Federation gaps", at_ms: min(60 * 24 * 14), exists: true, repo_cwd: CONDUCTOR_CWD },
      { path: `${CONDUCTOR_CWD}/Conductor-demo.pptx`, session_id: "h3", chat_title: "Demo deck", at_ms: min(60 * 24 * 21), exists: true, repo_cwd: CONDUCTOR_CWD },
      { path: `${CONDUCTOR_CWD}/release-notes-0.2.130.pdf`, session_id: "h3", chat_title: "Release", at_ms: min(60 * 24 * 4), exists: false, repo_cwd: CONDUCTOR_CWD },
    ],
  };
}

export function zirtueHistory(): DashboardHistory {
  return {
    quick_actions: [{ command: "/ticket", count: 12 }, { command: "/commit push", count: 8 }, { command: "/flutter-e2e", count: 4 }, { command: "/linear", count: 3 }],
    outcomes: [
      { session_id: "zh1", title: "Loan export CSV columns", text: "Export now includes the payoff date and borrower state. PR open against admin, e2e green.", at_ms: min(120), repo_cwd: ZIRTUE_CWDS[1]! },
      { session_id: "zh2", title: "Quote endpoint load test", text: "p95 holds under 180ms at 50 rps. Above that the DB pool saturates; ticket filed.", at_ms: min(60 * 26), repo_cwd: ZIRTUE_CWDS[3]! },
    ],
    gallery: [], files: [],
  };
}

/** A small SVG standing in for a screenshot; distinct colours so thumbnails are tellable apart. */
export function fakeShot(i: number): string {
  const hues = [28, 200, 140, 330, 50, 260];
  const h = hues[i % hues.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="hsl(${h},25%,16%)"/><rect x="24" y="24" width="592" height="40" rx="8" fill="hsl(${h},35%,26%)"/><rect x="24" y="84" width="180" height="292" rx="8" fill="hsl(${h},30%,22%)"/><rect x="224" y="84" width="392" height="120" rx="8" fill="hsl(${h},60%,48%)" opacity=".7"/><rect x="224" y="224" width="392" height="152" rx="8" fill="hsl(${h},30%,24%)"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
