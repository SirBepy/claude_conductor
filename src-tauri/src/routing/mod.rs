//! Routing rules (pc-1833 phase 1b): which account, model and effort a kind of
//! work runs on. One pure function, [`resolve_with`], decides ([`resolve`] is its
//! form with no usage-limit probe); the spawn paths (`spawn_chat`, a sub's
//! `plan`, a scheduled new chat) call it and apply what it returns. Read docs/architecture/providers.md before editing.
//!
//! Precedence, each field on its own: an explicit pick, then the project's
//! override for the kind, then the rule of the project's payment group, then
//! "today" (the field comes back `None` and the caller applies the project or
//! global default, the caller's own account, `resolve_model_effort`).

use crate::accounts::{Account, AccountKind};
use crate::settings::identity::project_key;
use crate::types::{ProjectConfig, RouteFallback, RouteRange, RouteRule, Settings};

pub mod limits;

#[cfg(test)]
mod tests;

/// The payment group a project with none set bills under.
pub const PERSONAL_GROUP: &str = "personal";

/// Kinds the app knows today. Not a closed set: any string is a kind, and one
/// with no rule resolves like today. The shared kinds table (Plan card) will
/// replace this list.
pub const KNOWN_KINDS: [&str; 13] = [
    "main_chat", "new_chat", "talk", "plan", "build", "review", "release", "fix", "gate", "test", "triage", "research", "errand",
];

const CLAUDE_MODELS: [&str; 4] = ["haiku", "sonnet", "opus", "fable"];
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// Where a resolved field came from, best first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Explicit,
    ProjectOverride,
    GroupRule,
    /// Nothing decided it: the caller applies today's behaviour.
    Default,
}

/// What the caller named for this spawn.
#[derive(Clone, Copy, Debug, Default)]
pub struct Explicit<'a> {
    pub account_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FieldSources {
    pub account: Source,
    pub model: Source,
    pub effort: Source,
}

/// `None` in a field means "no rule decided it": apply today's behaviour.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub account_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub sources: FieldSources,
    /// The best RULE tier that decided any field (project override, then group
    /// rule), `Default` when none did. An explicit pick does not count here, so
    /// "was a rule applied" reads straight off this.
    pub source: Source,
    /// Said to the caller (the spawn result): a clamp, a dropped model.
    pub notes: Vec<String>,
}

fn blank(v: Option<&str>) -> Option<&str> {
    v.map(str::trim).filter(|s| !s.is_empty())
}

/// The project registered for `cwd` (or the repo a worktree belongs to).
pub fn project_for<'a>(settings: &'a Settings, cwd: &std::path::Path) -> Option<&'a ProjectConfig> {
    let key = project_key(cwd);
    settings.projects.iter().find(|p| project_key(&p.path) == key)
}

/// The group id a project bills under.
pub fn group_of(project: Option<&ProjectConfig>) -> &str {
    blank(project.and_then(|p| p.payment_group.as_deref())).unwrap_or(PERSONAL_GROUP)
}

/// The two rules that can decide `kind`, best first.
fn rules_for<'a>(settings: &'a Settings, project: Option<&'a ProjectConfig>, kind: &str) -> [(Source, Option<&'a RouteRule>); 2] {
    let over = project.and_then(|p| p.routing_overrides.get(kind));
    let group = settings.routing.groups.get(group_of(project)).and_then(|g| g.get(kind));
    [(Source::ProjectOverride, over), (Source::GroupRule, group)]
}

/// Whether any rule exists for `kind`: a spawn with none skips the accounts read.
pub fn has_rules(settings: &Settings, project: Option<&ProjectConfig>, kind: &str) -> bool {
    rules_for(settings, project, kind).iter().any(|(_, r)| r.is_some())
}

