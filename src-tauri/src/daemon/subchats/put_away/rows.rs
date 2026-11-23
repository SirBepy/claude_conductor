//! Which rows of a listing a put-away takes out of sight (pc-1806: "put away" means closed).
//!
//! Every list a client reads (the desktop webview's `list_instances` and its
//! `instances-changed` event, the phone's REST, RPC and stream frames, a peer's mirror)
//! goes through [`without_family`], so a put-away main chat and its subs are in no
//! sidebar, head, palette, schedule picker, count or card. The one deliberate way back is
//! [`family_of`]: the desktop's reopen doors (the project dashboard's "Open main chat" and
//! a new chat's "Reopens ..." line) read the hidden rows through it and nothing else does.
//!
//! The rule works on the rows alone (no registry, no record file), so every boundary can
//! apply it to the list it already holds: a put-away main chat is an OPEN, non-sub row
//! carrying `hidden_at`, and a sub of one is a row whose `subchat_of` names it. A reopen
//! clears the flag, so the family is visible again the moment the gate opens.

use crate::types::Instance;
use serde_json::Value;
use std::collections::HashSet;

fn is_put_away_main(i: &Instance) -> bool {
    i.hidden_at.is_some() && i.ended_at.is_none() && i.subchat_of.is_none()
}

fn main_ids(rows: &[Instance]) -> HashSet<&str> {
    rows.iter().filter(|i| is_put_away_main(i)).map(|i| i.session_id.as_str()).collect()
}

/// `rows` without any put-away main chat or any sub of one.
pub fn without_family(rows: Vec<Instance>) -> Vec<Instance> {
    let mains: HashSet<String> = main_ids(&rows).into_iter().map(str::to_string).collect();
    if mains.is_empty() {
        return rows;
    }
    rows.into_iter().filter(|i| !(is_put_away_main(i) || i.subchat_of.as_ref().is_some_and(|m| mains.contains(m)))).collect()
}

/// The put-away main chats in `rows` and their subs: what the reopen doors read.
pub fn family_of(rows: &[Instance]) -> Vec<Instance> {
    let mains = main_ids(rows);
    rows.iter().filter(|i| is_put_away_main(i) || i.subchat_of.as_deref().is_some_and(|m| mains.contains(m))).cloned().collect()
}

/// [`without_family`] for a list that is already JSON (a forwarded notifier frame, the shared
/// RPC router's result).
pub fn retain_visible_json(arr: &mut Vec<Value>) {
    let str_of = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
    let null = |v: &Value, key: &str| v.get(key).is_none_or(Value::is_null);
    let mains: HashSet<String> = arr
        .iter()
        .filter(|v| str_of(v, "hidden_at").is_some() && null(v, "ended_at") && null(v, "subchat_of"))
        .filter_map(|v| str_of(v, "session_id"))
        .collect();
    if mains.is_empty() {
        return;
    }
    arr.retain(|v| {
        let own = str_of(v, "session_id").is_some_and(|id| mains.contains(&id));
        let sub = str_of(v, "subchat_of").is_some_and(|m| mains.contains(&m));
        !(own || sub)
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(id: &str) -> Instance {
        let state = crate::daemon::state::DaemonState::new(
            crate::daemon::session::new_session_map(),
            crate::daemon::settings_cache::SettingsCache::new(crate::types::Settings::default()),
        );
        state.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-23T00:00:00Z");
        state.registry.get(id).unwrap()
    }

    fn put_away(id: &str) -> Instance {
        let mut i = row(id);
        i.hidden_at = Some("2026-11-23T10:00:00Z".to_string());
        i
    }

    fn sub_of(id: &str, main: &str) -> Instance {
        let mut i = row(id);
        i.subchat_of = Some(main.to_string());
        i
    }

    fn ids(rows: &[Instance]) -> Vec<&str> {
        rows.iter().map(|i| i.session_id.as_str()).collect()
    }

    #[test]
    fn a_put_away_main_chat_and_its_subs_leave_the_listing() {
        let rows = vec![row("plain"), put_away("away"), sub_of("away-sub", "away"), sub_of("live-sub", "live"), row("live")];
        assert_eq!(ids(&without_family(rows)), vec!["plain", "live-sub", "live"]);
    }

    #[test]
    fn a_listing_with_no_put_away_chat_is_returned_as_it_was() {
        let rows = vec![row("a"), sub_of("b", "a")];
        assert_eq!(ids(&without_family(rows)), vec!["a", "b"]);
    }

    #[test]
    fn an_ended_flagged_row_is_not_a_put_away_chat() {
        let mut gone = put_away("gone");
        gone.ended_at = Some("2026-11-23T11:00:00Z".to_string());
        assert_eq!(ids(&without_family(vec![gone, row("b")])), vec!["gone", "b"]);
    }

    #[test]
    fn the_reopen_doors_still_read_the_family() {
        let rows = vec![row("plain"), put_away("away"), sub_of("away-sub", "away"), sub_of("live-sub", "plain")];
        assert_eq!(ids(&family_of(&rows)), vec!["away", "away-sub"]);
    }

    #[test]
    fn the_json_filter_drops_the_same_rows() {
        let mut arr = vec![
            json!({"session_id": "plain", "ended_at": null, "subchat_of": null}),
            json!({"session_id": "away", "hidden_at": "2026-11-23T10:00:00Z", "ended_at": null, "subchat_of": null}),
            json!({"session_id": "away-sub", "subchat_of": "away"}),
            json!({"session_id": "live-sub", "subchat_of": "plain"}),
        ];
        retain_visible_json(&mut arr);
        let left: Vec<&str> = arr.iter().filter_map(|v| v["session_id"].as_str()).collect();
        assert_eq!(left, vec!["plain", "live-sub"]);
    }
}
