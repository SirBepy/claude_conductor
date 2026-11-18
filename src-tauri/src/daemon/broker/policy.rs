//! What the engine asks before it spends a secret. Step 3b supplies the real
//! implementation (the hot-reloaded `broker-policy.json`); the engine only knows
//! this trait, and its tests use a double.

use super::guards::Method;
use super::services::Service;

/// One call as the policy sees it, after the guards passed.
#[derive(Debug, Clone)]
pub struct PolicyRequest<'a> {
    pub session: &'a str,
    pub service: Service,
    pub method: Method,
    /// Path without query.
    pub path: &'a str,
    pub query: Option<&'a str>,
    /// True for a GET and for a Linear query document: nothing is changed.
    pub read: bool,
    /// For a Linear mutation, the single root field (`commentCreate`).
    pub linear_op: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyDecision {
    /// `require_owner`: the engine must also prove the target object is Joe's
    /// (Shortcut story or epic, Linear issue) before sending.
    Allow { require_owner: bool },
    /// `hint` is shown to the chat verbatim: the exact policy line to add.
    Deny { reason: String, hint: Option<String> },
}

pub trait Policy: Send + Sync {
    fn decide(&self, req: &PolicyRequest<'_>) -> PolicyDecision;
}
