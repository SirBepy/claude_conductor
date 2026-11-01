// asserts: src/styles/tokens.css, src/styles/base.css, src/styles/inputs.css, src/styles/color-picker.css, src/styles/settings-sections.css
import { expect, test, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// Joe, 2026-11-02: "I don't like that we have so many different sizes for things ... I like it all to be
// consistent." Every field, select, text button and icon button on the main screens is one control height
// (--control-h in tokens.css: 36px, 44px on a phone). This measures the rendered boxes, so a new rule that
// sets its own number for a control fails here instead of being noticed by eye months later.

test.setTimeout(240_000);

const ACCT = {
  id: "acct-sub", label: "Personal", colour: "#8b5cf6", icon: "user", config_dir: "", chrome_profile_dir: "",
  email: "joe@example.com", org_uuid: "org-1", subscription_tier: "claude_max", created_at: "2026-01-01T00:00:00Z",
  fleet_eligible: false, kind: "subscription",
};
const INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_accounts: [ACCT],
  get_account_identity: { oauthAccount: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, hasCookie: false, drift: false, driftMessage: null },
  get_auth_state_map: {}, get_terminal_identity: null, list_api_keys: [], get_api_credit_status: {}, get_app_version: "0.2.137",
  get_storage_info: [], piper_status: { installed: true, voices: [] }, list_audio_output_devices: [{ name: "Speakers", is_default: true }],
  get_gaming_mode: { on: false, paused_sessions: 0, stopped_procs: 0, stopped_containers: 0, docker_desktop_stopped: false },
  get_default_whitelist: [], list_characters: [], remote_access_status: { enabled: true },
  remote_access_qr: { svg: "<svg width='80' height='80'></svg>", url: "http://x/pair", iroh: null },
  list_remote_devices: [], list_machines: { self: { machine_id: "m0", label: "Desktop", os: "windows" }, peers: [] },
  list_auto_accept: [], list_wrap_up_on_done: [], get_settings_load_notice: null,
};

const VIEWS = [
  "settings", "settings-appearance", "settings-notifications", "settings-chat-defaults", "settings-accounts",
  "settings-shortcuts", "settings-permissions", "settings-remote-access", "settings-data", "settings-about",
  "settings-voice", "settings-browser", "settings-power", "settings-usage-meter", "settings-characters",
  "characters", "history", "dashboard", "schedule",
];

/** Controls that are deliberately not one control height, each with its reason. A new entry needs a reason a
 *  reviewer would accept: "it was already that size" is not one. */
const EXEMPT = [
  // Text that happens to be a button: sized by its line of text, not a target.
  ".sched-w-open", ".btn-link-muted", ".ps-revert",
  // A name that edits in place, drawn as plain text until hovered.
  "input.ra-name-input",
  // Caller-sized glyph targets in dense rows; the class exists to say "not a control-height button".
  ".icon-btn-sq",
  // Segments inside a segmented switch: the switch itself (.view-toggle, .tp-seg) is measured and is control-h.
  ".view-toggle button", ".tp-seg button",
  // The working strip above the composer: a status line with a hover Stop, on its own 28px / 40px-touch line.
  ".thinking-main", ".thinking-pause-btn",
  // Floating action button: a free-standing target, sized by its own dial, not a row control.
  ".fab-dial-fab",
  // The header's wrap-up glyph is 16px, text-sized. A small tap target on a phone, kept out of this sweep.
  ".wrap-up-btn",
].join(", ");

interface Offender { sig: string; h: number }

async function offenders(page: Page): Promise<{ want: number; bad: Offender[] }> {
  return page.evaluate((exempt) => {
    const want = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--control-h"));
    const SEL = "button, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=hidden]), select, .view-toggle, .tp-seg";
    const bad: { sig: string; h: number }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(SEL))) {
      if (el.matches(exempt)) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width < 4 || r.height < 4 || cs.visibility === "hidden") continue;
      // A control inside a closed popover/overlay has no box of its own; off-screen ones are not on the screen.
      if (r.bottom < 0 || r.right < 0) continue;
      if (Math.abs(r.height - want) > 0.6) {
        const cls = typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).join(".") : "";
        bad.push({ sig: `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`, h: Math.round(r.height * 10) / 10 });
      }
    }
    return { want, bad };
  }, EXEMPT);
}

const summarise = (bad: Offender[]) => [...new Set(bad.map((b) => `${b.sig} ${b.h}px`))].sort();

for (const [label, size] of [["desktop", { width: 1200, height: 900 }], ["phone", { width: 393, height: 852 }]] as const) {
  test.describe(`view-harness / one control height (${label})`, () => {
    test.use({ viewport: size });

    for (const view of VIEWS) {
      test(`${view}: every field, select and button is --control-h`, async ({ page }) => {
        await mountView(page, { view, invoke: INVOKE });
        await page.waitForTimeout(1200);
        const { want, bad } = await offenders(page);
        expect(want).toBe(label === "phone" ? 44 : 36);
        expect(summarise(bad)).toEqual([]);
      });
    }

    test("chat: composer, Send, header buttons and the rest of the pane", async ({ page }) => {
      const sess = sessionInstance({ busy: true, awaiting: null });
      await mountView(page, {
        view: "sessions",
        invoke: { ...INVOKE, list_instances: [sess], get_active_sessions: [sess], load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false } },
      });
      await page.locator("#sessions-list li[data-session-id]").first().click();
      await page.locator("#session-pane .session-composer").first().waitFor();
      await waitForPaneSettled(page);
      const { bad } = await offenders(page);
      expect(summarise(bad)).toEqual([]);
    });
  });
}
