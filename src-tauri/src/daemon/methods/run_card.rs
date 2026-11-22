//! The run section of the chat dashboard's Plan card (pc-1804 step 5): the plan a main chat holds with
//! `run_plan`, read for one chat. The daemon announces a change as `run_plan_changed`
//! (`subchats::run::announce`, `{ session_id, run_id, status }`) and the card re-reads.
//!
//! Desktop-pipe only: absent from `remote_transport_table::TRANSPORT_TABLE`, since the
//! phone always draws the Messages view and never shows the card.

use super::super::rpc::{parse_params as parse, Router};
use crate::daemon::subchats::run;
use serde::Deserialize;

pub fn register_run_card(router: &mut Router) {
    router.register("run_plan_state", move |params, _ctx| async move {
        #[derive(Deserialize)]
        struct P {
            session_id: String,
        }
        let p: P = parse(params)?;
        Ok(run::card_state(&p.session_id))
    });
}
