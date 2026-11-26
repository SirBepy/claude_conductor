//! A tab whose debugger the browser detached while the tab is still open is
//! attached again under the same bridge session id, and the setup Playwright
//! sent for that session is replayed, so Playwright sees a reload and never a
//! close (`reattach.rs` drives it). This file holds the pure part: which
//! commands count as setup, and how a record of them stays short.

use std::time::Duration;

use serde_json::Value;

/// How often a tab another extension holds is tried again.
#[cfg(not(test))]
pub const PARK_RETRY: Duration = Duration::from_secs(2);
#[cfg(test)]
pub const PARK_RETRY: Duration = Duration::from_millis(50);

/// How many tries a held tab gets before it counts as gone (about 2 minutes).
#[cfg(not(test))]
pub const PARK_TRIES: u32 = 60;
#[cfg(test)]
pub const PARK_TRIES: u32 = 40;

/// What a chat's call gets while another extension's frame holds the tab. The
/// tab is open, so it must not read as a close, and the model must not open a
/// second one.
pub const PARKED_MESSAGE: &str = "BLOCKED ON JOE: a password manager or another extension has its menu open on this page, so the browser will not let \
Claude Conductor drive the tab right now. The tab is still open and nothing was lost: do not open a new one. Ask Joe to click away from the \
field or close the menu, then retry this call.";

/// Chrome refuses a debugger on a tab holding another extension's frame (the
/// Bitwarden autofill menu), with this text.
pub fn is_extension_refusal(error: &str) -> bool {
    error.contains("chrome-extension://") || error.contains("different extension")
}

/// A record longer than this stops growing: a page that keeps registering
/// scripts must not make a replay unbounded.
const MAX_SETUP: usize = 64;

/// Setup is what a fresh debugger session lacks: domain enables, lifecycle and
/// file-chooser switches, init scripts, bindings, emulation and auto-attach.
fn is_setup(method: &str) -> bool {
    method.ends_with(".enable")
        || matches!(
            method,
            "Page.setLifecycleEventsEnabled"
                | "Page.setInterceptFileChooserDialog"
                | "Target.setAutoAttach"
                | "Page.addScriptToEvaluateOnNewDocument"
                | "Runtime.addBinding"
                | "Page.setBypassCSP"
                | "Network.setCacheDisabled"
                | "Network.setExtraHTTPHeaders"
                | "Security.setIgnoreCertificateErrors"
        )
        // The bridge turns focus emulation on itself on every attach.
        || (method.starts_with("Emulation.") && !method.starts_with("Emulation.clear") && method != "Emulation.setFocusEmulationEnabled")
}

/// Scripts and bindings pile up (each call adds one); everything else is a
/// switch where the last value wins.
fn accumulates(method: &str) -> bool {
    matches!(method, "Page.addScriptToEvaluateOnNewDocument" | "Runtime.addBinding")
}

/// Keeps `setup` equal to the commands that rebuild a session's state, in the
/// order Playwright first sent them.
pub fn record(setup: &mut Vec<(String, Value)>, method: &str, params: &Value) {
    if let Some(domain) = method.strip_suffix(".disable") {
        let enable = format!("{domain}.enable");
        setup.retain(|(m, _)| *m != enable);
        return;
    }
    if let Some(rest) = method.strip_prefix("Emulation.clear") {
        let set = format!("Emulation.set{rest}");
        setup.retain(|(m, _)| *m != set);
        return;
    }
    if !is_setup(method) {
        return;
    }
    if accumulates(method) {
        if setup.len() < MAX_SETUP && !setup.iter().any(|(m, p)| m == method && p == params) {
            setup.push((method.to_string(), params.clone()));
        }
        return;
    }
    match setup.iter().position(|(m, _)| m == method) {
        Some(at) => setup[at].1 = params.clone(),
        None if setup.len() < MAX_SETUP => setup.push((method.to_string(), params.clone())),
        None => {}
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn methods(setup: &[(String, Value)]) -> Vec<&str> {
        setup.iter().map(|(m, _)| m.as_str()).collect()
    }

    #[test]
    fn only_setup_commands_are_recorded_in_first_sent_order() {
        let mut s = vec![];
        for m in ["Page.enable", "Runtime.enable", "Page.navigate", "Runtime.evaluate", "Page.setLifecycleEventsEnabled", "Page.getFrameTree", "Network.enable"] {
            record(&mut s, m, &json!({}));
        }
        assert_eq!(methods(&s), ["Page.enable", "Runtime.enable", "Page.setLifecycleEventsEnabled", "Network.enable"]);
    }

    #[test]
    fn a_switch_keeps_its_place_and_its_last_value_while_scripts_pile_up() {
        let mut s = vec![];
        record(&mut s, "Emulation.setDeviceMetricsOverride", &json!({ "width": 1 }));
        record(&mut s, "Page.addScriptToEvaluateOnNewDocument", &json!({ "source": "a" }));
        record(&mut s, "Emulation.setDeviceMetricsOverride", &json!({ "width": 2 }));
        record(&mut s, "Page.addScriptToEvaluateOnNewDocument", &json!({ "source": "b" }));
        record(&mut s, "Page.addScriptToEvaluateOnNewDocument", &json!({ "source": "a" }));
        assert_eq!(methods(&s), ["Emulation.setDeviceMetricsOverride", "Page.addScriptToEvaluateOnNewDocument", "Page.addScriptToEvaluateOnNewDocument"]);
        assert_eq!(s[0].1, json!({ "width": 2 }));
    }

    #[test]
    fn a_disable_or_clear_takes_the_switch_back_out() {
        let mut s = vec![];
        record(&mut s, "Network.enable", &json!({}));
        record(&mut s, "Emulation.setDeviceMetricsOverride", &json!({}));
        record(&mut s, "Network.disable", &json!({}));
        record(&mut s, "Emulation.clearDeviceMetricsOverride", &json!({}));
        assert!(s.is_empty(), "{s:?}");
    }

    #[test]
    fn focus_emulation_is_left_to_the_attach_and_the_record_is_capped() {
        let mut s = vec![];
        record(&mut s, "Emulation.setFocusEmulationEnabled", &json!({ "enabled": true }));
        assert!(s.is_empty());
        for n in 0..(MAX_SETUP + 10) {
            record(&mut s, "Runtime.addBinding", &json!({ "name": format!("b{n}") }));
        }
        assert_eq!(s.len(), MAX_SETUP);
    }

    #[test]
    fn the_password_managers_refusal_is_told_from_other_attach_errors() {
        assert!(is_extension_refusal("Cannot access a chrome-extension:// URL of different extension"));
        assert!(!is_extension_refusal("No tab with id: 70."));
        assert!(!is_extension_refusal("Debugger is not attached to the tab"));
    }
}
