//! What the dashboard's Run card reads (pc-1804 step 5): the stored run of one main
//! chat, in the shape of the tool's `view` plus each lane's sub id, so the card can
//! show the lane's avatar and open it. Read-only: the card never writes a run, the
//! main chat does, through `run_plan`.

use super::action::view;
use super::*;
use serde_json::{json, Value};

/// `main`'s run as the card draws it, `null` when it has none (a sub has none: its main
/// chat's card is the one place the run shows). Only the stored file is read, not the
/// subs: the tick, a finish and every tool call keep the statuses current and announce
/// each change (`announce`), so the card never needs a probe of its own.
pub fn card_state(main: &str) -> Value {
    let run = decisions::data_root().and_then(|root| load_in(&root, main));
    json!({"session_id": main, "run": run.as_ref().map(card_view)})
}

fn card_view(run: &Run) -> Value {
    let mut v = view(run);
    if let Some(steps) = v["steps"].as_array_mut() {
        for (out, step) in steps.iter_mut().zip(&run.steps) {
            if let Some(sub) = step.sub_id.as_deref() {
                out["sub_id"] = json!(sub);
            }
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::subchats::TempDataDir;

    fn lane(id: &str, sub: &str) -> Step {
        Step { id: id.into(), title: format!("Lane {id}"), owner: Owner::Sub, sub_id: Some(sub.into()), ..Default::default() }
    }

    #[test]
    fn the_card_reads_the_stored_run_with_each_lanes_sub_id() {
        let _d = TempDataDir::new();
        let root = decisions::data_root().unwrap();
        std::fs::create_dir_all(root.join("subchats")).unwrap();
        let run = Run {
            id: "run-card".into(),
            main_id: "card-main".into(),
            title: "Finish todos".into(),
            steps: vec![lane("s1", "sub-a"), Step { id: "s2".into(), title: "Review".into(), after: vec!["s1".into()], ..Default::default() }],
            ..Default::default()
        };
        save_in(&root, &run).unwrap();
        let got = card_state("card-main");
        assert_eq!(got["run"]["id"], json!("run-card"));
        assert_eq!(got["run"]["steps"][0]["sub_id"], json!("sub-a"));
        assert_eq!(got["run"]["steps"][0]["sub"], json!("Lane s1"), "the tool's own fields are kept");
        assert!(got["run"]["steps"][1].get("sub_id").is_none(), "a main step has no sub");
    }

    #[test]
    fn a_chat_with_no_run_reads_null_and_so_does_a_sub() {
        let _d = TempDataDir::new();
        let root = decisions::data_root().unwrap();
        std::fs::create_dir_all(root.join("subchats")).unwrap();
        save_in(&root, &Run { id: "run-x".into(), main_id: "card-main".into(), steps: vec![lane("s1", "sub-a")], ..Default::default() }).unwrap();
        assert!(card_state("nobody")["run"].is_null());
        assert!(card_state("sub-a")["run"].is_null(), "a sub is not the run's owner");
    }
}
