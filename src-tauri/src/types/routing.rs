//! Routing rules: which account, model and effort a kind of work runs on
//! (pc-1833 phase 1b). A kind is a plain string (`build`, `review`, ...), never
//! a closed enum: the kinds table is shared with the Plan card and an unknown
//! kind simply has no rule. See docs/architecture/providers.md.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// `Settings.routing`: payment group id (`personal`, `client`, more later) ->
/// kind -> rule. A project picks its group with `ProjectConfig.payment_group`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct RoutingConfig {
    #[serde(default)]
    pub groups: HashMap<String, HashMap<String, RouteRule>>,
}

/// One kind's rule. Every field is optional and resolves on its own: a rule may
/// set only the account, only the model, and so on.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct RouteRule {
    #[serde(default)]
    #[ts(optional)]
    pub account_id: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub model: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub effort: Option<String>,
    /// What to do when the account is at its usage limit, checked at spawn time
    /// (`routing::limits`).
    #[serde(default)]
    #[ts(optional)]
    pub fallback: Option<RouteFallback>,
    /// Bounds a main chat's explicit model and effort are clamped into.
    #[serde(default)]
    #[ts(optional)]
    pub range: Option<RouteRange>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum RouteFallback {
    /// Run on this account instead. A blank id reads as "fallback account not
    /// usable", so an incomplete entry never fails the whole settings file.
    Account {
        #[serde(default)]
        account_id: String,
    },
    /// Wait for the limit to reset.
    Wait,
}

/// Claude models order haiku < sonnet < opus < fable; efforts low < medium <
/// high < xhigh < max; an Endpoint account's models by position in its list.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct RouteRange {
    #[serde(default)]
    #[ts(optional)]
    pub min_model: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub max_model: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub min_effort: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub max_effort: Option<String>,
}
