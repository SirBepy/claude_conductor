//! A sub's account, model and effort once routing rules (`crate::routing`) have
//! had their say. The tier rules of `resolve_tier` still bind every Claude
//! account; an Endpoint account serves its own models, so they do not apply.

use super::resolve_tier;
use crate::accounts::Account;
use crate::daemon::state::DaemonState;
use crate::routing::{self, Applied, Explicit, Source};
use crate::sessions::chat_config::ChatConfig;

pub(super) struct Routed {
    pub model: String,
    pub effort: String,
    /// Set only when a rule picked the account; `None` keeps the main chat's.
    pub account_id: Option<String>,
    pub applied: Option<Applied>,
}

/// Said when an Endpoint account has no model to run: neither the rule, the
/// main chat nor the account's own list names one.
fn no_model(account: &Account) -> String {
    format!(
        "Account {} has no model listed and no rule or model argument named one, so the sub has nothing to run. Add a model to the account, or name one in the routing rule.",
        account.label
    )
}

/// The routing kind of a sub. Derived from what a brief carries today: a writing
/// sub is `build`, a read-only one `research`, a gate `gate`. It switches to
/// `subchats::kind::of_brief` once that module (the shared kinds table) lands.
pub(super) fn route_kind_for_sub(writes: bool, gate: bool) -> &'static str {
    if gate {
        "gate"
    } else if writes {
        "build"
    } else {
        "research"
    }
}

/// `model` and `effort` are what the main chat passed (the gate default already
/// applied). A rule that asks for something the tier rules refuse (Opus for a
/// writer) falls back to the tier default with a note: never a silent change and
/// never a refused spawn. What the main chat itself passed is still refused.
pub(super) fn route_sub(
    state: &DaemonState,
    inherited: &ChatConfig,
    target: &std::path::Path,
    kind: &str,
    writes: bool,
    gate: bool,
    model: Option<&str>,
    effort: Option<&str>,
    accounts: &[Account],
) -> Result<Routed, String> {
    let settings = state.settings.snapshot();
    let project = routing::project_for(&settings, target);
    let base = Some(inherited.account_id.as_str()).filter(|a| !a.is_empty());
    let r = routing::resolve(&settings, project, accounts, kind, base, Explicit { account_id: None, model, effort });
    let account = r.account_id.as_deref().or(base).and_then(|id| accounts.iter().find(|a| a.id == id));

    let (model, effort, extra) = if account.is_some_and(Account::is_endpoint) {
        let m = r.model.clone().ok_or_else(|| no_model(account.expect("endpoint account")))?;
        let e = r.effort.clone().unwrap_or_else(|| if gate { "high" } else { "medium" }.to_string());
        (m, e, Vec::new())
    } else {
        match resolve_tier(r.model.as_deref(), r.effort.as_deref(), writes) {
            Ok((m, e)) => (m, e, Vec::new()),
            Err(refused) => {
                let ruled = |s: Source| matches!(s, Source::ProjectOverride | Source::GroupRule);
                if !ruled(r.sources.model) && !ruled(r.sources.effort) {
                    return Err(refused);
                }
                // Only the main chat's own picks, so the fallback is the tier default.
                let own = |s: Source, v: &Option<String>| (s == Source::Explicit).then(|| v.clone()).flatten();
                let (m, e) = resolve_tier(own(r.sources.model, &r.model).as_deref(), own(r.sources.effort, &r.effort).as_deref(), writes)
                    .map_err(|_| refused.clone())?;
                let note = format!(
                    "the {kind} rule asked for {} at {} effort, which a {} sub cannot run, so the tier default {m} at {e} effort is used",
                    r.model.as_deref().unwrap_or("the default model"),
                    r.effort.as_deref().unwrap_or("default"),
                    if writes { "writing" } else { "read-only" },
                );
                (m, e, vec![note])
            }
        }
    };
    let applied = Applied::of(kind, &r, &model, &effort, extra);
    Ok(Routed { model, effort, account_id: r.account_id, applied })
}

#[cfg(test)]
mod tests;