fn model_rank(model: &str, account: Option<&Account>) -> Option<usize> {
    if let Some(list) = account.filter(|a| a.is_endpoint()).and_then(|a| a.endpoint.as_ref()).map(|e| &e.models) {
        return list.iter().position(|m| m == model);
    }
    let low = model.to_ascii_lowercase();
    CLAUDE_MODELS.iter().position(|f| low.contains(f))
}

fn effort_rank(effort: &str) -> Option<usize> {
    let low = effort.to_ascii_lowercase();
    EFFORTS.iter().position(|e| *e == low)
}

/// `value` pulled into `[min, max]` by `rank`; `None` when it already fits or
/// cannot be ranked. A bound that cannot be ranked is ignored, and so is a
/// range whose minimum sits above its maximum.
fn clamp<'a>(value: &str, min: Option<&'a str>, max: Option<&'a str>, rank: &dyn Fn(&str) -> Option<usize>) -> Option<(&'a str, &'static str)> {
    let v = rank(value)?;
    let lo = blank(min).and_then(|m| rank(m).map(|r| (m, r)));
    let hi = blank(max).and_then(|m| rank(m).map(|r| (m, r)));
    if let (Some((_, l)), Some((_, h))) = (lo, hi) {
        if l > h {
            return None;
        }
    }
    match (lo, hi) {
        (Some((m, l)), _) if v < l => Some((m, "below")),
        (_, Some((m, h))) if v > h => Some((m, "above")),
        _ => None,
    }
}

fn clamp_explicit(
    range: &RouteRange,
    account: Option<&Account>,
    model: &mut Option<String>,
    effort: &mut Option<String>,
    sources: &FieldSources,
    kind: &str,
    notes: &mut Vec<String>,
) {
    if sources.model == Source::Explicit {
        if let Some(m) = model.clone() {
            let rank = |s: &str| model_rank(s, account);
            if let Some((bound, side)) = clamp(&m, range.min_model.as_deref(), range.max_model.as_deref(), &rank) {
                notes.push(format!("model {m} is {side} the range set for {kind} work, so {bound} is used instead"));
                *model = Some(bound.to_string());
            }
        }
    }
    if sources.effort == Source::Explicit {
        if let Some(e) = effort.clone() {
            if let Some((bound, side)) = clamp(&e, range.min_effort.as_deref(), range.max_effort.as_deref(), &effort_rank) {
                notes.push(format!("effort {e} is {side} the range set for {kind} work, so {bound} is used instead"));
                *effort = Some(bound.to_string());
            }
        }
    }
}

/// [`resolve_with`] that never sees a usage limit: a rule's `fallback` stays unused.
pub fn resolve(
    settings: &Settings,
    project: Option<&ProjectConfig>,
    accounts: &[Account],
    kind: &str,
    base_account_id: Option<&str>,
    explicit: Explicit<'_>,
) -> Resolved {
    resolve_with(settings, project, accounts, kind, base_account_id, explicit, &|_| None)
}

