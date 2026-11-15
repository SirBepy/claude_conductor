//! `mute_conductor`: Conductor's own turn sound and phone push stay quiet while
//! the current mode carries the flag. Question cards still appear, silently.
//! `notify_gate::fire` asks [`is_muted`] and counts a muted notification as
//! handled, so the gate's state advances and nothing replays when the mode ends.

#[cfg(not(test))]
use super::MUTE_CONDUCTOR;

/// Whether the notification under `key` (a session id or a `prompt:` key) must be
/// dropped. Tests never read the machine's real state file: they see only the keys
/// [`set_muted_for_test`] named.
#[cfg(not(test))]
pub fn is_muted(_key: &str) -> bool {
    let mode = super::current();
    mode.has_flag(MUTE_CONDUCTOR) && !mode.is_expired(chrono::Utc::now())
}

#[cfg(test)]
pub fn is_muted(key: &str) -> bool {
    TEST_MUTED.lock().unwrap_or_else(|e| e.into_inner()).contains(key)
}

#[cfg(test)]
static TEST_MUTED: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(Default::default);

#[cfg(test)]
pub(crate) fn set_muted_for_test(key: &str, muted: bool) {
    let mut set = TEST_MUTED.lock().unwrap_or_else(|e| e.into_inner());
    if muted {
        set.insert(key.to_string());
    } else {
        set.remove(key);
    }
}
