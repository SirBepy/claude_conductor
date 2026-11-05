//! The rules a mode-on `spawn_chat` obeys before a sub exists: the brief, the
//! tier, the same-project limit, the cap of five running subs and the depth
//! limit. `spawn_chat`'s own module runs the spawn; this is only the decision.

use super::brief::{compose_first_message, validate, SubchatArgs, SubchatBrief};
use crate::daemon::state::DaemonState;
use crate::sessions::chat_config::ChatConfig;
use crate::sessions::registry::Registry;
use crate::settings::identity::project_key;
use crate::types::Instance;
use std::collections::HashMap;
use std::sync::Mutex;

/// Running subs one main chat may have at once (spec section 2).
pub const MAX_RUNNING: usize = 5;

/// A sub with no model named opens here. Joe: "normal code jobs" are Sonnet high.
const DEFAULT_MODEL: &str = "sonnet";
const DEFAULT_EFFORT: &str = "high";

/// Said when a sub tries to spawn or respawn. Depth is 1 on purpose: a sub that
/// could spawn would hide work two levels from Joe.
pub const DEPTH_REFUSAL: &str =
    "A sub cannot spawn or respawn chats. Do the work in this chat, or finish and report that it needs more jobs.";

const TIERS: &str = "sonnet at medium effort (mechanical work: a version bump, a rename, docs), \
sonnet at high effort (normal code jobs), or opus at high effort (taste or design, a bug with no clear cause, architecture)";

/// Everything the spawn needs once the rules have passed. Holding it keeps the
/// parent's cap slot reserved, so parallel `spawn_chat` calls in one turn
/// cannot all slip past the count before any row exists.
pub struct SubPlan {
    pub parent: String,
    pub brief: SubchatBrief,
    pub first_message: String,
    pub model: String,
    pub effort: String,
    reservation: Option<Reservation>,
}

impl SubPlan {
    /// Releases the reserved cap slot. Called once the sub's registry row
    /// exists, because from then on the row is what counts.
    pub fn release_slot(&mut self) {
        self.reservation = None;
    }
}

/// Marks the freshly spawned `sid` as the planned parent's sub: the registry row
/// every client reads, and the stored brief later steps read. The row is set
/// before the cap slot is released, so the sub is never uncounted in between.
pub fn mark_as_sub(state: &DaemonState, sid: &str, plan: &mut SubPlan) {
    state.registry.set_subchat_of(sid, Some(plan.parent.clone()));
    crate::sessions::chat_config::set_subchat(sid, Some(plan.brief.clone()));
    plan.release_slot();
}

/// `parent` -> spawns that passed the cap check but have no registry row yet.
static PENDING: Mutex<Option<HashMap<String, usize>>> = Mutex::new(None);

struct Reservation {
    parent: String,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let mut guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(map) = guard.as_mut() {
            if let Some(n) = map.get_mut(&self.parent) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    map.remove(&self.parent);
                }
            }
        }
    }
}

/// Subs of `parent` that count against the cap: not ended and not finished.
pub fn running_subs(registry: &Registry, parent: &str) -> Vec<Instance> {
    registry
        .list()
        .into_iter()
        .filter(|i| i.subchat_of.as_deref() == Some(parent))
        .filter(|i| i.ended_at.is_none() && i.end_reason.is_none() && !i.subchat_finished)
        .collect()
}

fn label(i: &Instance) -> String {
    i.name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| i.session_id.chars().take(8).collect())
}

fn cap_error(running: &[Instance], pending: usize) -> String {
    let mut names: Vec<String> = running.iter().map(label).collect();
    if pending > 0 {
        names.push(format!("{pending} more being started"));
    }
    format!(
        "At most {MAX_RUNNING} subs can run at once and these are running: {}. Wait for one to finish, or hand this job to one of them with the subchat tool.",
        names.join(", ")
    )
}

