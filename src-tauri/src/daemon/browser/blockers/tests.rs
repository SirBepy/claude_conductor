use super::*;

/// A Playwright MCP result: open tabs, the page, then the snapshot.
fn result(url: &str, title: &str, snapshot: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": format!(
        "### Open tabs\n- 0: (current) [{title}]({url})\n### Page\n- Page URL: {url}\n- Page Title: {title}\n### Snapshot\n```yaml\n{snapshot}\n```"
    ) }] })
}

fn kind_of(v: &Verdict) -> Option<Kind> {
    match v {
        Verdict::Block(b) => Some(b.kind),
        _ => None,
    }
}

const GOOGLE_SIGN_IN: &str = "- heading \"Sign in\" [level=1]\n- textbox \"Email or phone\" [ref=e5]\n- button \"Next\" [ref=e9]";
const ROBLOX_2SV: &str = "- heading \"2-Step Verification\" [level=2]\n- text: Enter the 6-digit code from your authenticator app\n- textbox \"Enter Code\" [ref=e12]\n- button \"Verify\" [ref=e14]";
const ROBLOX_2SV_UNNAMED_BOX: &str = "- heading \"2-Step Verification\" [level=2]\n- text: Enter the 6-digit code from your authenticator app\n- textbox [ref=e12]\n- button \"Verify\" [ref=e14]";

/// Real-shaped pages that need Joe, each a strong signal.
#[test]
fn a_page_that_waits_on_joe_blocks() {
    let table = [
        ("google sign-in url", result("https://accounts.google.com/v3/signin/identifier?flowName=GlsSignIn", "Sign in", GOOGLE_SIGN_IN), Kind::SignIn),
        ("google oauth consent", result("https://accounts.google.com/o/oauth2/v2/auth?client_id=x", "Choose an account", "- heading \"Choose an account\""), Kind::SignIn),
        ("google signin challenge", result("https://accounts.google.com/v3/signin/challenge/totp", "2-Step Verification", "- heading"), Kind::SignIn),
        ("google challenge", result("https://accounts.google.com/challenge/totp", "x", "-"), Kind::TwoStep),
        ("paypal sign-in", result("https://www.paypal.com/signin?returnUri=x", "Log in to your PayPal account", "- textbox \"Email or mobile number\""), Kind::SignIn),
        ("paypal checkout", result("https://www.paypal.com/checkoutnow?token=EC-1", "PayPal Checkout", "- button \"Pay Now\""), Kind::SignIn),
        ("microsoft", result("https://login.microsoftonline.com/common/oauth2/authorize", "Sign in to your account", "- heading"), Kind::SignIn),
        ("roblox login", result("https://www.roblox.com/login", "Log in to Roblox", "- textbox \"Username/Email/Phone\""), Kind::SignIn),
        ("roblox 2sv by words", result("https://www.roblox.com/home", "Roblox", ROBLOX_2SV), Kind::TwoStep),
        ("roblox 2sv with an unnamed code box", result("https://www.roblox.com/home", "Roblox", ROBLOX_2SV_UNNAMED_BOX), Kind::TwoStep),
        (
            "arkose frame",
            result("https://www.roblox.com/home", "Roblox", "- iframe [ref=e3]:\n  - /url: https://roblox-api.arkoselabs.com/fc/gc/?token=1"),
            Kind::Captcha,
        ),
        ("recaptcha challenge", result("https://example.com/form", "Form", "- iframe \"reCAPTCHA\" [ref=e2]:\n  - checkbox \"I'm not a robot\""), Kind::Captcha),
        (
            "cloudflare challenge",
            result("https://example.com", "Just a moment...", "- iframe [ref=e2]:\n  - /url: https://challenges.cloudflare.com/cdn-cgi/x\n  - checkbox \"Verify you are human\""),
            Kind::Captcha,
        ),
    ];
    for (name, r, kind) in table {
        assert_eq!(kind_of(&detect(&r)), Some(kind), "{name}");
    }
}

