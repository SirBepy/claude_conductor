//! The rules a mode-on `spawn_chat` obeys before a sub exists: the brief, the
//! tier, the known-project allowlist, the cap of ten started subs and the depth
//! limit. `spawn_chat`'s own module runs the spawn; this is only the decision.

mod cap;

use super::brief::{compose_first_message, gate_brief, validate, SubchatArgs};
use crate::daemon::state::DaemonState;
use crate::sessions::chat_config::ChatConfig;
use crate::settings::identity::project_key;
use crate::types::Instance;
use cap::reserve;
pub use cap::{mark_as_sub, running_subs, started_subs, HoldPlan, SubPlan, MAX_RUNNING};

/// A sub with no model named opens here. Joe: "normal code jobs" are Sonnet high.
const DEFAULT_MODEL: &str = "sonnet";
const DEFAULT_EFFORT: &str = "high";

/// Said when a sub tries to spawn or respawn. Depth is 1 on purpose: a sub that
/// could spawn would hide work two levels from Joe.
pub const DEPTH_REFUSAL: &str =
    "A sub cannot spawn or respawn chats. Do the work in this chat, or finish and report that it needs more jobs.";

const TIERS: &str = "sonnet at medium effort (mechanical work: a version bump, a rename, docs), \
sonnet at high effort (every job that edits files), or opus at high effort (a read-only sub only: a plan, a design, an audit, a review)";

/// Said when an Opus sub is asked to edit files. Joe's call 2026-11-13: Opus is
/// worth its 2x as planner, designer and checker, while Sonnet implements.
const OPUS_WRITER_REFUSAL: &str = "An Opus sub cannot edit files: Opus costs twice what Sonnet does and earns it on planning, design and review, not on implementing. Use sonnet at high effort for this job. If it needs a plan first, spawn a read-only Opus sub for the plan (writes false), then a Sonnet sub to carry it out.";

pub(super) fn label(i: &Instance) -> String {
    i.name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| i.session_id.chars().take(8).collect())
}

/// The explicit model and effort for a sub. Both are passed on to the spawn so
/// `resolve_model_effort` never reaches for the project default; an omitted one
/// takes the Sonnet-high default. Only the three tiers Joe chose pass: Sonnet at
/// medium, Sonnet at high, Opus at high. A full model id counts as its family, so
/// `claude-opus-4-8` is Opus. The effort comes back lower-cased because the spawn
/// compares it exactly. `writes` is whether the sub edits files: Opus is refused
/// for a writer.
pub fn resolve_tier(model: Option<&str>, effort: Option<&str>, writes: bool) -> Result<(String, String), String> {
    let pick = |v: Option<&str>, default: &str| {
        v.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(default).to_string()
    };
    let model = pick(model, DEFAULT_MODEL);
    let effort = pick(effort, DEFAULT_EFFORT).to_ascii_lowercase();
    let family = model.to_ascii_lowercase();
    let allowed = if family.contains("sonnet") {
        matches!(effort.as_str(), "medium" | "high")
    } else if family.contains("opus") {
        effort == "high"
    } else {
        false
    };
    if !allowed {
        let why = if family.contains("haiku") { "Subs never run on haiku. " } else { "" };
        return Err(format!("{why}{model} at {effort} effort is not a sub tier. Pick one of the three tiers: {TIERS}."));
    }
    if writes && family.contains("opus") {
        return Err(OPUS_WRITER_REFUSAL.to_string());
    }
    Ok((model, effort))
}

/// `Ok` when `target` (a chat's directory) is in the main chat's own project.
/// `caller_cwd` is the main chat's own directory.
pub fn check_same_project(caller_cwd: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    if project_key(caller_cwd) == project_key(target) {
        return Ok(());
    }
    Err(other_project_refusal(caller_cwd))
}

/// "Move into main chat" adopts a chat from the main chat's own project or from
/// any project the app already knows, the same reach a fresh sub has in `plan`
/// (both go through `resolve_target_cwd`).
pub fn check_adoptable_project(state: &DaemonState, caller_cwd: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    check_same_project(caller_cwd, target).or_else(|refusal| {
        crate::daemon::methods::spawn_chat::resolve_target_cwd(caller_cwd, target, &state.settings.snapshot().projects)
            .map(|_| ())
            .map_err(|_| refusal)
    })
}

/// Said when a chat's folder is neither the main chat's project nor a known one.
/// Joe is the one moving the chat in, so it says which projects work and how to
/// make a project known, not whom to ask.
fn other_project_refusal(caller_cwd: &std::path::Path) -> String {
    format!(
        "A chat can join as a sub from this chat's own project ({}) or a project Conductor already knows, and this one is neither. Open its project in Conductor first, or leave the chat in the sidebar.",
        caller_cwd.display()
    )
}

/// A sub's folder must be this chat's own or a project the app already knows,
/// never an arbitrary path (the same allowlist as a plain `spawn_chat`).
fn unknown_project_refusal(caller_cwd: &std::path::Path, requested: &str) -> String {
    format!(
        "A sub runs in this chat's own project ({}) or a project Conductor already knows, and {requested} is neither. Ask Joe to open that project in Conductor first, or pass plain=true to open an ordinary chat there instead.",
        caller_cwd.display()
    )
}

/// Said when `plain: true` comes with a field that only a sub has.
pub const PLAIN_WITH_SUB_FIELDS: &str = "plain: true opens an ordinary chat, so gate and after (which only a sub has) must be left out. Drop them, or drop plain to start a sub.";

/// `Err` when `caller` is itself a sub: it may neither spawn nor respawn.
pub fn refuse_sub_caller(state: &DaemonState, caller: &str) -> Result<(), String> {
    match state.registry.get(caller) {
        Some(i) if super::is_sub(&i) => Err(DEPTH_REFUSAL.to_string()),
        _ => Ok(()),
    }
}

