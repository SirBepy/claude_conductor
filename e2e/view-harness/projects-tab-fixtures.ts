// Fixture data for projects-tab.view.spec.ts: a realistic single-project
// snapshot and a four-repo group with a Shortcut-style list card and a
// Clockify-style stats card, typed against the dashboard contract so a field
// change there fails typecheck here instead of rotting the spec.
import type {
  CardConfig, DashboardHistory, DashboardListRow, DashboardSnapshot, DashboardTarget, RepoShip,
} from "../../src/views/sessions/projects-tab/types";

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

export const LIST_ROWS: DashboardListRow[] = [
  { target: CONDUCTOR, last_active_ms: Date.now() - 20_000, live_count: 2, question_count: 1, working_count: 1 },
  { target: ZIRTUE, last_active_ms: min(4), live_count: 2, question_count: 1, working_count: 1 },
  {
    target: { kind: "project", id: "p-soccer", name: "head_soccer_v_fable_oneshot", repos: [{ cwd: "C:/Projects/head_soccer", name: "head_soccer_v_fable_oneshot", project_id: "p-soccer" }] },
    last_active_ms: min(12), live_count: 1, question_count: 0, working_count: 1,
  },
  { target: { kind: "project", id: "p-dash", name: "dashboard-a", repos: [{ cwd: "C:/Projects/dashboard-a", name: "dashboard-a", project_id: "p-dash" }] }, last_active_ms: min(65), live_count: 0, question_count: 0, working_count: 0 },
  { target: { kind: "project", id: "p-count", name: "countoff", repos: [{ cwd: "C:/Projects/countoff", name: "countoff", project_id: "p-count" }] }, last_active_ms: min(60 * 26), live_count: 0, question_count: 0, working_count: 0 },
];

const ship = (cwd: string, name: string, branch: string, ahead: number, dirty: number, commits: RepoShip["recent_commits"] = []): RepoShip => ({
  cwd, name, branch, ahead, behind: 0, has_upstream: true, dirty_count: dirty, recent_commits: commits,
});

export function conductorSnapshot(): DashboardSnapshot {
  return {
    target: CONDUCTOR,
    needs_you: [
      { kind: "question", title: "Projects dashboard brainstorm", detail: "is waiting on your answer", session_id: "s-q", draft_id: null, repo_cwd: CONDUCTOR_CWD, at_ms: min(2) },
      { kind: "draft", title: "reply to the release thread", detail: "", session_id: "s-q", draft_id: "d-1", repo_cwd: CONDUCTOR_CWD, at_ms: min(60) },
    ],
    your_todos: [
      { id: "t1", project_id: "p-conductor", text: "Check Console for the 21:45 UTC haiku call on key test2", origin_session_id: "s-q", repo_cwd: CONDUCTOR_CWD, by_ai: true },
    ],
    chats_running: [
      { session_id: "s-w", title: "Loop todos: cycle 3", status: "working", repo_cwd: CONDUCTOR_CWD, at_ms: min(12) },
      { session_id: "s-q", title: "Projects dashboard brainstorm", status: "your_turn", repo_cwd: CONDUCTOR_CWD, at_ms: min(2) },
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
    peers_active: 3,
    last_channel_message: { author: "peer-2", text: "holding commit on chat-renderer.ts", at_ms: min(4) },
    cards: [], hidden_builtins: [],
  };
}

export function zirtueSnapshot(): DashboardSnapshot {
  const [app, admin, biller, api] = ZIRTUE_CWDS as [string, string, string, string];
  const listDisplay: CardConfig["display"] = { kind: "list", items_path: "stories", label_path: "name", value_path: "state", link_path: null, limit: 5 };
  const statsDisplay: CardConfig["display"] = { kind: "stats", items: [] };
  const cfg = (id: string, title: string, display: CardConfig["display"]): CardConfig => ({
    id, title, display, enabled: true, refresh_secs: null,
    scope: { kind: "group", id: ZIRTUE.id } as const,
    source: { kind: "http", method: "GET", url: "https://api.app.shortcut.com/api/v3/search", headers: {}, body: null } as const,
  });
  return {
    target: ZIRTUE,
    needs_you: [
      { kind: "question", title: "Release 2.14 notes", detail: "is waiting on your answer", session_id: "z-q", draft_id: null, repo_cwd: app, at_ms: min(4) },
      { kind: "draft", title: "standup note", detail: "", session_id: "z-q", draft_id: "d-z", repo_cwd: app, at_ms: min(35) },
    ],
    your_todos: [],
    chats_running: [
      { session_id: "z-q", title: "Release 2.14 notes", status: "your_turn", repo_cwd: app, at_ms: min(4) },
      { session_id: "z-w", title: "ACH retry backoff", status: "working", repo_cwd: biller, at_ms: min(3) },
    ],
    chats_recent: [
      { session_id: "zh1", title: "Loan export CSV columns", status: "ended", repo_cwd: admin, at_ms: min(120) },
      { session_id: "zh2", title: "Quote endpoint load test", status: "ended", repo_cwd: api, at_ms: min(60 * 26) },
    ],
    plan: [], scheduled: [],
    ship: [
      ship(app, "zng-app", "release/2.14", 3, 0),
      ship(admin, "zng-admin", "sc-4810", 0, 0),
      ship(biller, "zng-biller", "sc-4821", 1, 2),
      ship(api, "zng-api", "main", 0, 0),
    ],
    servers: [], peers_active: 0, last_channel_message: null,
    cards: [
      {
        config: cfg("c-sc", "Shortcut \u00B7 my stories", listDisplay),
        result: {
          fetched_at_ms: min(6), error: null, stats: [],
          rows: [
            { label: "sc-4821 Retry failed ACH payouts", value: "In progress", link: null },
            { label: "sc-4810 Loan export as CSV", value: "Review", link: null },
            { label: "sc-4807 Rate-limit the public quote endpoint", value: "Ready", link: null },
            { label: "sc-4799 Onboarding copy pass", value: "Done", link: null },
          ],
        },
      },
      {
        config: cfg("c-ck", "Logged hours", statsDisplay),
        result: {
          fetched_at_ms: min(60), error: null, rows: [],
          stats: [
            { label: "Today", value: "2h 10m" }, { label: "Yesterday", value: "not logged" },
            { label: "This week", value: "14h 30m" }, { label: "zng-biller", value: "6h 20m" },
          ],
        },
      },
    ],
    hidden_builtins: [],
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