fn reserve(registry: &Registry, parent: &str) -> Result<Reservation, String> {
    let mut guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    let running = running_subs(registry, parent);
    let pending = map.get(parent).copied().unwrap_or(0);
    if running.len() + pending >= MAX_RUNNING {
        return Err(cap_error(&running, pending));
    }
    *map.entry(parent.to_string()).or_insert(0) += 1;
    Ok(Reservation { parent: parent.to_string() })
}

/// The explicit model and effort for a sub. Both are passed on to the spawn so
/// `resolve_model_effort` never reaches for the project default; an omitted one
/// takes the Sonnet-high default. Haiku is refused outright.
pub fn resolve_tier(model: Option<&str>, effort: Option<&str>) -> Result<(String, String), String> {
    let pick = |v: Option<&str>, default: &str| {
        v.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(default).to_string()
    };
    let model = pick(model, DEFAULT_MODEL);
    if model.to_ascii_lowercase().contains("haiku") {
        return Err(format!("Subs never run on haiku. Pick one of the three tiers: {TIERS}."));
    }
    Ok((model, pick(effort, DEFAULT_EFFORT)))
}

/// A sub stays in its main chat's project. `target` is the already-resolved
/// spawn directory, `caller_cwd` the main chat's own.
pub fn check_same_project(caller_cwd: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    if project_key(caller_cwd) == project_key(target) {
        return Ok(());
    }
    Err(format!(
        "A sub works in its main chat's own project ({}). Spawn it there, or start a normal chat for the other project without the subchats fields.",
        caller_cwd.display()
    ))
}

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
    if !inherited.subchats_on {
        return Ok(None);
    }
    // The mode refuses an API-credit chat when it is turned on, but the account
    // can change under a chat that already has it on.
    let account = Some(inherited.account_id.as_str()).filter(|a| !a.is_empty());
    if let Some(reason) = super::refusal_for_account(account, accounts) {
        return Err(reason.to_string());
    }
    let brief = validate(name, args, caller_id)?;
    let (model, effort) = resolve_tier(model, effort)?;
    let target = crate::daemon::methods::spawn_chat::resolve_target_cwd(
        &caller.cwd,
        std::path::Path::new(cwd),
        &state.settings.snapshot().projects,
    )?;
    check_same_project(&caller.cwd, &target)?;
    let reservation = reserve(&state.registry, caller_id)?;
    let first_message = compose_first_message(&brief, prompt);
    Ok(Some(SubPlan {
        parent: caller_id.to_string(),
        brief,
        first_message,
        model,
        effort,
        reservation: Some(reservation),
    }))
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

    fn sub_row(st: &DaemonState, id: &str, parent: &str, name: &str) {
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
        let here = cwd();
        plan(st, "main", cfg, &here.to_string_lossy(), None, None, None, name, args, &[])
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
        let err = resolve_tier(Some("haiku"), None).unwrap_err();
        assert!(err.contains("sonnet at medium") && err.contains("sonnet at high") && err.contains("opus at high"), "{err}");
        assert!(resolve_tier(Some("claude-haiku-4-5"), Some("low")).is_err());
        assert_eq!(resolve_tier(Some("opus"), Some("high")).unwrap(), ("opus".to_string(), "high".to_string()));
    }

    #[test]
    fn an_omitted_tier_is_sonnet_high_not_the_project_default() {
        assert_eq!(resolve_tier(None, None).unwrap(), ("sonnet".to_string(), "high".to_string()));
        assert_eq!(resolve_tier(Some("  "), Some("")).unwrap(), ("sonnet".to_string(), "high".to_string()));
        // Passed on explicitly, `resolve_model_effort` takes them over the project default.
        let mut settings = Settings::default();
        settings.extra.insert("defaultModel".into(), serde_json::json!("fable"));
        let st = DaemonState::new(new_session_map(), SettingsCache::new(settings));
        let (m, e) = resolve_tier(None, None).unwrap();
        let got = crate::daemon::methods::spawn_chat::resolve_model_effort(
            &st, &cwd(), Some(&m), Some(&e), &ChatConfig::default(), false,
        );
        assert_eq!(got, ("sonnet".to_string(), "high".to_string()));
    }

    #[test]
    fn a_sixth_running_sub_is_refused_naming_the_five() {
        let st = state();
        row(&st, "main");
        for n in 0..5 {
            sub_row(&st, &format!("sub{n}"), "main", &format!("job-{n}"));
        }
        let err = plan_for(&st, &on(), Some("sixth"), &complete()).err().expect("capped");
        for n in 0..5 {
            assert!(err.contains(&format!("job-{n}")), "job-{n} not named: {err}");
        }
    }

    #[test]
    fn a_finished_or_ended_sub_does_not_count_toward_the_cap() {
        let st = state();
        row(&st, "main");
        for n in 0..5 {
            sub_row(&st, &format!("sub{n}"), "main", &format!("job-{n}"));
        }
        st.registry.set_subchat_finished("sub0", true);
        assert_eq!(running_subs(&st.registry, "main").len(), 4);
        plan_for(&st, &on(), Some("sixth"), &complete()).unwrap().expect("one slot free");
    }

    #[test]
    fn another_mains_subs_do_not_count() {
        let st = state();
        row(&st, "main");
        row(&st, "other");
        for n in 0..5 {
            sub_row(&st, &format!("sub{n}"), "other", &format!("job-{n}"));
        }
        plan_for(&st, &on(), Some("mine"), &complete()).unwrap().expect("a separate main has its own cap");
    }

    #[test]
    fn parallel_spawns_reserve_slots_before_any_row_exists() {
        let st = state();
        row(&st, "main");
        let mut held = Vec::new();
        for _ in 0..5 {
            held.push(plan_for(&st, &on(), Some("n"), &complete()).unwrap().unwrap());
        }
        let err = plan_for(&st, &on(), Some("n"), &complete()).err().expect("sixth blocked while five are in flight");
        assert!(err.contains("being started"), "{err}");
        held.pop().unwrap().release_slot();
        plan_for(&st, &on(), Some("n"), &complete()).unwrap().expect("a released slot frees the cap");
    }

    #[test]
    fn marking_a_spawned_row_sets_the_parent_link_stores_the_brief_and_frees_the_slot() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        row(&st, "main");
        row(&st, "new-sub");
        let mut p = plan_for(&st, &on(), Some("header"), &complete()).unwrap().unwrap();
        mark_as_sub(&st, "new-sub", &mut p);
        let inst = st.registry.get("new-sub").unwrap();
        assert_eq!(inst.subchat_of.as_deref(), Some("main"));
        let stored = crate::sessions::chat_config::get("new-sub").unwrap().subchat.expect("brief stored");
        assert_eq!((stored.parent.as_str(), stored.task.as_str(), stored.writes), ("main", "t", false));
        assert!(crate::sessions::chat_config::sub_session_ids().contains("new-sub"));
        // The row counts now and the reservation is gone: 1 running + 4 in flight
        // fills the cap, so a double-counted slot would refuse the fourth plan.
        let mut held = Vec::new();
        for _ in 0..4 {
            held.push(plan_for(&st, &on(), Some("n"), &complete()).unwrap().unwrap());
        }
        assert!(plan_for(&st, &on(), Some("n"), &complete()).is_err());
    }

    #[test]
    fn a_cwd_outside_the_main_chats_project_is_refused() {
        let st = state();
        row(&st, "main");
        let elsewhere = if cfg!(windows) { "C:\\Windows" } else { "/etc" };
        let err = plan(&st, "main", &on(), elsewhere, None, None, None, Some("n"), &complete(), &[]).err().expect("refused");
        assert!(err.contains("working directory") || err.contains("own project"), "{err}");
    }

    #[test]
    fn a_known_but_different_project_is_refused_for_a_sub() {
        let caller = std::path::PathBuf::from(if cfg!(windows) { "C:\\proj-a" } else { "/proj-a" });
        let other = std::path::PathBuf::from(if cfg!(windows) { "C:\\proj-b" } else { "/proj-b" });
        assert!(check_same_project(&caller, &caller).is_ok());
        let err = check_same_project(&caller, &other).unwrap_err();
        assert!(err.contains("own project"), "{err}");
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
}