#[test]
fn a_sign_in_popup_in_the_tab_list_blocks_while_the_page_is_fine() {
    let r = json!({ "content": [{ "type": "text", "text":
        "### Open tabs\n- 0: (current) [Checkout](https://shop.example.com/pay)\n- 1: [Log in to your PayPal account](https://www.paypal.com/webapps/hermes?token=1)\n### Page\n- Page URL: https://shop.example.com/pay\n- Page Title: Checkout\n### Snapshot\n```yaml\n- button \"Pay with PayPal\"\n```" }] });
    let Verdict::Block(b) = detect(&r) else { panic!("popup tab must block") };
    assert_eq!((b.kind, b.origin.as_str(), b.site.as_str()), (Kind::SignIn, "www.paypal.com", "PayPal"));
}

#[test]
fn a_tab_held_by_the_password_manager_blocks_with_its_own_wording() {
    let r = json!({ "content": [{ "type": "text", "text": "Error: Cannot access a chrome-extension:// URL of different extension" }] });
    let Verdict::Block(b) = detect(&r) else { panic!("must block") };
    assert_eq!(b.kind, Kind::PasswordManager);
    assert!(b.message().contains("password manager menu is open"), "{}", b.message());
}

/// Pages that mention the topic and must never gate.
#[test]
fn look_alike_pages_do_not_gate() {
    let table = [
        (
            "2fa settings page",
            result("https://myaccount.google.com/signinoptions/twosv", "2-Step Verification", "- heading \"2-Step Verification\"\n- link \"Authenticator app\"\n- button \"Turn on 2-Step Verification\""),
        ),
        (
            "blog about passwords",
            result("https://blog.example.com/passwords", "Why passwords fail", "- heading \"Why passwords fail\"\n- paragraph: Use a password manager. Never reuse a password. Sign in with passkeys."),
        ),
        (
            "google search results",
            result("https://www.google.com/search?q=roblox+login", "roblox login - Google Search", "- searchbox \"Search\"\n- link \"Roblox Log In\" [ref=e8]\n- link \"Sign in\" [ref=e9]"),
        ),
        (
            "change password settings",
            result("https://example.com/settings", "Settings", "- heading \"Security\"\n- link \"Sign in history\"\n- textbox \"Current password\"\n- textbox \"New password\""),
        ),
        ("a plain page", result("https://example.com", "Example Domain", "- heading \"Example Domain\"")),
        ("search box beside two-step wording", result("https://help.example.com", "Help", "- searchbox \"Search\"\n- text: Set up an authenticator app")),
        (
            "card form with a security code",
            result("https://shop.example.com/pay", "Pay", "- textbox \"Card number\"\n- textbox \"Security code\"\n- text: Enter the code on the back of your card"),
        ),
        (
            "coupon box",
            result("https://shop.example.com/cart", "Cart", "- textbox \"Promo code\"\n- text: Enter the code and we take 10% off your verification code"),
        ),
        (
            "unnamed chat box on a page about two-factor",
            result("https://docs.example.com/mfa", "MFA docs", "- paragraph: Turn on two-factor with an authenticator app.\n- textbox [ref=e3]"),
        ),
        (
            "country-code box and verification wording on a signup form",
            result("https://shop.example.com/signup", "Sign up", "- textbox \"Country code\"\n- textbox \"Search digital products\"\n- text: We send a verification code by two-factor"),
        ),
        (
            "a link to arkose outside any frame",
            result("https://docs.example.com/bots", "Bots", "- link \"Arkose Labs\":\n  - /url: https://www.arkoselabs.com/\n- link \"funcaptcha solver\":\n  - /url: https://github.com/x/funcaptcha-solver"),
        ),
        (
            "an issue thread quoting the extension error",
            result(
                "https://github.com/x/y/issues/1",
                "Issue",
                &format!("- paragraph: Cannot access a chrome-extension:// URL of different extension\n{}", "- paragraph: filler text to make the page long.\n".repeat(20)),
            ),
        ),
        ("apple account page", result("https://appleid.apple.com/account/manage", "Manage", "- heading \"Manage your account\"")),
        (
            "invisible recaptcha badge",
            result("https://example.com/contact", "Contact", "- iframe [ref=e9]:\n  - /url: https://www.google.com/recaptcha/api2/anchor?k=1\n- textbox \"Message\""),
        ),
        (
            "paragraph that mentions the captcha prompt",
            result("https://blog.example.com/bots", "Bots", "- paragraph: Sites ask you to tick I'm not a robot, or to verify you are human."),
        ),
    ];
    for (name, r) in table {
        assert_eq!(kind_of(&detect(&r)), None, "{name} must not gate: {:?}", detect(&r));
    }
}

