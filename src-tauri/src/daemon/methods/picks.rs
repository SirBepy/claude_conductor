//! The chat dashboard's Autopilot picks card (pc-1750): the choices Claude made
//! by itself on an unattended run (`subchats::picks`) and Joe's review of them.
//!
//! Desktop-pipe only: absent from `remote_transport_table::TRANSPORT_TABLE`,
//! since the phone always draws the Messages view and never shows the card.

use super::super::rpc::{parse_params as parse, Router, RpcError};
use super::super::state::DaemonState;
use crate::daemon::subchats::picks::{self, Review};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// What the card reads: the main chat the list belongs to and every pick.
pub(crate) fn state_for(state: &DaemonState, session_id: &str) -> Value {
    let owner = picks::owner_of(state, session_id);
    let list = crate::daemon::subchats::decisions::data_root()
        .map(|root| picks::list_in(&root, &owner))
        .unwrap_or_default();
    json!({ "owner": owner, "picks": list })
}

pub fn register_picks(router: &mut Router, state: Arc<DaemonState>) {
    let s = state.clone();
    router.register("picks_state", move |params, _ctx| {
        let s = s.clone();
        async move {
            #[derive(Deserialize)]
            struct P {
                session_id: String,
            }
            let p: P = parse(params)?;
            Ok(state_for(&s, &p.session_id))
        }
    });

    // `action` is `agree` or `overrule` (with `instead`). A refusal names the fix.
    let s = state;
    router.register("picks_review", move |params, _ctx| {
        let s = s.clone();
        async move {
            #[derive(Deserialize)]
            struct P {
                session_id: String,
                id: String,
                action: String,
                #[serde(default)]
                instead: String,
            }
            let p: P = parse(params)?;
            let review = match p.action.as_str() {
                "agree" => Review::Agree,
                "overrule" => Review::Overrule(p.instead),
                other => return Err(RpcError::invalid_params(format!("action {other:?} is not agree or overrule"))),
            };
            let owner = picks::owner_of(&s, &p.session_id);
            picks::review(&s, &owner, &p.id, &review).map_err(RpcError::invalid_params)?;
            Ok(state_for(&s, &p.session_id))
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    #[test]
    fn a_sub_reads_and_reviews_its_main_chats_list() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let s = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        for id in ["m-main", "m-sub"] {
            s.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-15T08:00:00+00:00");
        }
        s.registry.set_subchat_of("m-sub", Some("m-main".into()));
        s.registry.set_autopilot("m-main", true);
        picks::record(
            &s,
            "m-sub",
            &picks::NewPick {
                question: "Q?".into(),
                options: vec!["a".into(), "b".into()],
                pick: "a".into(),
                reason: "r".into(),
                landed: String::new(),
            },
        )
        .unwrap();
        let read = state_for(&s, "m-sub");
        assert_eq!(read["owner"], json!("m-main"));
        assert_eq!(read["picks"].as_array().unwrap().len(), 1);
        assert_eq!(state_for(&s, "m-main")["picks"].as_array().unwrap().len(), 1);
        let owner = picks::owner_of(&s, "m-sub");
        picks::review(&s, &owner, "P1", &Review::Agree).unwrap();
        assert_eq!(state_for(&s, "m-main")["picks"][0]["status"], json!("agreed"));
    }
}