/// Decides whether this `spawn_chat` makes a sub and, if so, whether it may.
/// `Ok(None)` means an ordinary chat: the caller is unknown (the normal path
/// reports that), or its mode is off. A `machine` spawn never reaches here.
/// `accounts` is injected so a test touches no accounts file.
pub fn plan(
    state: &DaemonState,
    caller_id: &str,
    inherited: &ChatConfig,
    cwd: &str,
    prompt: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    name: Option<&str>,
    args: &SubchatArgs,
    accounts: &[crate::accounts::Account],
) -> Result<Option<SubPlan>, String> {
    let Some(caller) = state.registry.get(caller_id) else { return Ok(None) };
    let gate = args.gate == Some(true);
    if !inherited.subchats_on {
        // Every other brief field does nothing here; `gate` is the one that would
        // otherwise be dropped silently and leave a chat believing a push gate ran
        // hidden when it started a visible chat.
        if gate {
            return Err(GATE_MODE_OFF.to_string());
        }
        return Ok(None);
    }
    // An ordinary chat: the normal spawn path applies its own project allowlist
    // and account rules, exactly as for a chat with the mode off.
    if args.plain == Some(true) {
        let has_after = args.after.as_deref().is_some_and(|a| !a.trim().is_empty());
        if gate || has_after {
            return Err(PLAIN_WITH_SUB_FIELDS.to_string());
        }
        return Ok(None);
    }
    // The mode refuses an API-credit chat when it is turned on, but the account
    // can change under a chat that already has it on.
    let account = Some(inherited.account_id.as_str()).filter(|a| !a.is_empty());
    if let Some(reason) = super::refusal_for_account(account, accounts) {
        return Err(reason.to_string());
    }
    // Before the brief: a thin brief aimed at an unknown folder should hear that
    // the folder is the problem, since filling in the brief would not help. A sub
    // may run in a project other than its main chat's: every later step (writer
    // slot, worktree, checks, gate push) reads the sub's own folder, and its
    // cards route by parent id, so only the allowlist matters here.
    let target = crate::daemon::methods::spawn_chat::resolve_target_cwd(
        &caller.cwd,
        std::path::Path::new(cwd),
        &state.settings.snapshot().projects,
    )
    .map_err(|_| unknown_project_refusal(&caller.cwd, cwd))?;
    let mut brief = if gate {
        let brief = gate_brief(prompt, caller_id)?;
        refuse_second_gate(state, caller_id, &target)?;
        brief
    } else {
        let brief = validate(name, args, caller_id)?;
        refuse_duplicate_name(state, caller_id, name)?;
        brief
    };
    let (model, effort) = resolve_tier(model, effort, brief.writes)?;
    let hold = match args.after.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
        Some(query) => {
            brief.after = Some(query.to_string());
            super::held::plan_after(state, caller_id, query)?
        }
        None => None,
    };
    let reservation = reserve(state, caller_id)?;
    // A gate's prompt is its whole first message, kept word for word: it quotes
    // Joe's push request. Any other sub gets the message written from its brief.
    let first_message = if gate {
        prompt.unwrap_or_default().to_string()
    } else {
        compose_first_message(&brief, prompt)
    };
    Ok(Some(SubPlan {
        parent: caller_id.to_string(),
        brief,
        first_message,
        model,
        effort,
        hold,
        reservation: Some(reservation),
    }))
}

/// Said when `gate: true` comes from a chat whose mode is off.
pub const GATE_MODE_OFF: &str = "gate: true starts a hidden gate sub, which only a chat with Use subchats on can do. Run the push gate in this chat, or spawn the gate chat without gate.";

/// The subs a parent can still address by name: running, queued and finished
/// ones (a finished one wakes on a follow-up); an ended one is gone.
fn live_subs(state: &DaemonState, parent: &str) -> Vec<Instance> {
    state
        .registry
        .list()
        .into_iter()
        .filter(|i| i.subchat_of.as_deref() == Some(parent) && i.ended_at.is_none() && i.end_reason.is_none())
        .collect()
}

/// The names `live_subs` answer to, trimmed and lower-cased the way the name
/// match below compares them, for a caller picking a name that is still free.
pub fn live_sub_names(state: &DaemonState, parent: &str) -> Vec<String> {
    live_subs(state, parent).iter().map(|i| label(i).trim().to_lowercase()).collect()
}

/// A name is how the main chat addresses a sub (`subchat send`, `after`), so one
/// parent never has two live subs answering to it. The match ignores case and
/// surrounding blanks, as the tool's own lookup does.
fn refuse_duplicate_name(state: &DaemonState, parent: &str, name: Option<&str>) -> Result<(), String> {
    let wanted = name.map(|n| n.trim().to_lowercase()).filter(|n| !n.is_empty());
    let Some(wanted) = wanted else { return Ok(()) };
    let same: Vec<String> = live_subs(state, parent)
        .into_iter()
        .filter(|i| label(i).trim().to_lowercase() == wanted)
        .map(|i| format!("{} ({})", label(&i), if i.subchat_finished { "finished" } else { "running" }))
        .collect();
    if same.is_empty() {
        return Ok(());
    }
    Err(format!(
        "A sub with the name {} already exists in this chat: {}. A name is how you address a sub, so two cannot share one. Pick another name for this job, or hand it to that sub with the subchat tool.",
        name.unwrap_or_default().trim(),
        same.join(", ")
    ))
}