#[test]
fn a_sign_in_form_alone_is_a_note_because_the_chat_may_hold_the_credentials() {
    let r = result("https://shop.example.com/account", "Account", "- heading \"Sign in\"\n- textbox \"Email\"\n- textbox \"Password\" [ref=e4]");
    assert!(matches!(detect(&r), Verdict::Note(n) if n.contains("sign-in form")));
}

#[test]
fn a_word_alone_rides_as_a_note_and_never_blocks() {
    let r = result("https://blog.example.com/spam", "Spam", "- paragraph: Our form uses a captcha to stop spam.");
    assert!(matches!(detect(&r), Verdict::Note(n) if n.contains("captcha")));
    let mut out = r;
    let gate = Gate::default();
    gate.after("s", "browser_snapshot", &mut out, Instant::now());
    let parts = out["content"].as_array().unwrap();
    assert!(parts.last().unwrap()["text"].as_str().unwrap().starts_with("Note:"));
    assert!(!gate.is_held("s"), "a note never gates");
}

#[test]
fn a_strong_block_puts_the_message_first_and_keeps_the_page() {
    let gate = Gate::default();
    let mut r = result("https://www.roblox.com/home", "Roblox", ROBLOX_2SV);
    gate.after("s", "browser_snapshot", &mut r, Instant::now());
    let parts = r["content"].as_array().unwrap();
    assert_eq!(parts.len(), 2);
    let first = parts[0]["text"].as_str().unwrap();
    assert!(first.starts_with("BLOCKED ON JOE: Roblox is asking Joe for a verification code"), "{first}");
    assert!(first.contains("ask_user_question"));
    assert!(parts[1]["text"].as_str().unwrap().contains("Page URL"));
    assert!(gate.is_held("s"));
}

#[test]
fn the_message_never_carries_the_query_string() {
    let gate = Gate::default();
    let mut r = result("https://accounts.google.com/v3/signin/identifier?token=SECRET123", "Sign in", GOOGLE_SIGN_IN);
    gate.after("s", "browser_navigate", &mut r, Instant::now());
    let first = r["content"][0]["text"].as_str().unwrap();
    assert!(first.starts_with("BLOCKED ON JOE") && !first.contains("SECRET123"), "{first}");
}

#[test]
fn a_script_result_is_never_touched_because_secret_capture_parses_it() {
    let gate = Gate::default();
    let mut r = result("https://accounts.google.com/v3/signin/identifier", "Sign in", GOOGLE_SIGN_IN);
    let before = r.clone();
    gate.after("s", "browser_evaluate", &mut r, Instant::now());
    assert_eq!(r, before);
    assert!(!gate.is_held("s"));
}

fn blocked_gate() -> (Gate, Instant) {
    let gate = Gate::default();
    let t0 = Instant::now();
    gate.after("s", "browser_navigate", &mut result("https://www.roblox.com/home", "Roblox", ROBLOX_2SV), t0);
    (gate, t0)
}

fn refused(v: &Option<Value>) -> bool {
    v.as_ref().is_some_and(|r| r["content"][0]["text"].as_str().unwrap().contains("BLOCKED ON JOE") && r["isError"] == json!(true))
}

#[test]
fn two_looks_run_then_everything_that_acts_is_refused_without_running() {
    let (gate, t0) = blocked_gate();
    let at = |s| t0 + Duration::from_secs(s);
    assert!(gate.before("s", "browser_snapshot", None, at(1)).is_none());
    assert!(gate.before("s", "browser_snapshot", None, at(2)).is_none());
    assert!(refused(&gate.before("s", "browser_snapshot", None, at(3))), "third look");
    assert!(refused(&gate.before("s", "browser_click", None, at(4))));
    assert!(refused(&gate.before("s", "browser_navigate", None, at(5))));
    assert!(gate.before("other", "browser_click", None, at(5)).is_none(), "another chat is untouched");
}