/// What a rule's `fallback` does when the account a spawn would take is at its
/// usage limit. Returns the account to run on instead, if any, and says why in
/// `notes`. Only an account a rule or the caller's default chose is ever moved;
/// an explicit pick never gets here.
fn apply_fallback<'a>(
    rules: [(Source, Option<&'a RouteRule>); 2],
    account_src: Source,
    current: &Account,
    find: &dyn Fn(&str) -> Option<&'a Account>,
    limits: &dyn Fn(&Account) -> Option<limits::Limit>,
    kind: &str,
    notes: &mut Vec<String>,
) -> Option<(String, Source)> {
    // The rule that picked the account owns the fallback (an override with none
    // does not inherit the group's); with no rule account, the best rule that has one.
    let (src, fallback) = if matches!(account_src, Source::ProjectOverride | Source::GroupRule) {
        let rule = rules.iter().find(|(s, _)| *s == account_src).and_then(|(_, r)| *r)?;
        (account_src, rule.fallback.as_ref()?)
    } else {
        rules.iter().find_map(|(s, r)| r.and_then(|r| r.fallback.as_ref()).map(|f| (*s, f)))?
    };
    let limit = limits(current)?;
    let name = &current.label;
    match fallback {
        RouteFallback::Wait => {
            notes.push(format!("{name} is at {}; the {kind} rule waits for it to reset, so the chat starts blocked until then", limit.describe()));
            None
        }
        RouteFallback::Account { account_id } => {
            let target = find(account_id).filter(|a| a.kind != AccountKind::ApiCredit && a.id != current.id);
            match target {
                Some(t) if limits(t).is_none() => {
                    notes.push(format!("{name} is at {}; using {}", limit.describe(), t.label));
                    Some((t.id.clone(), src))
                }
                Some(t) => {
                    notes.push(format!("{name} is at {} and so is the fallback {}; the chat starts blocked until the reset", limit.describe(), t.label));
                    None
                }
                None => {
                    notes.push(format!("{name} is at {}; the {kind} rule's fallback account is not usable, so the chat starts blocked until the reset", limit.describe()));
                    None
                }
            }
        }
    }
}

/// Picks account, model and effort for one spawn of `kind`.
///
/// `base_account_id` is the account the spawn would take with no rule (the
/// caller's own for a chat spawned by a chat, the default account otherwise):
/// a rule's model is validated against the account the spawn will actually run
/// on, which is the rule's account when it names one, else this.
pub fn resolve_with(
    settings: &Settings,
    project: Option<&ProjectConfig>,
    accounts: &[Account],
    kind: &str,
    base_account_id: Option<&str>,
    explicit: Explicit<'_>,
    limits: &dyn Fn(&Account) -> Option<limits::Limit>,
) -> Resolved {
    let rules = rules_for(settings, project, kind);
    let mut notes = Vec::new();
    let find = |id: &str| accounts.iter().find(|a| a.id == id);

    // Account.
    let mut account_id: Option<String> = None;
    let mut account_src = Source::Default;
    if let Some(id) = blank(explicit.account_id) {
        account_id = Some(id.to_string());
        account_src = Source::Explicit;
    } else {
        for (src, rule) in rules {
            let Some(id) = rule.and_then(|r| blank(r.account_id.as_deref())) else { continue };
            match find(id) {
                Some(a) if a.kind != AccountKind::ApiCredit => {
                    account_id = Some(id.to_string());
                    account_src = src;
                    break;
                }
                Some(_) => log::warn!("[routing] the {kind} rule names account {id}, an API-credit account no rule may use; falling through"),
                None => log::warn!("[routing] the {kind} rule names account {id}, which no longer exists; falling through"),
            }
        }
    }
    let mut moved = false;
    let mut effective = account_id.as_deref().or(blank(base_account_id)).and_then(find);
    if account_src != Source::Explicit {
        if let Some(current) = effective {
            if let Some((id, src)) = apply_fallback(rules, account_src, current, &find, limits, kind, &mut notes) {
                effective = find(&id);
                account_id = Some(id);
                account_src = src;
                moved = true;
            }
        }
    }

    // Model.
    let mut model: Option<String> = None;
    let mut model_src = Source::Default;
    if let Some(m) = blank(explicit.model) {
        // An Endpoint account a rule picked serves its own models: a Claude tier
        // the main chat passed would reach the provider as an id it has never
        // heard of. An empty list serves any id, so then the pick stands.
        let foreign = matches!(account_src, Source::ProjectOverride | Source::GroupRule)
            && effective.filter(|a| a.is_endpoint()).and_then(|a| a.endpoint.as_ref()).is_some_and(|e| !e.models.is_empty() && !e.models.iter().any(|x| x == m));
        if foreign {
            notes.push(format!("model {m} is not one of the models of the account the {kind} rule picked, so the rule's model is used"));
        } else {
            model = Some(m.to_string());
            model_src = Source::Explicit;
        }
    }
    if model.is_none() {
        for (src, rule) in rules {
            let Some(m) = rule.and_then(|r| blank(r.model.as_deref())) else { continue };
            // A model written for the rule's own account (a Claude tier) means nothing to
            // a different Endpoint account the fallback moved the spawn to.
            let off_list = moved && effective.and_then(|a| a.endpoint.as_ref()).is_some_and(|e| !e.models.is_empty() && !e.models.iter().any(|x| x == m));
            let ok = match effective {
                Some(_) if off_list => false,
                Some(a) => crate::daemon::lifecycle::is_valid_model_for(m, a),
                None => crate::daemon::lifecycle::is_valid_model(m),
            };
            if ok {
                model = Some(m.to_string());
                model_src = src;
                break;
            }
            log::warn!("[routing] the {kind} rule's model {m} is not valid for the account it runs on; falling through");
        }
    }
    // An Endpoint account never gets a Claude tier by default: its own first model.
    if model.is_none() {
        model = effective.filter(|a| a.is_endpoint()).and_then(|a| a.endpoint.as_ref()).and_then(|e| e.models.first().cloned());
    }

    // Effort.
    let mut effort: Option<String> = None;
    let mut effort_src = Source::Default;
    if let Some(e) = blank(explicit.effort) {
        effort = Some(e.to_string());
        effort_src = Source::Explicit;
    } else {
        for (src, rule) in rules {
            let Some(e) = rule.and_then(|r| blank(r.effort.as_deref())) else { continue };
            if effort_rank(e).is_some() {
                effort = Some(e.to_ascii_lowercase());
                effort_src = src;
                break;
            }
            log::warn!("[routing] the {kind} rule's effort {e} is not a known effort; falling through");
        }
    }

    let sources = FieldSources { account: account_src, model: model_src, effort: effort_src };
    if let Some(range) = rules.iter().find_map(|(_, r)| r.and_then(|r| r.range.as_ref())) {
        clamp_explicit(range, effective, &mut model, &mut effort, &sources, kind, &mut notes);
    }

    let rule_tier = [sources.account, sources.model, sources.effort]
        .into_iter()
        .filter(|s| matches!(s, Source::ProjectOverride | Source::GroupRule))
        .min_by_key(|s| matches!(s, Source::GroupRule));
    Resolved { account_id, model, effort, sources, source: rule_tier.unwrap_or(Source::Default), notes }
}

/// What a spawn did with a rule, for the spawn result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Applied {
    pub kind: String,
    pub account_id: Option<String>,
    pub model: String,
    pub effort: String,
    pub source: Source,
    pub notes: Vec<String>,
}

impl Applied {
    /// `Some` only when a rule decided something or there is a note to say.
    pub fn of(kind: &str, r: &Resolved, model: &str, effort: &str, extra_notes: Vec<String>) -> Option<Applied> {
        let mut notes = r.notes.clone();
        notes.extend(extra_notes);
        (r.source != Source::Default || !notes.is_empty()).then(|| Applied {
            kind: kind.to_string(),
            account_id: r.account_id.clone(),
            model: model.to_string(),
            effort: effort.to_string(),
            source: r.source,
            notes,
        })
    }

    /// The `routing` object and `routing_note` text a spawn result carries.
    pub fn attach(&self, result: &mut serde_json::Value) {
        let source = match self.source {
            Source::Explicit => "explicit",
            Source::ProjectOverride => "project_override",
            Source::GroupRule => "group_rule",
            Source::Default => "default",
        };
        let Some(obj) = result.as_object_mut() else { return };
        obj.insert(
            "routing".to_string(),
            serde_json::json!({"kind": self.kind, "account_id": self.account_id, "model": self.model, "effort": self.effort, "source": source}),
        );
        if !self.notes.is_empty() {
            obj.insert("routing_note".to_string(), serde_json::json!(self.notes.join("; ")));
        }
    }
}