/// A parent has one gate per project at a time: two would race on the same push
/// and on the repo's writer slot. Gates in different projects push different
/// repos, so a hub chat may run one in each. `Err` names the running one.
fn refuse_second_gate(state: &DaemonState, parent: &str, target: &std::path::Path) -> Result<(), String> {
    let key = project_key(target);
    let same_project = |i: &Instance| project_key(&i.cwd) == key;
    match running_subs(&state.registry, parent).into_iter().find(|i| super::is_gate(&i.session_id) && same_project(i)) {
        Some(running) => Err(format!(
            "This chat already has a gate sub running for this project ({}). A push has one gate at a time: wait for it to finish, or hand Joe's request to it with the subchat tool.",
            label(&running)
        )),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use std::sync::Arc;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn cwd() -> std::path::PathBuf {
        std::env::current_dir().unwrap()
    }

    fn row(st: &DaemonState, id: &str) {
        st.registry.upsert_interactive(id, &cwd(), "proj", "2026-11-05T00:00:00Z");
    }

    /// A started sub: busy, so the cap reads it as having a process.
    fn sub_row(st: &DaemonState, id: &str, parent: &str, name: &str) {
        row(st, id);
        st.registry.set_subchat_of(id, Some(parent.into()));
        st.registry.set_name(id, name.into());
        st.registry.set_busy(id, true);
    }

    /// A sub row that never started: no child, no transcript, busy never set.
    fn ghost_row(st: &DaemonState, id: &str, parent: &str, name: &str) {
        row(st, id);
        st.registry.set_subchat_of(id, Some(parent.into()));
        st.registry.set_name(id, name.into());
    }

    fn on() -> ChatConfig {
        ChatConfig { subchats_on: true, ..Default::default() }
    }

    fn complete() -> SubchatArgs {
        SubchatArgs {
            task: Some("t".into()),
            goal: Some("g".into()),
            done_when: Some("d".into()),
            writes: Some(false),
            ..Default::default()
        }
    }

    fn plan_for(st: &DaemonState, cfg: &ChatConfig, name: Option<&str>, args: &SubchatArgs) -> Result<Option<SubPlan>, String> {
        plan_as(st, "main", cfg, name, args)
    }

    /// The cap reservations live in a process-wide map keyed by parent id, so a
    /// test that holds plans open uses its own parent id and cannot make a
    /// parallel test see a full cap.
    fn plan_as(st: &DaemonState, parent: &str, cfg: &ChatConfig, name: Option<&str>, args: &SubchatArgs) -> Result<Option<SubPlan>, String> {
        let here = cwd();
        plan(st, parent, cfg, &here.to_string_lossy(), None, None, None, name, args, &[])
    }

    #[test]
    fn mode_off_makes_a_normal_chat_and_ignores_the_brief_fields() {
        let st = state();
        row(&st, "main");
        assert!(plan_for(&st, &ChatConfig::default(), None, &SubchatArgs::default()).unwrap().is_none());
        assert!(plan_for(&st, &ChatConfig::default(), Some("x"), &complete()).unwrap().is_none());
    }

    #[test]
    fn an_unknown_caller_falls_through_to_the_normal_path() {
        let st = state();
        assert!(plan_for(&st, &on(), Some("x"), &complete()).unwrap().is_none());
    }

    #[test]
    fn mode_on_refuses_a_thin_brief_naming_every_missing_field() {
        let st = state();
        row(&st, "main");
        let err = plan_for(&st, &on(), None, &SubchatArgs::default()).err().expect("refused");
        for f in ["name", "task", "goal", "done_when", "writes"] {
            assert!(err.contains(f), "{f} not named: {err}");
        }
    }

    #[test]
    fn mode_on_with_a_complete_brief_plans_a_sub_on_the_default_tier() {
        let st = state();
        row(&st, "main");
        let p = plan_for(&st, &on(), Some("header"), &complete()).unwrap().expect("a sub");
        assert_eq!(p.parent, "main");
        assert_eq!((p.model.as_str(), p.effort.as_str()), ("sonnet", "high"));
        assert!(p.first_message.contains("Never weaken a test"), "{}", p.first_message);
    }

    #[test]
    fn the_extra_prompt_rides_under_the_brief() {
        let st = state();
        row(&st, "main");
        let here = cwd();
        let p = plan(&st, "main", &on(), &here.to_string_lossy(), Some("also read X"), None, None, Some("n"), &complete(), &[])
            .unwrap()
            .unwrap();
        assert!(p.first_message.contains("also read X"));
        assert!(p.first_message.find("Job:").unwrap() < p.first_message.find("also read X").unwrap());
    }

    #[test]
    fn haiku_is_refused_with_the_three_tiers() {
        let err = resolve_tier(Some("haiku"), None, false).unwrap_err();
        assert!(err.contains("sonnet at medium") && err.contains("sonnet at high") && err.contains("opus at high"), "{err}");
        assert!(resolve_tier(Some("claude-haiku-4-5"), Some("low"), false).is_err());
        assert_eq!(resolve_tier(Some("opus"), Some("high"), false).unwrap(), ("opus".to_string(), "high".to_string()));
    }

    #[test]
    fn opus_is_for_a_read_only_sub_and_a_writer_is_sent_to_sonnet() {
        let err = resolve_tier(Some("opus"), Some("high"), true).unwrap_err();
        assert!(err.contains("Opus sub cannot edit files") && err.contains("sonnet at high"), "{err}");
        assert!(resolve_tier(Some("claude-opus-4-8"), None, true).is_err(), "a full id counts as its family");
        assert!(resolve_tier(Some("opus"), Some("high"), false).is_ok(), "a read-only plan or review sub may use Opus");
        assert!(resolve_tier(Some("sonnet"), Some("high"), true).is_ok());
        assert!(resolve_tier(None, None, true).is_ok(), "an omitted tier is Sonnet, so a writer needs no model");
    }

    #[test]
    fn a_planned_opus_writer_is_refused_and_an_opus_reader_is_planned() {
        let st = state();
        row(&st, "main");
        let here = cwd();
        let mut writer = complete();
        writer.writes = Some(true);
        writer.files = Some(vec!["src/a.rs".into()]);
        let err = plan(&st, "main", &on(), &here.to_string_lossy(), None, Some("opus"), Some("high"), Some("w"), &writer, &[])
            .err()
            .expect("an Opus writer is refused");
        assert!(err.contains("Opus sub cannot edit files"), "{err}");
        let p = plan(&st, "main", &on(), &here.to_string_lossy(), None, Some("opus"), Some("high"), Some("r"), &complete(), &[])
            .unwrap()
            .expect("a read-only Opus sub");
        assert_eq!(p.model, "opus");
    }

    fn pair(m: &str, e: &str) -> (String, String) {
        (m.to_string(), e.to_string())
    }

    #[test]
    fn each_of_the_three_tiers_is_allowed_and_a_full_model_id_counts_as_its_family() {
        for (m, e) in [
            ("sonnet", "medium"),
            ("sonnet", "high"),
            ("opus", "high"),
            ("claude-sonnet-4-5", "high"),
            ("claude-opus-4-8", "high"),
            ("claude-sonnet-4-5", "MEDIUM"),
        ] {
            // The effort comes back lower-cased: the spawn compares it exactly.
            assert_eq!(resolve_tier(Some(m), Some(e), false).unwrap(), pair(m, &e.to_ascii_lowercase()), "{m} {e}");
        }
        // An omitted half takes its default, and the pair is still checked.
        assert_eq!(resolve_tier(Some("opus"), None, false).unwrap(), pair("opus", "high"));
        assert_eq!(resolve_tier(None, Some("medium"), false).unwrap(), pair("sonnet", "medium"));
    }

    #[test]
    fn a_pair_outside_the_three_tiers_is_refused_naming_them() {
        for (m, e) in [
            (Some("opus"), Some("medium")),
            (Some("opus"), Some("low")),
            (Some("opus"), Some("max")),
            (Some("sonnet"), Some("low")),
            (Some("sonnet"), Some("xhigh")),
            (Some("claude-sonnet-4-5"), Some("max")),
            (Some("fable"), Some("high")),
            (Some("some-other-model"), None),
            (None, Some("max")),
        ] {
            let err = resolve_tier(m, e, false).expect_err(&format!("{m:?} {e:?} must be refused"));
            assert!(
                err.contains("sonnet at medium") && err.contains("sonnet at high") && err.contains("opus at high"),
                "{m:?} {e:?}: {err}"
            );
        }
    }

    #[test]
    fn an_omitted_tier_is_sonnet_high_not_the_project_default() {
        assert_eq!(resolve_tier(None, None, false).unwrap(), ("sonnet".to_string(), "high".to_string()));
        assert_eq!(resolve_tier(Some("  "), Some(""), false).unwrap(), ("sonnet".to_string(), "high".to_string()));
        // Passed on explicitly, `resolve_model_effort` takes them over the project default.
        let mut settings = Settings::default();
        settings.extra.insert("defaultModel".into(), serde_json::json!("fable"));
        let st = DaemonState::new(new_session_map(), SettingsCache::new(settings));
        let (m, e) = resolve_tier(None, None, false).unwrap();
        let got = crate::daemon::methods::spawn_chat::resolve_model_effort(
            &st, &cwd(), Some(&m), Some(&e), &ChatConfig::default(), false,
        );
        assert_eq!(got, ("sonnet".to_string(), "high".to_string()));
    }

    #[test]
    fn a_spawn_past_the_cap_is_refused_naming_the_running_subs() {
        let st = state();
        row(&st, "main");
        for n in 0..MAX_RUNNING {
            sub_row(&st, &format!("sub{n}"), "main", &format!("job-{n}"));
        }
        let err = plan_for(&st, &on(), Some("over"), &complete()).err().expect("capped");
        for n in 0..MAX_RUNNING {
            assert!(err.contains(&format!("job-{n}")), "job-{n} not named: {err}");
        }
    }

    /// 2026-11-10: five never-started rows (their hold was wiped) refused every
    /// spawn of a main chat for hours, because the cap counted rows, not processes.
    #[test]
    fn ghost_subs_do_not_count_toward_the_cap() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        row(&st, "ghost-main");
        for n in 0..MAX_RUNNING {
            ghost_row(&st, &format!("ghost{n}"), "ghost-main", &format!("lost-{n}"));
        }
        assert_eq!(running_subs(&st.registry, "ghost-main").len(), MAX_RUNNING, "they are still unfinished rows");
        assert!(started_subs(&st, "ghost-main").is_empty());
        plan_as(&st, "ghost-main", &on(), Some("fresh"), &complete()).unwrap().expect("ghosts hold no slot");
    }

    #[test]
    fn a_queued_sub_with_a_hold_does_not_count_toward_the_cap_but_a_started_one_does() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        row(&st, "q-main");
        sub_row(&st, "q-run", "q-main", "run");
        ghost_row(&st, "q-wait", "q-main", "wait");
        crate::daemon::subchats::held::hold(
            &st,
            crate::daemon::subchats::held::Held {
                sub_id: "q-wait".into(),
                reason: "waiting for run".into(),
                after: Some("q-run".into()),
                after_name: "run".into(),
                launch: Default::default(),
            },
        )
        .unwrap();
        let started: Vec<String> = started_subs(&st, "q-main").into_iter().map(|i| i.session_id).collect();
        assert_eq!(started, vec!["q-run".to_string()]);
    }

    /// A name is how the main chat addresses a sub, so a running or a finished one
    /// blocks reusing it; an ended one is gone.
    #[test]
    fn a_name_in_use_by_a_running_or_finished_sub_is_refused_listing_them() {
        let st = state();
        row(&st, "dup-main");
        sub_row(&st, "dup-run", "dup-main", "Header");
        sub_row(&st, "dup-fin", "dup-main", "footer");
        st.registry.set_subchat_finished("dup-fin", true);
        sub_row(&st, "dup-old", "dup-main", "docs");
        st.registry.mark_ended("dup-old", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        sub_row(&st, "other-sub", "dup-other", "nav");

        let running = plan_as(&st, "dup-main", &on(), Some(" header "), &complete()).err().expect("refused");
        assert!(running.contains("Header (running)") && running.contains("subchat tool"), "{running}");
        let finished = plan_as(&st, "dup-main", &on(), Some("FOOTER"), &complete()).err().expect("refused");
        assert!(finished.contains("footer (finished)"), "{finished}");
        plan_as(&st, "dup-main", &on(), Some("docs"), &complete()).unwrap().expect("an ended sub's name is free");
        plan_as(&st, "dup-main", &on(), Some("nav"), &complete()).unwrap().expect("another chat's sub is not this chat's");
    }

    #[test]
    fn a_finished_or_ended_sub_does_not_count_toward_the_cap() {
        let st = state();
        row(&st, "cap-fin");
        for n in 0..MAX_RUNNING {
            sub_row(&st, &format!("sub{n}"), "cap-fin", &format!("job-{n}"));
        }
        st.registry.set_subchat_finished("sub0", true);
        assert_eq!(running_subs(&st.registry, "cap-fin").len(), MAX_RUNNING - 1);
        plan_as(&st, "cap-fin", &on(), Some("over"), &complete()).unwrap().expect("one slot free");
    }

    #[test]
    fn another_mains_subs_do_not_count() {
        let st = state();
        row(&st, "main");
        row(&st, "other");
        for n in 0..MAX_RUNNING {
            sub_row(&st, &format!("sub{n}"), "other", &format!("job-{n}"));
        }
        plan_for(&st, &on(), Some("mine"), &complete()).unwrap().expect("a separate main has its own cap");
    }

    #[test]
    fn parallel_spawns_reserve_slots_before_any_row_exists() {
        let st = state();
        row(&st, "holder-a");
        let mut held = Vec::new();
        for _ in 0..MAX_RUNNING {
            held.push(plan_as(&st, "holder-a", &on(), Some("n"), &complete()).unwrap().unwrap());
        }
        let err = plan_as(&st, "holder-a", &on(), Some("n"), &complete()).err().expect("blocked while the cap is in flight");
        assert!(err.contains("being started"), "{err}");
        held.pop().unwrap().release_slot();
        plan_as(&st, "holder-a", &on(), Some("n"), &complete()).unwrap().expect("a released slot frees the cap");
    }

    #[test]
    fn reservations_of_one_registry_do_not_count_against_another_with_the_same_parent_id() {
        let (a, b) = (state(), state());
        row(&a, "twin");
        row(&b, "twin");
        let mut held = Vec::new();
        for _ in 0..MAX_RUNNING {
            held.push(plan_as(&a, "twin", &on(), Some("n"), &complete()).unwrap().unwrap());
        }
        assert!(plan_as(&a, "twin", &on(), Some("n"), &complete()).is_err(), "a is full");
        plan_as(&b, "twin", &on(), Some("n"), &complete())
            .unwrap()
            .expect("b has its own count, so five in flight on a leave b's cap alone");
    }

    #[test]
    fn marking_a_spawned_row_sets_the_parent_link_stores_the_brief_and_frees_the_slot() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        row(&st, "holder-b");
        row(&st, "new-sub");
        st.registry.set_busy("new-sub", true);
        let mut p = plan_as(&st, "holder-b", &on(), Some("header"), &complete()).unwrap().unwrap();
        mark_as_sub(&st, "new-sub", &mut p);
        let inst = st.registry.get("new-sub").unwrap();
        assert_eq!(inst.subchat_of.as_deref(), Some("holder-b"));
        let stored = crate::sessions::chat_config::get("new-sub").unwrap().subchat.expect("brief stored");
        assert_eq!((stored.parent.as_str(), stored.task.as_str(), stored.writes), ("holder-b", "t", false));
        assert_eq!(stored.git_head_at_spawn, super::super::git::head(&inst.cwd), "the base the facts count from is stored");
        assert!(crate::sessions::chat_config::sub_session_ids().contains("new-sub"));
        // The row counts now (its child is running in production, `busy` here) and
        // the reservation is gone: 1 running + the rest in flight fills the cap, so
        // a double-counted slot would refuse the last plan.
        let mut held = Vec::new();
        for _ in 0..MAX_RUNNING - 1 {
            held.push(plan_as(&st, "holder-b", &on(), Some("n"), &complete()).unwrap().unwrap());
        }
        assert!(plan_as(&st, "holder-b", &on(), Some("n"), &complete()).is_err());
    }

    fn elsewhere() -> &'static str {
        if cfg!(windows) { "C:\\Windows" } else { "/etc" }
    }

    /// A state that knows one extra project, `dir`, besides the caller's own folder.
    fn state_knowing(dir: &std::path::Path) -> Arc<DaemonState> {
        let mut settings = Settings::default();
        let raw = serde_json::json!({ "id": "other", "path": dir, "name": "other", "created_at": "2026-11-05T00:00:00Z" });
        settings.projects.push(serde_json::from_value::<crate::types::ProjectConfig>(raw).unwrap());
        DaemonState::new(new_session_map(), SettingsCache::new(settings))
    }

    fn plan_in(st: &DaemonState, parent: &str, dir: &std::path::Path, prompt: Option<&str>, name: Option<&str>, args: &SubchatArgs) -> Result<Option<SubPlan>, String> {
        plan(st, parent, &on(), &dir.to_string_lossy(), prompt, None, None, name, args, &[])
    }

    #[test]
    fn a_cwd_that_is_neither_the_main_chats_nor_a_known_project_is_refused() {
        let st = state();
        row(&st, "main");
        let err = plan(&st, "main", &on(), elsewhere(), None, None, None, Some("n"), &complete(), &[]).err().expect("refused");
        assert!(err.contains("already knows"), "{err}");
    }

    #[test]
    fn the_unknown_project_refusal_points_at_ways_out_that_exist() {
        let st = state();
        row(&st, "main");
        let hit = plan(&st, "main", &on(), elsewhere(), None, None, None, Some("n"), &complete(), &[]).err().unwrap();
        assert!(hit.contains("Joe") && hit.contains("plain=true"), "{hit}");
        // Joe is the one moving a chat in, so the adoption refusal never tells the
        // caller to ask him; it says which projects do work.
        let adopt = check_same_project(std::path::Path::new("/a"), std::path::Path::new("/b")).unwrap_err();
        assert!(adopt.contains("already knows") && adopt.contains("/a"), "{adopt}");
        assert!(!adopt.contains("ask Joe") && !adopt.contains("Use subchats"), "{adopt}");
    }

    #[test]
    fn adoption_accepts_a_chat_from_a_known_project_and_refuses_an_unknown_one() {
        let other = tempfile::tempdir().unwrap();
        let st = state_knowing(other.path());
        let caller = cwd();
        assert!(check_adoptable_project(&st, &caller, other.path()).is_ok(), "a known project, like a fresh sub");
        assert!(check_adoptable_project(&st, &caller, &caller).is_ok(), "the main chat's own project");
        let err = check_adoptable_project(&st, &caller, std::path::Path::new(elsewhere())).unwrap_err();
        assert!(err.contains("already knows"), "{err}");
    }

    #[test]
    fn live_sub_names_lists_the_names_a_parent_can_still_address() {
        let st = state();
        row(&st, "ln-main");
        sub_row(&st, "ln-a", "ln-main", "  Header ");
        sub_row(&st, "ln-gone", "ln-main", "gone");
        st.registry.mark_ended("ln-gone", crate::types::EndReason::Manual, "2026-11-05T00:00:01Z");
        sub_row(&st, "ln-other", "someone-else", "elsewhere");
        assert_eq!(live_sub_names(&st, "ln-main"), vec!["header".to_string()]);
    }

    #[test]
    fn a_thin_brief_aimed_at_an_unknown_folder_gets_the_project_error_first() {
        let st = state();
        row(&st, "main");
        let err = plan(&st, "main", &on(), elsewhere(), None, None, None, None, &SubchatArgs::default(), &[])
            .err()
            .expect("refused");
        assert!(err.contains("already knows"), "{err}");
        assert!(!err.contains("done_when"), "the brief error must not win: {err}");
    }

    #[test]
    fn adopting_a_chat_from_a_different_project_is_still_refused() {
        let caller = std::path::PathBuf::from(if cfg!(windows) { "C:\\proj-a" } else { "/proj-a" });
        let other = std::path::PathBuf::from(if cfg!(windows) { "C:\\proj-b" } else { "/proj-b" });
        assert!(check_same_project(&caller, &caller).is_ok());
        let err = check_same_project(&caller, &other).unwrap_err();
        assert!(err.contains("own project"), "{err}");
    }

    // ── a sub in another known project ─────────────────────────────────────

    #[test]
    fn a_sub_may_run_in_another_known_project() {
        let other = tempfile::tempdir().unwrap();
        let st = state_knowing(other.path());
        row(&st, "xp-main");
        let p = plan_in(&st, "xp-main", other.path(), None, Some("api"), &complete()).unwrap().expect("a sub in the other project");
        assert_eq!(p.parent, "xp-main", "its cards still route to the main chat");
    }

    #[test]
    fn a_sub_in_another_project_still_cannot_reach_an_unknown_folder() {
        let other = tempfile::tempdir().unwrap();
        let st = state_knowing(other.path());
        row(&st, "xp-allow");
        let err = plan(&st, "xp-allow", &on(), elsewhere(), None, None, None, Some("n"), &complete(), &[]).err().expect("refused");
        assert!(err.contains("already knows"), "{err}");
    }

    /// `after` is keyed by the parent's sub names, so a sub in one project can wait
    /// on a sub in another.
    #[test]
    fn after_orders_subs_across_projects() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let other = tempfile::tempdir().unwrap();
        let st = state_knowing(other.path());
        row(&st, "xp-after");
        sub_row(&st, "xp-after-a", "xp-after", "migrate");
        let waits = plan_in(&st, "xp-after", other.path(), None, Some("api"), &after_args("migrate")).unwrap().unwrap();
        assert_eq!(waits.hold.as_ref().map(|h| h.target_name.as_str()), Some("migrate"));
    }

    // ── plain: true ────────────────────────────────────────────────────────

    fn plain() -> SubchatArgs {
        SubchatArgs { plain: Some(true), ..Default::default() }
    }

    #[test]
    fn plain_true_opens_an_ordinary_chat_in_any_known_project_without_a_brief() {
        let other = tempfile::tempdir().unwrap();
        let st = state_knowing(other.path());
        row(&st, "pl-main");
        assert!(plan_in(&st, "pl-main", other.path(), Some("look at this"), None, &plain()).unwrap().is_none(), "other project");
        assert!(plan_in(&st, "pl-main", &cwd(), Some("look at this"), None, &plain()).unwrap().is_none(), "own project");
        // Without plain the same thin call is still refused for its brief.
        assert!(plan_in(&st, "pl-main", other.path(), Some("look at this"), None, &SubchatArgs::default()).is_err());
    }

    #[test]
    fn plain_true_with_gate_or_after_is_refused() {
        let st = state();
        row(&st, "pl-bad");
        for args in [
            SubchatArgs { plain: Some(true), gate: Some(true), ..Default::default() },
            SubchatArgs { plain: Some(true), after: Some("x".into()), ..Default::default() },
        ] {
            assert_eq!(plan_in(&st, "pl-bad", &cwd(), Some("p"), None, &args).err().unwrap(), PLAIN_WITH_SUB_FIELDS);
        }
    }

    #[test]
    fn a_sub_caller_is_refused_and_a_plain_chat_is_not() {
        let st = state();
        row(&st, "main");
        sub_row(&st, "sub", "main", "job");
        assert_eq!(refuse_sub_caller(&st, "sub").unwrap_err(), DEPTH_REFUSAL);
        assert!(refuse_sub_caller(&st, "main").is_ok());
        assert!(refuse_sub_caller(&st, "ghost").is_ok());
    }

    #[test]
    fn an_api_credit_account_is_refused_even_with_the_mode_already_on() {
        use crate::accounts::{Account, AccountKind};
        let st = state();
        row(&st, "main");
        let api = Account {
            id: "api-1".into(),
            label: "api".into(),
            colour: "#fff".into(),
            icon: "key".into(),
            config_dir: std::path::PathBuf::from("C:/home/.claude-x"),
            chrome_profile_dir: std::path::PathBuf::from("C:/appdata/x"),
            email: String::new(),
            org_uuid: "ORG".into(),
            subscription_tier: String::new(),
            created_at: "2026-11-05T00:00:00Z".into(),
            fleet_eligible: false,
            kind: AccountKind::ApiCredit,
        };
        let cfg = ChatConfig { subchats_on: true, account_id: "api-1".into(), ..Default::default() };
        let here = cwd();
        let err = plan(&st, "main", &cfg, &here.to_string_lossy(), None, None, None, Some("n"), &complete(), &[api])
            .err()
            .expect("refused");
        assert!(err.contains("API-credit"), "{err}");
    }

    // ── the gate sub ───────────────────────────────────────────────────────

    const GATE_PROMPT: &str = "Joe asked: \"push it\".\n\nRun /commit's push pipeline from step 2.\n\n/close";

    fn gate_args() -> SubchatArgs {
        SubchatArgs { gate: Some(true), ..Default::default() }
    }

    fn plan_gate(st: &DaemonState, parent: &str, cfg: &ChatConfig, prompt: Option<&str>, args: &SubchatArgs) -> Result<Option<SubPlan>, String> {
        let here = cwd();
        plan(st, parent, cfg, &here.to_string_lossy(), prompt, None, None, Some("Gate: repo push"), args, &[])
    }

    /// A running gate sub of `parent`, as `spawn_chat` leaves one.
    fn running_gate(st: &DaemonState, parent: &str, id: &str) {
        sub_row(st, id, parent, "Gate: repo push");
        let brief = gate_brief(Some("go"), parent).unwrap();
        crate::sessions::chat_config::set_subchat(id, Some(brief));
    }

    #[test]
    fn a_gate_skips_the_brief_and_keeps_its_prompt_word_for_word() {
        let st = state();
        row(&st, "g-main");
        // No task, goal, done_when, writes or files: a mode-on spawn without gate would be refused.
        let p = plan_gate(&st, "g-main", &on(), Some(GATE_PROMPT), &gate_args()).unwrap().expect("a gate sub");
        assert!(p.brief.gate && p.brief.writes && !p.brief.review);
        assert_eq!(p.brief.task, "Gate and push", "its card names it");
        assert_eq!(p.first_message, GATE_PROMPT, "Joe's quoted request is not reworded or wrapped");
        assert_eq!((p.model.as_str(), p.effort.as_str()), ("sonnet", "high"), "judgement over code-check: Sonnet high");
        assert!(p.hold.is_none());
        assert!(plan_gate(&st, "g-main", &on(), Some("x"), &SubchatArgs::default()).is_err(), "without gate the thin brief is still refused");
    }

    #[test]
    fn a_gate_needs_a_prompt_and_says_so() {
        let st = state();
        row(&st, "g-nop");
        for missing in [None, Some(""), Some("  ")] {
            let err = plan_gate(&st, "g-nop", &on(), missing, &gate_args()).err().expect("refused");
            assert!(err.contains("needs a prompt") && err.contains("push request"), "{err}");
        }
    }

    #[test]
    fn a_gate_never_runs_on_opus_or_haiku_and_keeps_the_three_tiers() {
        let st = state();
        row(&st, "g-tier");
        let here = cwd();
        // A gate edits files and pushes, so it is a writer: Sonnet only.
        let err = plan(&st, "g-tier", &on(), &here.to_string_lossy(), Some("p"), Some("opus"), Some("high"), None, &gate_args(), &[]).err().unwrap();
        assert!(err.contains("Opus sub cannot edit files"), "{err}");
        let err = plan(&st, "g-tier", &on(), &here.to_string_lossy(), Some("p"), Some("haiku"), None, None, &gate_args(), &[]).err().unwrap();
        assert!(err.contains("never run on haiku"), "{err}");
    }

    #[test]
    fn gate_true_is_refused_from_a_chat_with_the_mode_off_and_plain_spawns_are_untouched() {
        let st = state();
        row(&st, "g-off");
        let err = plan_gate(&st, "g-off", &ChatConfig::default(), Some(GATE_PROMPT), &gate_args()).err().expect("refused");
        assert_eq!(err, GATE_MODE_OFF);
        assert!(err.contains("Use subchats"), "{err}");
        // Mode off without gate is exactly what it always was.
        assert!(plan_gate(&st, "g-off", &ChatConfig::default(), Some("p"), &SubchatArgs::default()).unwrap().is_none());
    }

    #[test]
    fn a_second_gate_for_one_parent_is_refused_until_the_first_finishes() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        row(&st, "g-two");
        running_gate(&st, "g-two", "g-two-first");
        let err = plan_gate(&st, "g-two", &on(), Some(GATE_PROMPT), &gate_args()).err().expect("refused");
        assert!(err.contains("already has a gate sub running") && err.contains("Gate: repo push"), "{err}");
        // Another parent has its own gate, and a plain sub is not a gate.
        row(&st, "g-three");
        plan_gate(&st, "g-three", &on(), Some(GATE_PROMPT), &gate_args()).unwrap().expect("a separate parent");
        st.registry.set_subchat_finished("g-two-first", true);
        plan_gate(&st, "g-two", &on(), Some(GATE_PROMPT), &gate_args()).unwrap().expect("the first one finished");
    }

    #[test]
    fn a_gate_in_another_project_is_not_blocked_by_a_running_gate_elsewhere() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let other = tempfile::tempdir().unwrap();
        let st = state_knowing(other.path());
        row(&st, "g-xp");
        running_gate(&st, "g-xp", "g-xp-first");
        // The running gate sits in the caller's folder, so a second one there is refused...
        let err = plan_gate(&st, "g-xp", &on(), Some(GATE_PROMPT), &gate_args()).err().expect("same project");
        assert!(err.contains("already has a gate sub running"), "{err}");
        // ...but another repo is a separate push with its own slot.
        let p = plan(&st, "g-xp", &on(), &other.path().to_string_lossy(), Some(GATE_PROMPT), None, None, None, &gate_args(), &[]).unwrap();
        assert!(p.is_some(), "a gate for the other project");
    }

    #[test]
    fn a_plain_sub_running_does_not_block_a_gate_and_a_gate_still_counts_toward_the_cap() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        row(&st, "g-cap");
        sub_row(&st, "g-cap-a", "g-cap", "a");
        plan_gate(&st, "g-cap", &on(), Some(GATE_PROMPT), &gate_args()).unwrap().expect("a plain sub is not a gate");
        for n in 0..MAX_RUNNING - 1 {
            sub_row(&st, &format!("g-cap-{n}"), "g-cap", &format!("job-{n}"));
        }
        let err = plan_gate(&st, "g-cap", &on(), Some(GATE_PROMPT), &gate_args()).err().expect("cap running");
        assert!(err.contains(&format!("At most {MAX_RUNNING}")), "a gate is a sub, so it is inside the cap: {err}");
    }

    #[test]
    fn marking_a_gate_records_the_upstream_it_started_from() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (_dir, root) = super::super::git::test_repo::init();
        let remote = tempfile::tempdir().unwrap();
        super::super::git::test_repo::git(remote.path(), &["init", "-q", "--bare"]);
        super::super::git::test_repo::git(&root, &["remote", "add", "origin", &remote.path().to_string_lossy()]);
        super::super::git::test_repo::git(&root, &["push", "-q", "-u", "origin", "HEAD:refs/heads/main"]);
        let st = state();
        st.registry.upsert_interactive("m-up", &root, "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive("g-up", &root, "proj", "2026-11-05T00:00:00Z");
        let mut p = plan(&st, "m-up", &on(), &root.to_string_lossy(), Some(GATE_PROMPT), None, None, Some("Gate"), &gate_args(), &[])
            .unwrap()
            .unwrap();
        mark_as_sub(&st, "g-up", &mut p);
        let stored = crate::sessions::chat_config::get("g-up").unwrap().subchat.unwrap();
        assert!(stored.gate);
        assert_eq!(stored.upstream_at_spawn, super::super::git::upstream(&root));
        assert!(stored.upstream_at_spawn.is_some(), "the branch has an upstream");
        // A plain sub records none: only a gate's push is measured against it.
        st.registry.upsert_interactive("p-up", &root, "proj", "2026-11-05T00:00:00Z");
        let mut plain = plan(&st, "m-up", &on(), &root.to_string_lossy(), None, None, None, Some("n"), &complete(), &[]).unwrap().unwrap();
        mark_as_sub(&st, "p-up", &mut plain);
        assert!(crate::sessions::chat_config::get("p-up").unwrap().subchat.unwrap().upstream_at_spawn.is_none());
    }

    #[test]
    fn a_gate_may_wait_for_a_sub_like_any_other() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        row(&st, "g-after");
        sub_row(&st, "g-after-fix", "g-after", "fix");
        let args = SubchatArgs { gate: Some(true), after: Some("fix".into()), ..Default::default() };
        let p = plan_gate(&st, "g-after", &on(), Some(GATE_PROMPT), &args).unwrap().unwrap();
        assert_eq!(p.hold.as_ref().map(|h| h.target_name.as_str()), Some("fix"));
        assert_eq!(p.brief.after.as_deref(), Some("fix"));
    }

    // ── after ──────────────────────────────────────────────────────────────

    fn after_args(after: &str) -> SubchatArgs {
        SubchatArgs { after: Some(after.into()), ..complete() }
    }

    #[test]
    fn a_pending_target_plans_a_hold_and_a_finished_one_plans_an_immediate_start() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        row(&st, "af-main");
        sub_row(&st, "af-run", "af-main", "header");
        sub_row(&st, "af-done", "af-main", "docs");
        st.registry.set_subchat_finished("af-done", true);
        let waits = plan_as(&st, "af-main", &on(), Some("footer"), &after_args("header")).unwrap().unwrap();
        assert_eq!(waits.hold, Some(HoldPlan { target_id: "af-run".into(), target_name: "header".into() }));
        assert_eq!(waits.brief.after.as_deref(), Some("header"));
        let now = plan_as(&st, "af-main", &on(), Some("footer"), &after_args("docs")).unwrap().unwrap();
        assert!(now.hold.is_none(), "the named sub already finished cleanly, so this one starts now");
        assert_eq!(now.brief.after.as_deref(), Some("docs"), "still recorded");
    }

    #[test]
    fn a_name_that_matches_none_or_several_is_refused_with_the_subs_listed() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        row(&st, "af2-main");
        sub_row(&st, "af2-a", "af2-main", "fix-a");
        sub_row(&st, "af2-b", "af2-main", "fix-b");
        let none = plan_as(&st, "af2-main", &on(), Some("x"), &after_args("ghost")).err().expect("refused");
        assert!(none.contains("No sub named") && none.contains("fix-a") && none.contains("fix-b"), "{none}");
        let many = plan_as(&st, "af2-main", &on(), Some("x"), &after_args("fix")).err().expect("refused");
        assert!(many.contains("more than one sub") && many.contains("fix-a") && many.contains("fix-b"), "{many}");
    }

    #[test]
    fn a_blank_after_is_no_after_and_mode_off_ignores_after_entirely() {
        let st = state();
        row(&st, "af3-main");
        let p = plan_as(&st, "af3-main", &on(), Some("x"), &after_args("  ")).unwrap().unwrap();
        assert!(p.hold.is_none() && p.brief.after.is_none());
        assert!(plan_for(&st, &ChatConfig::default(), Some("x"), &after_args("ghost")).unwrap().is_none());
    }
}