#[test]
fn an_action_is_refused_at_once_even_with_looks_left() {
    let (gate, t0) = blocked_gate();
    assert!(refused(&gate.before("s", "browser_click", None, t0)));
    assert!(refused(&gate.before("s", "browser_type", None, t0)));
}

#[test]
fn tab_management_diagnostics_and_scripts_are_never_refused_or_counted() {
    let (gate, t0) = blocked_gate();
    for tool in ["browser_tabs", "browser_take_screenshot", "browser_console_messages", "browser_network_requests", "browser_evaluate"] {
        for _ in 0..4 {
            assert!(gate.before("s", tool, None, t0).is_none(), "{tool}");
        }
    }
    // The two looks are still there: console reads did not burn them.
    assert!(gate.before("s", "browser_snapshot", None, t0).is_none());
    assert!(gate.before("s", "browser_snapshot", None, t0).is_none());
    assert!(refused(&gate.before("s", "browser_snapshot", None, t0)));
}

#[test]
fn a_stale_sign_in_tab_can_be_closed_to_lift_the_block() {
    let gate = Gate::default();
    let t0 = Instant::now();
    let popup = "### Open tabs\n- 0: (current) [Shop](https://shop.example.com/)\n- 1: [Sign in](https://accounts.google.com/v3/signin/identifier)\n### Page\n- Page URL: https://shop.example.com/";
    gate.after("s", "browser_tabs", &mut json!({ "content": [{ "type": "text", "text": popup }] }), t0);
    assert!(gate.is_held("s"));
    assert!(gate.before("s", "browser_tabs", None, t0).is_none(), "the close call runs");
    let closed = "### Open tabs\n- 0: (current) [Shop](https://shop.example.com/)\n### Page\n- Page URL: https://shop.example.com/";
    gate.after("s", "browser_tabs", &mut json!({ "content": [{ "type": "text", "text": closed }] }), t0);
    assert!(!gate.is_held("s"));
}

#[test]
fn a_tab_list_alone_never_lifts_a_block_that_came_from_the_page_content() {
    let (gate, t0) = blocked_gate();
    let tabs_only = "### Open tabs\n- 0: (current) [Roblox](https://www.roblox.com/home)";
    gate.after("s", "browser_tabs", &mut json!({ "content": [{ "type": "text", "text": tabs_only }] }), t0);
    assert!(gate.is_held("s"), "a tab list cannot show a code box gone");
    assert!(refused(&gate.before("s", "browser_click", None, t0)));
}

#[test]
fn the_gate_opens_when_the_page_stops_matching() {
    let (gate, t0) = blocked_gate();
    assert!(gate.before("s", "browser_snapshot", None, t0).is_none());
    // Joe typed the code: the re-read shows a normal page.
    gate.after("s", "browser_snapshot", &mut result("https://www.roblox.com/home", "Roblox", "- heading \"Home\""), t0);
    assert!(!gate.is_held("s"));
    assert!(gate.before("s", "browser_click", None, t0).is_none());
}

#[test]
fn a_read_without_page_info_does_not_lift_the_gate() {
    let (gate, t0) = blocked_gate();
    let mut console = json!({ "content": [{ "type": "text", "text": "No console messages" }] });
    gate.after("s", "browser_console_messages", &mut console, t0);
    assert!(gate.is_held("s"), "a console read says nothing about the page");
}

#[test]
fn a_still_blocked_look_repeats_the_message_without_a_fresh_budget() {
    let (gate, t0) = blocked_gate();
    for s in 1..=2 {
        assert!(gate.before("s", "browser_snapshot", None, t0 + Duration::from_secs(s)).is_none());
        let mut r = result("https://www.roblox.com/home", "Roblox", ROBLOX_2SV);
        gate.after("s", "browser_snapshot", &mut r, t0 + Duration::from_secs(s));
        assert!(r["content"][0]["text"].as_str().unwrap().starts_with("BLOCKED ON JOE"));
    }
    assert!(refused(&gate.before("s", "browser_snapshot", None, t0 + Duration::from_secs(3))), "re-seeing the block does not refill the looks");
}

