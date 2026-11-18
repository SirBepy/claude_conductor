//! Tests for the policy rows, the file loader with hot reload, the write
//! functions and the seed. Every secret here is a made-up canary.

use super::audit::{AuditLog, VolumeLimits};
use super::engine::{BrokerRequest, Engine};
use super::guards::{Limits, Method};
use super::policy::{Policy, PolicyDecision, PolicyRequest};
use super::policy_file::{add_row, load_effective, policy_path, seed, write_policy, FilePolicy, POLICY_FILE};
use super::policy_rules::{path_shape, suggest_row, PolicyFile, PolicyRow, Rules, Verdict, LINEAR_OPS};
use super::services::{Service, ServiceTable};
use super::store::testing::MemSecrets;
use std::path::Path;
use std::sync::Arc;

fn http(service: Service, method: Method, path: &'static str) -> PolicyRequest<'static> {
    PolicyRequest { session: "s1", service, method, path, query: None, read: method == Method::Get, linear_op: None }
}

fn linear_op(op: &'static str) -> PolicyRequest<'static> {
    PolicyRequest { session: "s1", service: Service::Linear, method: Method::Post, path: "/graphql", query: None, read: false, linear_op: Some(op) }
}

fn linear_query() -> PolicyRequest<'static> {
    PolicyRequest { session: "s1", service: Service::Linear, method: Method::Post, path: "/graphql", query: None, read: true, linear_op: None }
}

fn row(service: &str, method: &str, path: &str, owner: bool) -> PolicyRow {
    PolicyRow { service: service.into(), method: Some(method.into()), path: Some(path.into()), op: None, require_owner: owner, note: None }
}

fn op_row(op: &str, owner: bool) -> PolicyRow {
    PolicyRow { service: "linear".into(), method: None, path: None, op: Some(op.into()), require_owner: owner, note: None }
}

fn rules(rows: Vec<PolicyRow>) -> Rules {
    Rules::compile(&PolicyFile { version: 1, rows }).unwrap()
}

fn decide(r: &Rules, req: &PolicyRequest<'_>) -> PolicyDecision {
    r.evaluate(req).into_decision(POLICY_FILE)
}

fn allowed(d: &PolicyDecision) -> Option<bool> {
    match d {
        PolicyDecision::Allow { require_owner } => Some(*require_owner),
        PolicyDecision::Deny { .. } => None,
    }
}

fn deny_parts(d: PolicyDecision) -> (String, Option<String>) {
    match d {
        PolicyDecision::Deny { reason, hint } => (reason, hint),
        PolicyDecision::Allow { .. } => panic!("expected a denial"),
    }
}

// ---- regex rows -----------------------------------------------------------------------

#[test]
fn a_path_pattern_matches_the_whole_path_never_a_prefix_or_a_part() {
    let r = rules(vec![row("shortcut", "PUT", r"/api/v3/stories/\d+", true)]);
    assert!(allowed(&decide(&r, &http(Service::Shortcut, Method::Put, "/api/v3/stories/123"))).is_some());
    for p in ["/api/v3/stories/123/comments", "/api/v3/stories/12x", "/api/v3/stories/", "/x/api/v3/stories/1"] {
        let req = PolicyRequest { path: p, ..http(Service::Shortcut, Method::Put, "/") };
        assert!(allowed(&decide(&r, &req)).is_none(), "{p} must not match");
    }
}

#[test]
fn an_alternation_cannot_escape_the_anchors() {
    let r = rules(vec![row("shortcut", "POST", r"/api/v3/stories|/api/v3/epics", false)]);
    for p in ["/api/v3/stories", "/api/v3/epics"] {
        assert!(allowed(&decide(&r, &PolicyRequest { path: p, ..http(Service::Shortcut, Method::Post, "/") })).is_some(), "{p}");
    }
    let req = PolicyRequest { path: "/api/v3/stories/9/comments", ..http(Service::Shortcut, Method::Post, "/") };
    assert!(allowed(&decide(&r, &req)).is_none());
    let req = PolicyRequest { path: "/api/v3/epics-bulk", ..http(Service::Shortcut, Method::Post, "/") };
    assert!(allowed(&decide(&r, &req)).is_none());
}

#[test]
fn a_row_is_for_its_own_method_and_its_own_service() {
    let r = rules(vec![row("shortcut", "POST", r"/api/v3/stories", false)]);
    assert!(allowed(&decide(&r, &http(Service::Shortcut, Method::Post, "/api/v3/stories"))).is_some());
    assert!(allowed(&decide(&r, &http(Service::Shortcut, Method::Put, "/api/v3/stories"))).is_none());
    assert!(allowed(&decide(&r, &http(Service::Shortcut, Method::Delete, "/api/v3/stories"))).is_none());
    // Same method and a path that also exists on another service: still that service's row only.
    assert!(allowed(&decide(&r, &http(Service::Clockify, Method::Post, "/api/v3/stories"))).is_none());
    // Lowercase method in a row is read as the method.
    let lower = rules(vec![row("trello", "post", r"/1/cards", false)]);
    assert!(allowed(&decide(&lower, &http(Service::Trello, Method::Post, "/1/cards"))).is_some());
}

#[test]
fn an_unbalanced_pattern_cannot_close_the_anchor_group_and_match_everything() {
    for p in [".*)|(.*", "a)|(b", "(", ")"] {
        let res = Rules::compile(&PolicyFile { version: 1, rows: vec![row("shortcut", "POST", p, false)] });
        assert!(res.is_err(), "{p:?} must not load");
    }
}

#[test]
fn a_suggested_row_pins_action_names_and_wildcards_only_id_like_segments() {
    let req = http(Service::Trello, Method::Post, "/1/lists/5f0123456789abcdef012345/archiveAllCards");
    let path = suggest_row(&req).path.unwrap();
    assert_eq!(path, "^/1/lists/[0-9a-f]{24}/archiveAllCards$");
    let r = rules(vec![suggest_row(&req)]);
    assert!(allowed(&decide(&r, &req)).is_some());
    let sibling = http(Service::Trello, Method::Post, "/1/lists/5f0123456789abcdef012345/moveAllCards");
    assert!(allowed(&decide(&r, &sibling)).is_none(), "one printed row must not open its siblings");
}

#[test]
fn a_suggested_row_allows_the_call_it_was_printed_for_with_uppercase_ids() {
    for (svc, path) in [
        (Service::Trello, "/1/cards/5F0123456789ABCDEF012345"),
        (Service::Shortcut, "/api/v3/groups/6F1C2A3B-0000-4000-8000-123456789ABC"),
    ] {
        let req = http(svc, Method::Put, path);
        let r = rules(vec![suggest_row(&req)]);
        assert!(allowed(&decide(&r, &req)).is_some(), "{path}");
    }
}

#[test]
fn a_bad_row_fails_the_whole_file_and_names_the_row() {
    let bad: Vec<(PolicyRow, &str)> = vec![
        (row("github", "POST", "/x", false), "unknown service"),
        (row("shortcut", "FETCH", "/x", false), "unknown method"),
        (row("shortcut", "POST", "(", false), "not a valid pattern"),
        (row("shortcut", "POST", "", false), "1 to 4200"),
        (PolicyRow { op: Some("commentCreate".into()), ..row("linear", "POST", "/graphql", true) }, "either"),
        (PolicyRow { service: "shortcut".into(), method: None, path: None, op: None, require_owner: true, note: None }, "either"),
        (row("linear", "POST", "/graphql", false), "op rows"),
        (op_row("commentCreate", true), "ok"),
    ];
    for (r, want) in bad {
        let res = Rules::compile(&PolicyFile { version: 1, rows: vec![row("shortcut", "GET", "/ok", false), r] });
        if want == "ok" {
            assert!(res.is_ok());
            continue;
        }
        let err = res.err().unwrap_or_else(|| panic!("{want} should fail"));
        assert!(err.starts_with("row 2:"), "{err}");
        assert!(err.contains(want), "{err} should mention {want}");
    }
}

#[test]
fn a_pattern_that_is_too_long_or_compiles_too_big_is_refused() {
    let compile = |p: &str| Rules::compile(&PolicyFile { version: 1, rows: vec![row("shortcut", "POST", p, false)] });
    assert!(compile(&"a".repeat(4201)).is_err(), "over 4200 characters");
    assert!(compile(&"a".repeat(4200)).is_ok());
    assert!(compile("((a{0,100}){0,100}){0,100}").is_err(), "short text, huge compiled program");
    assert!(compile("a{0,100}").is_ok());
}

// ---- GET open, owner requirement -------------------------------------------------------

#[test]
fn a_get_and_a_linear_query_are_open_with_no_rows_at_all() {
    let r = rules(vec![]);
    for s in Service::ALL {
        assert_eq!(allowed(&decide(&r, &http(s, Method::Get, "/anything/at/all"))), Some(false), "{}", s.name());
    }
    assert_eq!(allowed(&decide(&r, &linear_query())), Some(false));
}

#[test]
fn require_owner_comes_from_the_row_and_the_strictest_matching_row_wins() {
    let owned = rules(vec![row("shortcut", "PUT", r"/api/v3/stories/\d+", true)]);
    assert_eq!(allowed(&decide(&owned, &http(Service::Shortcut, Method::Put, "/api/v3/stories/5"))), Some(true));
    let open = rules(vec![row("shortcut", "POST", r"/api/v3/stories", false)]);
    assert_eq!(allowed(&decide(&open, &http(Service::Shortcut, Method::Post, "/api/v3/stories"))), Some(false));
    // Two rows match one call: owner wins over no-owner, in either order.
    for rows in [
        vec![row("shortcut", "PUT", r"/api/v3/stories/\d+", false), row("shortcut", "PUT", r"/api/v3/stories/5", true)],
        vec![row("shortcut", "PUT", r"/api/v3/stories/5", true), row("shortcut", "PUT", r"/api/v3/stories/\d+", false)],
    ] {
        assert_eq!(allowed(&decide(&rules(rows), &http(Service::Shortcut, Method::Put, "/api/v3/stories/5"))), Some(true));
    }
}

#[test]
fn a_row_without_require_owner_asks_for_the_owner_check() {
    let f: PolicyFile = serde_json::from_str(r#"{"rows":[{"service":"shortcut","method":"PUT","path":"/api/v3/stories/\\d+"}]}"#).unwrap();
    assert!(f.rows[0].require_owner);
    let r = Rules::compile(&f).unwrap();
    assert_eq!(allowed(&decide(&r, &http(Service::Shortcut, Method::Put, "/api/v3/stories/5"))), Some(true));
}

// ---- Linear named operations -----------------------------------------------------------

#[test]
fn linear_writes_are_pinned_to_the_three_named_operations() {
    let r = rules(vec![op_row("commentCreate", true), op_row("issueCreate", false), op_row("issueUpdate", true)]);
    assert_eq!(allowed(&decide(&r, &linear_op("commentCreate"))), Some(true));
    assert_eq!(allowed(&decide(&r, &linear_op("issueCreate"))), Some(false));
    assert_eq!(allowed(&decide(&r, &linear_op("issueUpdate"))), Some(true));
    let (reason, hint) = deny_parts(decide(&r, &linear_op("issueDelete")));
    assert!(reason.contains("issueDelete") && reason.contains("commentCreate, issueCreate, issueUpdate"), "{reason}");
    assert!(hint.is_none(), "no row can add another operation, so there is no line to print");
}

#[test]
fn a_linear_row_for_any_other_operation_does_not_load() {
    for op in ["issueDelete", "issueBatchDelete", "projectCreate", "commentCreate ", "COMMENTCREATE", ""] {
        let res = Rules::compile(&PolicyFile { version: 1, rows: vec![op_row(op, false)] });
        assert!(res.is_err(), "{op:?} must not load");
    }
    // An op row on another service, and a method+path row for Linear, are refused too.
    assert!(Rules::compile(&PolicyFile { version: 1, rows: vec![PolicyRow { service: "shortcut".into(), ..op_row("commentCreate", true) }] }).is_err());
}

#[test]
fn a_linear_call_with_no_row_is_denied_with_the_op_row_to_add() {
    let r = rules(vec![op_row("issueCreate", false)]);
    let (reason, hint) = deny_parts(decide(&r, &linear_op("commentCreate")));
    assert!(reason.contains("linear") && reason.contains("mutation commentCreate"), "{reason}");
    let hint = hint.unwrap();
    assert!(hint.contains(r#"{"service":"linear","op":"commentCreate","require_owner":true}"#), "{hint}");
}

// ---- denial text ----------------------------------------------------------------------

#[test]
fn a_denial_prints_the_exact_row_that_would_allow_the_call() {
    let r = rules(vec![]);
    let cases: [(Service, Method, &'static str, bool); 4] = [
        (Service::Shortcut, Method::Post, "/api/v3/stories/4412/comments", true),
        (Service::Shortcut, Method::Post, "/api/v3/story-links", false),
        (Service::Trello, Method::Put, "/1/cards/5f0123456789abcdef012345", false),
        (Service::Clockify, Method::Post, "/api/v1/workspaces/5f0123456789abcdef012345/time-entries", false),
    ];
    for (svc, m, path, owner) in cases {
        let req = http(svc, m, path);
        let (reason, hint) = deny_parts(decide(&r, &req));
        assert!(reason.contains(svc.name()) && reason.contains(path), "{reason}");
        let hint = hint.unwrap();
        assert!(hint.contains(POLICY_FILE), "{hint}");
        // The row is the tail of the hint after ": " and is valid JSON that allows this very call.
        let json = hint.rsplit_once("): ").map(|(_, j)| j).unwrap();
        let row: PolicyRow = serde_json::from_str(json).unwrap_or_else(|e| panic!("{json}: {e}"));
        assert_eq!(row.require_owner, owner, "{json}");
        assert_eq!(row.method.as_deref(), Some(m.as_str()));
        let after = rules(vec![row]);
        assert!(allowed(&decide(&after, &req)).is_some(), "the printed row must allow the call it was printed for: {json}");
    }
}

#[test]
fn a_suggested_row_generalizes_ids_but_never_leaves_the_service_prefix_or_names_the_ticket() {
    let req = http(Service::Shortcut, Method::Put, "/api/v3/stories/4412");
    let row = suggest_row(&req);
    assert_eq!(row.path.as_deref(), Some(r"^/api/v3/stories/\d+$"));
    assert!(!serde_json::to_string(&row).unwrap().contains("4412"));
    assert_eq!(path_shape(Service::Figma, "/v1/files/AbC123xyz/comments"), "^/v1/files/[^/]+/comments$");
    assert_eq!(path_shape(Service::Shortcut, "/api/v3/groups/6f1c2a3b-0000-4000-8000-123456789abc"), "^/api/v3/groups/[0-9a-f-]{36}$");
    assert_eq!(path_shape(Service::Trello, "/1/lists/5f0123456789abcdef012345/cards"), "^/1/lists/[0-9a-f]{24}/cards$");
}

#[test]
fn a_suggested_row_matches_the_odd_path_it_was_printed_for() {
    // 2040 bytes is about the longest path the guards accept (2048 with the prefix).
    let escaped = "x.".repeat(1000);
    let many_ids = "1/".repeat(1000);
    let many_wild = "a1/".repeat(680);
    for (svc, path) in [
        (Service::Shortcut, format!("/api/v3/stories/{many_ids}")),
        (Service::Figma, format!("/v1/{many_wild}")),
        (Service::Shortcut, "/api/v3/stories/".to_string()),
        (Service::Shortcut, "/api/v3/stories//5".to_string()),
        (Service::Shortcut, "/api/v3/".to_string()),
        (Service::Trello, "/1/lists/5f0123456789abcdef012345/archive.All-Cards".to_string()),
        (Service::Figma, format!("/v1/{escaped}")),
    ] {
        let path: &'static str = Box::leak(path.into_boxed_str());
        let req = http(svc, Method::Post, path);
        let row = suggest_row(&req);
        let rules = Rules::compile(&PolicyFile { version: 1, rows: vec![row.clone()] }).unwrap_or_else(|e| panic!("{path}: {e}"));
        assert!(matches!(rules.evaluate(&req), Verdict::Allow { .. }), "the row printed for {path} must allow it: {row:?}");
    }
}

#[test]
fn a_shortcut_story_or_epic_row_always_asks_for_the_owner_even_when_the_id_is_odd() {
    // shortcut_target reads only a plain id, so a wildcard row printed for `12x` or a
    // 19-digit id would otherwise open every story with no ownership check.
    for path in ["/api/v3/stories/12x", "/api/v3/stories/1234567890123456789", "/api/v3/epics/-1", "/api/v3/stories/12/comments"] {
        let row = suggest_row(&http(Service::Shortcut, Method::Put, path));
        assert!(row.require_owner, "{path}: {row:?}");
    }
    assert!(!suggest_row(&http(Service::Shortcut, Method::Post, "/api/v3/stories")).require_owner);
    assert!(!suggest_row(&http(Service::Shortcut, Method::Post, "/api/v3/stories/")).require_owner);
    assert!(!suggest_row(&http(Service::Shortcut, Method::Post, "/api/v3/labels")).require_owner);
    // A wildcard in the collection segment covers stories too, so it asks for the owner.
    for path in ["/api/v3/%73tories/12", "/api/v3/a1/12", "/api/v3/Stories/12", "/api/v3/stories//12"] {
        let row = suggest_row(&http(Service::Shortcut, Method::Put, path));
        assert!(row.require_owner, "{path}: {row:?}");
    }
    // A word segment is an action the row pins; an owner row there could never be allowed.
    for path in ["/api/v3/stories/search", "/api/v3/stories/from-template", "/api/v3/epics/search"] {
        let row = suggest_row(&http(Service::Shortcut, Method::Post, path));
        assert!(!row.require_owner, "{path}: {row:?}");
    }
}

#[test]
fn a_denial_through_the_file_policy_names_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let p = FilePolicy::open(dir.path());
    // PATCH on Figma is never in the seed, so this stays a denial whatever a rescan finds.
    let (_, hint) = deny_parts(p.decide(&http(Service::Figma, Method::Patch, "/v1/files/AbC123/variables")));
    let hint = hint.unwrap();
    assert!(hint.contains("broker-policy.json") && hint.contains(r#""service":"figma""#), "{hint}");
}

// ---- hot reload -----------------------------------------------------------------------

fn write_raw(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
}

const ROW_STORIES_POST: &str = r#"{"version":1,"rows":[{"service":"shortcut","method":"POST","path":"/api/v3/stories","require_owner":false}]}"#;

#[test]
fn a_file_edit_takes_effect_on_the_next_decision_without_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = policy_path(dir.path());
    write_raw(&path, r#"{"version":1,"rows":[]}"#);
    let p = FilePolicy::at(path.clone());
    let req = http(Service::Shortcut, Method::Post, "/api/v3/stories");
    assert!(allowed(&p.decide(&req)).is_none(), "an empty file allows no write");
    write_raw(&path, ROW_STORIES_POST);
    assert_eq!(allowed(&p.decide(&req)), Some(false));
    // Same length, different content: still noticed (bytes are compared, not size or mtime).
    write_raw(&path, &ROW_STORIES_POST.replace("POST", "PUT "));
    assert!(allowed(&p.decide(&req)).is_none());
    write_raw(&path, r#"{"version":1,"rows":[]}"#);
    assert!(allowed(&p.decide(&req)).is_none());
}

#[test]
fn a_malformed_file_keeps_the_last_good_policy_and_says_so_in_the_denial() {
    let dir = tempfile::tempdir().unwrap();
    let path = policy_path(dir.path());
    write_raw(&path, ROW_STORIES_POST);
    let p = FilePolicy::at(path.clone());
    let allowed_req = http(Service::Shortcut, Method::Post, "/api/v3/stories");
    assert_eq!(allowed(&p.decide(&allowed_req)), Some(false));
    assert!(p.last_error().is_none());

    for broken in ["{ not json", r#"{"rows":[{"service":"shortcut","method":"POST","path":"("}]}"#, r#"{"rows":[{"service":"linear","op":"issueDelete"}]}"#, ""] {
        write_raw(&path, broken);
        assert_eq!(allowed(&p.decide(&allowed_req)), Some(false), "last good policy stays in force for {broken:?}");
        let (reason, _) = deny_parts(p.decide(&http(Service::Shortcut, Method::Post, "/api/v3/epics")));
        assert!(reason.contains("last good policy is in force"), "{reason}");
        assert!(p.last_error().is_some());
    }
    // A fixed file replaces the last good one and clears the error.
    write_raw(&path, r#"{"version":1,"rows":[{"service":"shortcut","method":"POST","path":"/api/v3/epics","require_owner":false}]}"#);
    assert!(allowed(&p.decide(&allowed_req)).is_none());
    assert_eq!(allowed(&p.decide(&http(Service::Shortcut, Method::Post, "/api/v3/epics"))), Some(false));
    assert!(p.last_error().is_none());
}

#[test]
fn an_error_from_an_unreadable_file_clears_when_the_same_bytes_read_fine_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = policy_path(dir.path());
    write_raw(&path, ROW_STORIES_POST);
    let p = FilePolicy::at(path.clone());
    assert!(p.last_error().is_none());
    // A directory where the file was: reading it fails with something other than NotFound.
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(p.last_error().is_some_and(|e| e.contains("cannot be read")));
    std::fs::remove_dir(&path).unwrap();
    write_raw(&path, ROW_STORIES_POST);
    assert!(p.last_error().is_none(), "the same bytes as before the failure must reprocess");
    assert_eq!(allowed(&p.decide(&http(Service::Shortcut, Method::Post, "/api/v3/stories"))), Some(false));
}

#[test]
fn a_file_that_is_malformed_at_startup_falls_back_to_the_seed_not_to_allow_everything() {
    let dir = tempfile::tempdir().unwrap();
    let path = policy_path(dir.path());
    write_raw(&path, "garbage");
    let p = FilePolicy::at(path);
    assert!(p.last_error().is_some());
    assert!(allowed(&p.decide(&http(Service::Shortcut, Method::Post, "/api/v3/search"))).is_some(), "the seed's search row is in force");
    assert!(allowed(&p.decide(&http(Service::Shortcut, Method::Delete, "/api/v3/stories/1"))).is_none());
}

#[test]
fn no_file_means_the_seed_and_deleting_the_file_goes_back_to_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = policy_path(dir.path());
    let p = FilePolicy::at(path.clone());
    assert_eq!(p.row_count(), seed().rows.len());
    write_raw(&path, r#"{"version":1,"rows":[]}"#);
    assert_eq!(p.row_count(), 0);
    std::fs::remove_file(&path).unwrap();
    assert_eq!(p.row_count(), seed().rows.len());
    assert!(p.last_error().is_none());
}

// ---- the write functions --------------------------------------------------------------

#[test]
fn add_row_writes_the_seed_plus_the_row_and_the_running_policy_sees_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = policy_path(dir.path());
    let p = FilePolicy::at(path.clone());
    let req = http(Service::Figma, Method::Patch, "/v1/files/AbC123/variables");
    assert!(allowed(&p.decide(&req)).is_none());
    assert_eq!(add_row(&path, row("figma", "PATCH", r"/v1/files/[^/]+/variables", false)).unwrap(), true);
    assert_eq!(allowed(&p.decide(&req)), Some(false));
    let file = load_effective(&path).unwrap();
    assert_eq!(file.rows.len(), seed().rows.len() + 1, "the seed rows are kept, so nothing Joe had is lost");
    assert!(!dir.path().join("broker-policy.json.tmp").exists());
    // The same row again changes nothing.
    assert_eq!(add_row(&path, row("figma", "patch", r"/v1/files/[^/]+/variables", false)).unwrap(), false);
    assert_eq!(load_effective(&path).unwrap().rows.len(), file.rows.len());
}

#[test]
fn add_row_refuses_a_bad_row_and_a_malformed_file_and_touches_neither() {
    let dir = tempfile::tempdir().unwrap();
    let path = policy_path(dir.path());
    assert!(add_row(&path, op_row("issueDelete", false)).is_err());
    assert!(add_row(&path, row("shortcut", "POST", "(", false)).is_err());
    assert!(!path.exists(), "a refused write creates nothing");
    write_raw(&path, "{ half a file");
    assert!(add_row(&path, row("figma", "POST", "/v1/x", false)).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ half a file", "a malformed file is never overwritten");
}

#[test]
fn write_policy_replaces_the_file_and_can_remove_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = policy_path(dir.path());
    let p = FilePolicy::at(path.clone());
    write_policy(&path, &PolicyFile { version: 1, rows: vec![row("trello", "POST", "/1/cards", false)] }).unwrap();
    assert_eq!(p.row_count(), 1);
    assert!(allowed(&p.decide(&http(Service::Shortcut, Method::Post, "/api/v3/search"))).is_none(), "a seed row is gone once the file drops it");
    assert!(write_policy(&path, &PolicyFile { version: 1, rows: vec![op_row("issueDelete", false)] }).is_err());
    assert_eq!(p.row_count(), 1, "a refused write leaves the file as it was");
}

// ---- the seed -------------------------------------------------------------------------

#[test]
fn the_seed_loads_and_holds_only_what_the_scan_may_seed() {
    let file = seed();
    Rules::compile(&file).unwrap();
    assert!(!file.rows.is_empty());
    for r in &file.rows {
        let desc = serde_json::to_string(r).unwrap();
        assert!(!r.method.as_deref().is_some_and(|m| m.eq_ignore_ascii_case("DELETE")), "a delete is never seeded: {desc}");
        assert!(!r.method.as_deref().is_some_and(|m| m.eq_ignore_ascii_case("GET")), "GET is open, so no row: {desc}");
        let lower = desc.to_ascii_lowercase();
        assert!(!lower.contains("bulk") && !lower.contains("batch"), "a bulk endpoint is never seeded: {desc}");
        if let Some(op) = &r.op {
            assert!(LINEAR_OPS.iter().any(|(o, _)| o == op), "{desc}");
        }
        // Rows hold shapes, never an id or a token: no digit run in a path and no long mixed run anywhere.
        if let Some(p) = &r.path {
            let mut body = p.trim_start_matches('^');
            for prefix in ["/api/v3/", "/api/v1/", "/v1/", "/v2/", "/1/"] {
                if let Some(rest) = body.strip_prefix(prefix) {
                    body = rest;
                    break;
                }
            }
            assert!(!body.contains("[^/]+"), "a wildcard segment in a seeded write row opens every sibling endpoint: {desc}");
            let unclassed = body
                .replace(r"\d+", "")
                .replace("[0-9a-f]{24}", "")
                .replace("[0-9a-f-]{36}", "")
                .replace("[0-9a-fA-F]{24}", "")
                .replace("[0-9a-fA-F-]{36}", "");
            assert!(!unclassed.chars().any(|c| c.is_ascii_digit()), "an id in a seed path: {desc}");
        }
        let mut run = 0;
        for c in desc.chars() {
            run = if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+' | '=') { run + 1 } else { 0 };
            assert!(run < 24, "token-shaped run in a seed row: {desc}");
        }
    }
}

#[test]
fn the_seed_has_shortcut_search_as_an_explicit_read_row_and_still_denies_what_was_not_seen() {
    let r = Rules::compile(&seed()).unwrap();
    assert_eq!(allowed(&decide(&r, &http(Service::Shortcut, Method::Post, "/api/v3/search"))), Some(false));
    assert!(allowed(&decide(&r, &http(Service::Shortcut, Method::Post, "/api/v3/search/epics"))).is_none(), "only the exact path");
    for (s, p) in [
        (Service::Shortcut, "/api/v3/stories/1"),
        (Service::Shortcut, "/api/v3/stories/bulk"),
        (Service::Trello, "/1/cards/5f0123456789abcdef012345"),
        (Service::Figma, "/v1/files/AbC123"),
    ] {
        assert!(allowed(&decide(&r, &http(s, Method::Delete, p))).is_none(), "DELETE {p}");
    }
    assert!(allowed(&decide(&r, &http(Service::Hubstaff, Method::Post, "/v2/organizations/1/projects"))).is_none());
    // Reads stay open.
    assert_eq!(allowed(&decide(&r, &http(Service::Figma, Method::Get, "/v1/files/AbC123"))), Some(false));
}

// ---- the engine's policy trait --------------------------------------------------------

#[tokio::test]
async fn the_engine_uses_the_file_policy_denies_with_the_row_and_allows_after_the_card_writes_it() {
    let mut server = mockito::Server::new_async().await;
    let dir = tempfile::tempdir().unwrap();
    let mut table = ServiceTable::production();
    for s in Service::ALL {
        table = table.with_base_url(s, &server.url());
    }
    let policy = Arc::new(FilePolicy::open(dir.path()));
    let secrets = Arc::new(MemSecrets::with(&[("FIGMA_TOKEN", "CANARY-FIG-policy-1")]));
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().build().unwrap();
    let audit = AuditLog::with_limits(dir.path().join("audit.jsonl"), VolumeLimits::default());
    let engine = Engine::with_client(table, secrets, policy, audit, Limits::default(), client);

    let call = || BrokerRequest::new("sess-1", "figma", "PATCH", "/v1/files/AbC123/variables", Some(serde_json::json!({"x": 1})));
    let err = engine.call(call()).await.unwrap_err();
    assert_eq!(err.code, "policy_denied");
    let hint = err.hint.unwrap();
    assert!(hint.contains(r#""path":"^/v1/files/[^/]+/variables$""#), "{hint}");

    // What the policy card (step 7) does: write the printed row. The engine never writes.
    let json = hint.rsplit_once("): ").unwrap().1;
    let printed: PolicyRow = serde_json::from_str(json).unwrap();
    add_row(&policy_path(dir.path()), printed).unwrap();
    let m = server.mock("PATCH", "/v1/files/AbC123/variables").match_header("x-figma-token", "CANARY-FIG-policy-1").with_status(200).with_body("{}").expect(1).create_async().await;
    let ok = engine.call(call()).await.unwrap();
    assert_eq!(ok.status, 200);
    m.assert_async().await;
}
