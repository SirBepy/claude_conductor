//! Ownership checks: a policy row with `require_owner` lets a write through only
//! when the object it changes is Joe's. The engine fetches the object with the
//! service's own secret and these functions judge the answer; nothing here does
//! I/O, so every rule is a plain test.
//!
//! - Shortcut: a story or epic is Joe's when his member id is in `owner_ids` or
//!   is its `requested_by_id` (the person who filed it). The target is read from
//!   the request path (`/api/v3/stories/{id}[/...]`, `/api/v3/epics/{id}[/...]`).
//! - Linear: an issue is Joe's when he is its `creator` or `assignee`. The
//!   target comes from the mutation's variables, never its text (`graphql.rs`
//!   refuses literal arguments), per named operation.
//!
//! A call whose target cannot be named is not owned: the answer is "no",
//! never "assume yes".

use super::graphql::{GqlKind, GqlRequest};
use serde_json::Value;

/// A Shortcut object kind the path can name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutKind {
    Story,
    Epic,
}

impl ShortcutKind {
    pub fn collection(self) -> &'static str {
        match self {
            ShortcutKind::Story => "stories",
            ShortcutKind::Epic => "epics",
        }
    }
}

/// `/api/v3/stories/123/comments` -> (Story, 123). Anything that is not a
/// story or epic with a plain numeric id has no owner to check.
pub fn shortcut_target(path: &str) -> Option<(ShortcutKind, u64)> {
    let rest = path.strip_prefix("/api/v3/")?;
    let mut segs = rest.split('/');
    let kind = match segs.next()? {
        "stories" => ShortcutKind::Story,
        "epics" => ShortcutKind::Epic,
        _ => return None,
    };
    let id = segs.next()?;
    if id.is_empty() || id.len() > 18 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    id.parse().ok().map(|n| (kind, n))
}

pub fn shortcut_owned(obj: &Value, me: &str) -> bool {
    let in_owners = obj["owner_ids"].as_array().is_some_and(|a| a.iter().any(|v| v.as_str() == Some(me)));
    in_owners || obj["requested_by_id"].as_str() == Some(me)
}

/// The Linear issue a mutation acts on, from its variables.
pub fn linear_target(gql: &GqlRequest) -> Option<String> {
    let GqlKind::Mutation { field, .. } = &gql.kind else { return None };
    let id = match field.as_str() {
        "commentCreate" => gql.arg_variable("input")?.get("issueId")?.as_str()?,
        "issueUpdate" => gql.arg_variable("id")?.as_str()?,
        _ => return None,
    };
    let plain = !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    plain.then(|| id.to_string())
}

pub fn linear_owned(issue: &Value, me: &str) -> bool {
    issue["creator"]["id"].as_str() == Some(me) || issue["assignee"]["id"].as_str() == Some(me)
}

/// GraphQL the engine sends for the check (fixed text; only `$id` varies).
pub const LINEAR_ISSUE_QUERY: &str = "query($id: String!) { issue(id: $id) { id creator { id } assignee { id } } }";
pub const LINEAR_VIEWER_QUERY: &str = "{ viewer { id } }";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::broker::graphql::parse_body;
    use serde_json::json;

    #[test]
    fn shortcut_targets_come_from_story_and_epic_paths_only() {
        assert_eq!(shortcut_target("/api/v3/stories/123"), Some((ShortcutKind::Story, 123)));
        assert_eq!(shortcut_target("/api/v3/stories/123/comments"), Some((ShortcutKind::Story, 123)));
        assert_eq!(shortcut_target("/api/v3/epics/9"), Some((ShortcutKind::Epic, 9)));
        for p in ["/api/v3/stories", "/api/v3/stories/", "/api/v3/stories/abc", "/api/v3/stories/12x", "/api/v3/labels/5", "/api/v3/search", "/api/v3/stories/-1"] {
            assert_eq!(shortcut_target(p), None, "{p}");
        }
    }

    #[test]
    fn a_shortcut_object_is_owned_by_owner_or_requester_only() {
        let me = "me-uuid";
        assert!(shortcut_owned(&json!({"owner_ids": ["x", "me-uuid"]}), me));
        assert!(shortcut_owned(&json!({"owner_ids": [], "requested_by_id": "me-uuid"}), me));
        assert!(!shortcut_owned(&json!({"owner_ids": ["x"], "requested_by_id": "y"}), me));
        assert!(!shortcut_owned(&json!({}), me));
        assert!(!shortcut_owned(&json!({"owner_ids": "me-uuid"}), me), "a string is not a list of owners");
    }

    fn gql(q: &str, vars: Value) -> GqlRequest {
        parse_body(&json!({ "query": q, "variables": vars })).unwrap()
    }

    #[test]
    fn linear_targets_come_from_variables_per_named_operation() {
        let c = gql(
            "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
            json!({"input": {"issueId": "MOB-12", "body": "hi"}}),
        );
        assert_eq!(linear_target(&c).as_deref(), Some("MOB-12"));
        let u = gql(
            "mutation($id: String!, $in: IssueUpdateInput!) { issueUpdate(id: $id, input: $in) { success } }",
            json!({"id": "4f0c-aa", "in": {"title": "x"}}),
        );
        assert_eq!(linear_target(&u).as_deref(), Some("4f0c-aa"));
        // A renamed variable is followed through the argument binding.
        let renamed = gql(
            "mutation($c: CommentCreateInput!) { commentCreate(input: $c) { success } }",
            json!({"c": {"issueId": "MOB-7"}}),
        );
        assert_eq!(linear_target(&renamed).as_deref(), Some("MOB-7"));
    }

    #[test]
    fn linear_has_no_target_for_create_a_missing_variable_or_a_strange_id() {
        let create = gql("mutation($i: IssueCreateInput!) { issueCreate(input: $i) { success } }", json!({"i": {"title": "t"}}));
        assert_eq!(linear_target(&create), None);
        let no_var = gql("mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }", json!({}));
        assert_eq!(linear_target(&no_var), None);
        let odd = gql(
            "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
            json!({"input": {"issueId": "MOB-1\") { x"}}),
        );
        assert_eq!(linear_target(&odd), None);
        let number = gql("mutation($id: String!, $i: I!) { issueUpdate(id: $id, input: $i) { success } }", json!({"id": 5, "i": {}}));
        assert_eq!(linear_target(&number), None);
        let query = gql("{ viewer { id } }", json!({}));
        assert_eq!(linear_target(&query), None);
    }

    #[test]
    fn a_linear_issue_is_owned_by_creator_or_assignee_only() {
        let me = "u-1";
        assert!(linear_owned(&json!({"creator": {"id": "u-1"}, "assignee": null}), me));
        assert!(linear_owned(&json!({"creator": {"id": "u-2"}, "assignee": {"id": "u-1"}}), me));
        assert!(!linear_owned(&json!({"creator": {"id": "u-2"}, "assignee": {"id": "u-3"}}), me));
        assert!(!linear_owned(&json!({"creator": null, "assignee": null}), me));
        assert!(!linear_owned(&Value::Null, me));
    }
}