#[test]
fn an_answered_card_opens_the_gate_and_marks_the_site_handled_for_a_while() {
    let (gate, t0) = blocked_gate();
    let answered = Some(t0 + Duration::from_secs(30));
    assert!(gate.before("s", "browser_click", answered, t0 + Duration::from_secs(31)).is_none());
    assert!(!gate.is_held("s"));
    // The same wall on the same site does not gate again in this chat.
    let mut again = result("https://www.roblox.com/home", "Roblox", ROBLOX_2SV);
    gate.after("s", "browser_snapshot", &mut again, t0 + Duration::from_secs(60));
    assert!(!gate.is_held("s"));
    assert_eq!(again["content"].as_array().unwrap().len(), 1, "no BLOCKED text for a handled wall");
    // The same wall long after is a new session expiring.
    gate.after("s", "browser_snapshot", &mut result("https://www.roblox.com/home", "Roblox", ROBLOX_2SV), t0 + HANDLED_FOR + Duration::from_secs(60));
    assert!(gate.is_held("s"));
}

#[test]
fn another_site_still_gates_after_a_handled_one() {
    let (gate, t0) = blocked_gate();
    assert!(gate.before("s", "browser_click", Some(t0 + Duration::from_secs(30)), t0 + Duration::from_secs(31)).is_none());
    gate.after("s", "browser_navigate", &mut result("https://accounts.google.com/v3/signin/identifier", "Sign in", GOOGLE_SIGN_IN), t0 + Duration::from_secs(61));
    assert!(gate.is_held("s"));
}

#[test]
fn a_block_with_no_page_url_is_never_marked_handled() {
    let gate = Gate::default();
    let t0 = Instant::now();
    let no_url = || json!({ "content": [{ "type": "text", "text": "- iframe:\n  - /url: https://roblox-api.arkoselabs.com/fc/gc/" }] });
    gate.after("s", "browser_snapshot", &mut no_url(), t0);
    assert!(gate.is_held("s"));
    assert!(gate.before("s", "browser_click", Some(t0 + Duration::from_secs(1)), t0 + Duration::from_secs(2)).is_none());
    gate.after("s", "browser_snapshot", &mut no_url(), t0 + Duration::from_secs(3));
    assert!(gate.is_held("s"), "an origin-less wall cannot cover every later page");
}

#[test]
fn a_card_answered_before_the_block_does_not_open_it() {
    let (gate, t0) = blocked_gate();
    let earlier = t0.checked_sub(Duration::from_secs(5)).or(Some(t0));
    assert!(refused(&gate.before("s", "browser_click", earlier, t0 + Duration::from_secs(1))));
}

#[test]
fn a_block_nobody_lifted_goes_stale() {
    let (gate, t0) = blocked_gate();
    assert!(gate.before("s", "browser_click", None, t0 + STALE_AFTER + Duration::from_secs(1)).is_none());
    assert!(!gate.is_held("s"));
}

#[test]
fn browser_close_is_never_refused_and_ends_the_block() {
    let (gate, t0) = blocked_gate();
    assert!(gate.before("s", "browser_close", None, t0).is_none());
    assert!(!gate.is_held("s"));
}

#[test]
fn the_password_manager_error_becomes_a_blocker_result() {
    let gate = Gate::default();
    let out = gate.after_err("s", "page.attach: Cannot access a chrome-extension:// URL of different extension", Instant::now()).expect("blocker");
    assert!(out["content"][0]["text"].as_str().unwrap().contains("password manager menu is open"));
    assert!(gate.is_held("s"));
    assert!(gate.after_err("s", "net::ERR_NAME_NOT_RESOLVED", Instant::now()).is_none(), "an ordinary error passes through");
}

#[test]
fn pruning_drops_only_chats_that_are_gone() {
    let (gate, _) = blocked_gate();
    gate.after("keep", "browser_navigate", &mut result("https://www.roblox.com/home", "Roblox", ROBLOX_2SV), Instant::now());
    gate.prune(&["keep".to_string()].into_iter().collect());
    assert!(gate.is_held("keep") && !gate.is_held("s"));
}

#[test]
fn a_card_answer_is_recorded_per_chat() {
    assert!(card_answered_at("blockers-test-chat").is_none());
    note_card_answered("blockers-test-chat");
    assert!(card_answered_at("blockers-test-chat").is_some());
    assert!(card_answered_at("blockers-test-other").is_none());
}
