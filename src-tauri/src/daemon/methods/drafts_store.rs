//! Draft-message RPCs (todo 666). Same trust model as `methods::user_todos`:
//! the project comes from the CALLER'S OWN registry entry, never an argument.
//! Named `drafts_store` because `methods::drafts` is the composer/AUQ/held
//! draft-SYNC module and is a different concept entirely.
//! `Router` wiring lives in the sibling `routes` module, the `UserPromptSubmit`
//! injection block in the sibling `inject` module.

mod inject;
mod people_resolve;
mod routes;

pub(crate) use inject::{mark_drafts_seen, render_for_injection};
use people_resolve::{annotate, person_for_write, platform_for, recipient_label};
pub use routes::register_drafts_store;

use super::channel::{caller_project, display_name};
use crate::daemon::state::DaemonState;
use crate::people;
use crate::sessions::message_drafts::{self as store, DraftReceipt, DraftState, MessageDraft, VariantTarget};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

pub(super) fn publish_changed(state: &Arc<DaemonState>, project_id: &str) {
    state.notifier.publish("message_drafts_changed", json!({"project_id": project_id}));
}

fn parse_state(s: &str) -> Result<DraftState, String> {
    match s {
        "needs-you" => Ok(DraftState::NeedsYou),
        "copied" => Ok(DraftState::Copied),
        "archived" => Ok(DraftState::Archived),
        other => Err(format!("unknown draft state: {other} (want needs-you|copied|archived)")),
    }
}

/// `root: Some(path)` substitutes a tempdir for the real app-data root
/// `resolve_id`/`recipient_from` below resolve through `store::list` - the
/// seam hermetic tests use, same shape as `repo_channel::channel_path`.
fn list_for(root: Option<&Path>, project_id: &str) -> Vec<MessageDraft> {
    match root {
        Some(r) => store::list_at(&store::draft_path(r, project_id)),
        None => store::list(project_id),
    }
}

/// Accepts a full uuid, an unambiguous uuid prefix, or a handle like
/// "Bruno #2" - the id the injected block actually hands the model.
fn resolve_id(root: Option<&Path>, project_id: &str, id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("id is required".to_string());
    }
    let drafts = list_for(root, project_id);
    if let Some(d) = drafts.iter().find(|d| d.id == id) {
        return Ok(d.id.clone());
    }
    let wanted = id.to_lowercase();
    let by_handle = drafts
        .iter()
        .find(|d| d.variants.iter().any(|v| store::handle_of(v).to_lowercase() == wanted));
    if let Some(d) = by_handle {
        return Ok(d.id.clone());
    }
    let mut hits = drafts.iter().filter(|d| d.id.starts_with(id));
    match (hits.next(), hits.next()) {
        (Some(d), None) => Ok(d.id.clone()),
        (Some(_), Some(_)) => Err(format!("ambiguous draft id: {id}")),
        _ => Err(format!("no such draft: {id}")),
    }
}

/// A handle also names WHICH variant, so "Bruno #2" resolves the recipient too
/// and the caller never has to pass it twice.
fn recipient_from(root: Option<&Path>, project_id: &str, id: &str, recipient: &str) -> String {
    if !recipient.trim().is_empty() {
        return recipient.to_string();
    }
    let wanted = id.trim().to_lowercase();
    for d in list_for(root, project_id) {
        for v in &d.variants {
            if store::handle_of(v).to_lowercase() == wanted {
                return v.recipient.clone();
            }
        }
    }
    String::new()
}

fn receipts_from(value: Option<&Value>) -> Vec<DraftReceipt> {
    let Some(Value::Array(items)) = value else { return Vec::new() };
    items
        .iter()
        .filter_map(|it| {
            let claim = it.get("claim")?.as_str()?.trim();
            let source = it.get("source")?.as_str()?.trim();
            if claim.is_empty() || source.is_empty() {
                return None;
            }
            Some(DraftReceipt { claim: claim.to_string(), source: source.to_string() })
        })
        .collect()
}

pub(crate) fn list_message_drafts(state: &Arc<DaemonState>, session_id: &str) -> Result<Value, String> {
    list_message_drafts_in(None, people::vault_dir().as_deref(), state, session_id)
}

/// `root`/`vault: Some(path)` substitute tempdirs for the real app-data root
/// and Obsidian vault - the seam hermetic tests use.
/// `people` carries only the vault people the listed drafts point at, so the
/// panel can show a real name and relationship without a second round trip.
pub(crate) fn list_message_drafts_in(
    root: Option<&Path>,
    vault: Option<&Path>,
    state: &Arc<DaemonState>,
    session_id: &str,
) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let mut drafts = list_for(root, &project_id);
    let everyone = vault.map(people::list_at).unwrap_or_default();
    let used = annotate(&mut drafts, &everyone);
    Ok(json!({"drafts": drafts, "people": used}))
}

/// The single `write_draft` MCP tool's five actions.
pub(crate) fn write_draft(state: &Arc<DaemonState>, session_id: &str, action: &str, args: &Value) -> Result<Value, String> {
    write_draft_in(None, people::vault_dir().as_deref(), state, session_id, action, args)
}

/// `root: Some(path)` substitutes a tempdir for the real app-data root each
/// action below resolves through `store::add`/`revise`/`add_variant`/`remove`
/// - the seam hermetic tests use, same shape as `repo_channel::post_at`. No vault.
pub(crate) fn write_draft_at(
    root: Option<&Path>,
    state: &Arc<DaemonState>,
    session_id: &str,
    action: &str,
    args: &Value,
) -> Result<Value, String> {
    write_draft_in(root, None, state, session_id, action, args)
}

pub(crate) fn write_draft_in(
    root: Option<&Path>,
    vault: Option<&Path>,
    state: &Arc<DaemonState>,
    session_id: &str,
    action: &str,
    args: &Value,
) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let s = |key: &str| args.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let id = s("id");
    let body = s("body");
    let mut recipient = s("recipient");
    let given_platform = s("platform");
    let client = vault
        .and_then(|v| super::people::caller_client(state, session_id, &people::clients_at(v)))
        .map(|c| c.slug);
    let client = client.as_deref();

    let draft = match action {
        "add" => {
            let topic = s("topic");
            if topic.trim().is_empty() {
                return Err("topic is required to add a draft".to_string());
            }
            if body.trim().is_empty() {
                return Err("body is required to add a draft".to_string());
            }
            let person = person_for_write(vault, client, args)?;
            recipient = recipient_label(&recipient, person.as_ref(), &given_platform)?;
            let platform = platform_for(&given_platform, &recipient);
            let label = display_name(state, session_id);
            let new = store::NewDraft {
                topic: &topic,
                recipient: &recipient,
                body: &body,
                brief: &s("brief"),
                receipts: receipts_from(args.get("receipts")),
                origin_session_id: session_id,
                origin_label: &label,
                person: person.as_ref().map(|p| p.id.as_str()),
                platform: platform.as_deref(),
            };
            let added = match root {
                Some(r) => store::add_at(&store::draft_path(r, &project_id), new),
                None => store::add(&project_id, new),
            };
            added.ok_or_else(|| "no data dir to write drafts into".to_string())?
        }
        "revise" => {
            if body.trim().is_empty() {
                return Err("body is required to revise a draft".to_string());
            }
            let who = recipient_from(root, &project_id, &id, &recipient);
            let full = resolve_id(root, &project_id, &id)?;
            match root {
                Some(r) => store::revise_at(&store::draft_path(r, &project_id), &full, &who, &body, &s("note"))?,
                None => store::revise(&project_id, &full, &who, &body, &s("note"))?,
            }
        }
        "variant" => {
            if body.trim().is_empty() {
                return Err("body is required to add a variant".to_string());
            }
            let full = resolve_id(root, &project_id, &id)?;
            let person = person_for_write(vault, client, args)?;
            recipient = recipient_label(&recipient, person.as_ref(), &given_platform)?;
            let platform = platform_for(&given_platform, &recipient);
            let target = VariantTarget { person: person.as_ref().map(|p| p.id.as_str()), platform: platform.as_deref() };
            match root {
                Some(r) => store::add_variant_at(&store::draft_path(r, &project_id), &full, &recipient, &body, target)?,
                None => store::add_variant(&project_id, &full, &recipient, &body, target)?,
            }
        }
        "drop" => {
            let full = resolve_id(root, &project_id, &id)?;
            match root {
                Some(r) => store::remove_at(&store::draft_path(r, &project_id), &full)?,
                None => store::remove(&project_id, &full)?,
            };
            publish_changed(state, &project_id);
            return Ok(json!({"ok": true, "dropped": full}));
        }
        "sent" => {
            // Marks the named wording (`recipient`, or the handle in `id`, e.g.
            // "Bruno #2") and nothing else; no name means every wording. The card
            // reuses `Copied`, the state the panel already draws as the paper
            // plane, once nothing on it is still waiting on the user: it stays
            // visible as sent instead of vanishing as a drop would, and the
            // injection skips it exactly as for a Copy click.
            let full = resolve_id(root, &project_id, &id)?;
            let who = recipient_from(root, &project_id, &id, &recipient);
            let sent = match root {
                Some(r) => store::mark_variant_sent_at(&store::draft_path(r, &project_id), &full, &who)?,
                None => store::mark_variant_sent(&project_id, &full, &who)?,
            };
            // Names the wording that went out so the transcript card shows it
            // rather than guessing from the draft's last variant. A bare id on a
            // one-wording draft names that wording; on several it names none.
            let sent_recipient = match (who.trim(), sent.variants.as_slice()) {
                ("", [only]) => Some(only.recipient.clone()),
                ("", _) => None,
                (named, vs) => vs.iter().find(|v| v.recipient.trim().eq_ignore_ascii_case(named)).map(|v| v.recipient.clone()),
            };
            publish_changed(state, &project_id);
            return Ok(json!({"ok": true, "sent": sent, "sent_recipient": sent_recipient}));
        }
        other => return Err(format!("unknown action: {other} (want add|revise|variant|drop|sent)")),
    };
    publish_changed(state, &project_id);
    Ok(json!({"ok": true, "draft": draft}))
}

/// The user's own edit from the panel. Appends a version rather than
/// overwriting, and clears `seen_by_origin` so the next turn is told.
pub(crate) fn set_draft_body(state: &Arc<DaemonState>, session_id: &str, id: &str, recipient: &str, body: &str) -> Result<Value, String> {
    set_draft_body_at(None, state, session_id, id, recipient, body)
}

/// `root: Some(path)` substitutes a tempdir for the real app-data root
/// `set_draft_body` above resolves through `store::set_body` - the seam
/// hermetic tests use, same shape as `repo_channel::post_at`.
pub(crate) fn set_draft_body_at(
    root: Option<&Path>,
    state: &Arc<DaemonState>,
    session_id: &str,
    id: &str,
    recipient: &str,
    body: &str,
) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let full = resolve_id(root, &project_id, id)?;
    let draft = match root {
        Some(r) => store::set_body_at(&store::draft_path(r, &project_id), &full, recipient, body)?,
        None => store::set_body(&project_id, &full, recipient, body)?,
    };
    publish_changed(state, &project_id);
    Ok(json!({"ok": true, "draft": draft}))
}

pub(crate) fn set_draft_version(state: &Arc<DaemonState>, session_id: &str, id: &str, recipient: &str, n: u32) -> Result<Value, String> {
    set_draft_version_at(None, state, session_id, id, recipient, n)
}

/// `root: Some(path)` substitutes a tempdir for the real app-data root
/// `set_draft_version` above resolves through `store::set_current_version` -
/// the seam hermetic tests use, same shape as `repo_channel::post_at`.
pub(crate) fn set_draft_version_at(
    root: Option<&Path>,
    state: &Arc<DaemonState>,
    session_id: &str,
    id: &str,
    recipient: &str,
    n: u32,
) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let full = resolve_id(root, &project_id, id)?;
    let draft = match root {
        Some(r) => store::set_current_version_at(&store::draft_path(r, &project_id), &full, recipient, n)?,
        None => store::set_current_version(&project_id, &full, recipient, n)?,
    };
    publish_changed(state, &project_id);
    Ok(json!({"ok": true, "draft": draft}))
}

pub(crate) fn set_draft_state(state: &Arc<DaemonState>, session_id: &str, id: &str, next: &str) -> Result<Value, String> {
    set_draft_state_at(None, state, session_id, id, next)
}

/// `root: Some(path)` substitutes a tempdir for the real app-data root
/// `set_draft_state` above resolves through `store::set_state` - the seam
/// hermetic tests use, same shape as `repo_channel::post_at`.
pub(crate) fn set_draft_state_at(
    root: Option<&Path>,
    state: &Arc<DaemonState>,
    session_id: &str,
    id: &str,
    next: &str,
) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let next = parse_state(next)?;
    let full = resolve_id(root, &project_id, id)?;
    let draft = match root {
        Some(r) => store::set_state_at(&store::draft_path(r, &project_id), &full, next)?,
        None => store::set_state(&project_id, &full, next)?,
    };
    publish_changed(state, &project_id);
    Ok(json!({"ok": true, "draft": draft}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn registered() -> Arc<DaemonState> {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-08-26T00:00:00Z");
        state
    }

    #[test]
    fn every_method_rejects_an_unknown_caller() {
        let state = test_state();
        assert!(list_message_drafts(&state, "ghost").is_err());
        assert!(write_draft(&state, "ghost", "add", &json!({})).is_err());
        assert!(set_draft_body(&state, "ghost", "id", "", "x").is_err());
        assert!(set_draft_version(&state, "ghost", "id", "", 1).is_err());
        assert!(set_draft_state(&state, "ghost", "id", "archived").is_err());
    }

    #[test]
    fn unknown_action_and_state_are_rejected_by_name() {
        let state = registered();
        let err = write_draft(&state, "s1", "obliterate", &json!({})).unwrap_err();
        assert!(err.contains("unknown action"), "got {err}");
        let err = set_draft_state(&state, "s1", "any", "sideways").unwrap_err();
        assert!(err.contains("unknown draft state"), "got {err}");
    }

    #[test]
    fn sent_keeps_the_draft_in_the_store_as_copied() {
        let root = tempfile::tempdir().unwrap();
        let state = registered();
        let added = write_draft_at(Some(root.path()), &state, "s1", "add", &json!({"topic": "t", "recipient": "Johanna", "body": "hi"})).unwrap();
        let id = added["draft"]["id"].as_str().unwrap().to_string();
        assert_eq!(list_at_path(root.path())[0].state, DraftState::NeedsYou);

        let v = write_draft_at(Some(root.path()), &state, "s1", "sent", &json!({"id": id})).unwrap();
        assert_eq!(v["sent"]["id"], json!(id));
        assert_eq!(v["sent"]["state"], "copied");
        let left = list_at_path(root.path());
        assert_eq!(left.len(), 1, "sent must not remove the draft");
        assert_eq!(left[0].state, DraftState::Copied);
    }

    #[test]
    fn sent_marks_only_the_named_variant_and_leaves_the_sibling_open() {
        let root = tempfile::tempdir().unwrap();
        let state = registered();
        let added = write_draft_at(Some(root.path()), &state, "s1", "add", &json!({"topic": "t", "recipient": "Bruno", "body": "for bruno"})).unwrap();
        let id = added["draft"]["id"].as_str().unwrap().to_string();
        write_draft_at(Some(root.path()), &state, "s1", "variant", &json!({"id": id, "recipient": "Ana", "body": "for ana"})).unwrap();

        let v = write_draft_at(Some(root.path()), &state, "s1", "sent", &json!({"id": id, "recipient": "Bruno"})).unwrap();
        assert_eq!(v["sent_recipient"], "Bruno");
        assert_eq!(v["sent"]["state"], "needs-you", "Ana's wording is still waiting on the user");
        let left = list_at_path(root.path());
        let sent_flags: Vec<(String, bool)> = left[0].variants.iter().map(|x| (x.recipient.clone(), x.sent)).collect();
        assert_eq!(sent_flags, [("Bruno".to_string(), true), ("Ana".to_string(), false)]);

        let injected = inject::render_for_injection_at(Some(root.path()), &state, "s1").expect("the draft is still open");
        assert!(injected.contains("Ana #1"), "got {injected}");
        assert!(!injected.contains("Bruno #1"), "the sent wording drops out of the open list: {injected}");

        // The handle in `id` names the wording too, and sending the last one closes the card.
        let v = write_draft_at(Some(root.path()), &state, "s1", "sent", &json!({"id": "Ana #1"})).unwrap();
        assert_eq!(v["sent_recipient"], "Ana");
        assert_eq!(v["sent"]["state"], "copied");
        assert!(inject::render_for_injection_at(Some(root.path()), &state, "s1").is_none());
    }

    #[test]
    fn sent_with_no_name_on_a_multi_variant_draft_marks_every_wording() {
        let root = tempfile::tempdir().unwrap();
        let state = registered();
        let added = write_draft_at(Some(root.path()), &state, "s1", "add", &json!({"topic": "t", "recipient": "Bruno", "body": "a"})).unwrap();
        let id = added["draft"]["id"].as_str().unwrap().to_string();
        write_draft_at(Some(root.path()), &state, "s1", "variant", &json!({"id": id, "recipient": "Ana", "body": "b"})).unwrap();
        let v = write_draft_at(Some(root.path()), &state, "s1", "sent", &json!({"id": id})).unwrap();
        assert_eq!(v["sent"]["state"], "copied");
        assert!(v["sent_recipient"].is_null());
        assert!(list_at_path(root.path())[0].variants.iter().all(|x| x.sent));
    }

    #[test]
    fn revising_a_sent_variant_reopens_it() {
        let root = tempfile::tempdir().unwrap();
        let state = registered();
        let added = write_draft_at(Some(root.path()), &state, "s1", "add", &json!({"topic": "t", "recipient": "Bruno", "body": "a"})).unwrap();
        let id = added["draft"]["id"].as_str().unwrap().to_string();
        write_draft_at(Some(root.path()), &state, "s1", "sent", &json!({"id": id})).unwrap();
        write_draft_at(Some(root.path()), &state, "s1", "revise", &json!({"id": id, "body": "a2"})).unwrap();
        let d = &list_at_path(root.path())[0];
        assert_eq!((d.state, d.variants[0].sent), (DraftState::NeedsYou, false));
    }

    #[test]
    fn sent_needs_a_draft_to_point_at() {
        let root = tempfile::tempdir().unwrap();
        let state = registered();
        assert!(write_draft_at(Some(root.path()), &state, "s1", "sent", &json!({})).is_err());
        assert!(write_draft_at(Some(root.path()), &state, "s1", "sent", &json!({"id": "nope"})).is_err());
    }

    #[test]
    fn add_names_every_missing_required_field() {
        let state = registered();
        let err = write_draft(&state, "s1", "add", &json!({})).unwrap_err();
        assert!(err.contains("topic"), "got {err}");
        let err = write_draft(&state, "s1", "add", &json!({"topic": "t"})).unwrap_err();
        assert!(err.contains("body"), "got {err}");
        let err = write_draft(&state, "s1", "add", &json!({"topic": "t", "body": "hi"})).unwrap_err();
        assert!(err.contains("recipient, person or platform"), "got {err}");
    }

    #[test]
    fn parse_state_covers_every_variant() {
        assert_eq!(parse_state("needs-you").unwrap(), DraftState::NeedsYou);
        assert!(parse_state("ready").is_err(), "ready is no longer a settable state");
        assert_eq!(parse_state("copied").unwrap(), DraftState::Copied);
        assert_eq!(parse_state("archived").unwrap(), DraftState::Archived);
        assert!(parse_state("").is_err());
    }

    fn vault_with(people: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("People")).unwrap();
        for (name, frontmatter) in people {
            std::fs::write(dir.path().join("People").join(format!("{name}.md")), format!("---\n{frontmatter}\n---\n")).unwrap();
        }
        dir
    }

    fn add(root: &Path, vault: &Path, args: Value) -> Result<Value, String> {
        write_draft_in(Some(root), Some(vault), &registered(), "s1", "add", &args)
    }

    #[test]
    fn add_refuses_a_person_the_vault_does_not_know_and_says_to_ask() {
        let (root, vault) = (tempfile::tempdir().unwrap(), vault_with(&[("Bruno Kecman", "aliases: [Bruno]")]));
        let err = add(root.path(), vault.path(), json!({"topic": "t", "body": "hi", "person": "Stevan"})).unwrap_err();
        assert!(err.contains("ask them first"), "got {err}");
        assert!(list_at_path(root.path()).is_empty(), "a refused write must not land");
    }

    #[test]
    fn add_resolves_an_alias_to_the_vault_person_and_labels_with_their_name() {
        let (root, vault) = (tempfile::tempdir().unwrap(), vault_with(&[("Bruno Kecman", "aliases: [Nuno]")]));
        let v = add(root.path(), vault.path(), json!({"topic": "t", "body": "hi", "person": "nuno", "platform": "Slack"})).unwrap();
        let variant = &v["draft"]["variants"][0];
        assert_eq!(variant["person"], "Bruno Kecman");
        assert_eq!(variant["recipient"], "Bruno Kecman");
        assert_eq!(variant["platform"], "Slack");
    }

    #[test]
    fn add_refuses_an_ambiguous_first_name() {
        let (root, vault) = (tempfile::tempdir().unwrap(), vault_with(&[("Jon Kojakovic", ""), ("Jon Snow", "")]));
        let err = add(root.path(), vault.path(), json!({"topic": "t", "body": "hi", "person": "Jon"})).unwrap_err();
        assert!(err.contains("more than one person"), "got {err}");
    }

    #[test]
    fn new_person_creates_their_vault_note_then_drafts_to_them() {
        let (root, vault) = (tempfile::tempdir().unwrap(), vault_with(&[]));
        let v = add(
            root.path(),
            vault.path(),
            json!({"topic": "t", "body": "hi", "person": "Johanna Chen", "new_person": true, "aliases": ["Johanna"], "relationship": "coworker"}),
        )
        .unwrap();
        assert_eq!(v["draft"]["variants"][0]["person"], "Johanna Chen");
        assert!(vault.path().join("People/Johanna Chen.md").exists());
    }

    /// Inside a client's repo, the name a person goes by there resolves, and a
    /// new person joins that client.
    #[test]
    fn a_client_nickname_resolves_and_a_new_person_joins_the_client() {
        let (root, vault) = (tempfile::tempdir().unwrap(), vault_with(&[("Stevan", "projects: [zirtue]\nproject_aliases: [\"zirtue: backend\"]")]));
        std::fs::write(vault.path().join("Zirtue.md"), "---\nrepos: [zng-app]\n---\n").unwrap();
        let repo = tempfile::tempdir().unwrap();
        let cwd = repo.path().join("zng-app");
        std::fs::create_dir_all(&cwd).unwrap();
        let state = test_state();
        state.registry.upsert_interactive("s1", &cwd, "proj-1", "2026-10-17T00:00:00Z");
        let write = |args: Value| write_draft_in(Some(root.path()), Some(vault.path()), &state, "s1", "add", &args);

        let v = write(json!({"topic": "t", "body": "hi", "person": "backend"})).unwrap();
        assert_eq!(v["draft"]["variants"][0]["person"], "Stevan");
        write(json!({"topic": "t", "body": "hi", "person": "Airion Doe", "new_person": true})).unwrap();
        let note = std::fs::read_to_string(vault.path().join("People/Airion Doe.md")).unwrap();
        assert!(note.contains("projects: [\"zirtue\"]"), "{note}");
    }

    #[test]
    fn a_platform_only_draft_needs_no_person() {
        let (root, vault) = (tempfile::tempdir().unwrap(), vault_with(&[]));
        let v = add(root.path(), vault.path(), json!({"topic": "t", "body": "hi", "recipient": "Shortcut ticket sc-56117"})).unwrap();
        let variant = &v["draft"]["variants"][0];
        assert_eq!(variant["platform"], "Shortcut");
        assert!(variant["person"].is_null());
    }

    #[test]
    fn list_resolves_old_free_text_recipients_against_the_vault() {
        let root = tempfile::tempdir().unwrap();
        let state = registered();
        write_draft_at(Some(root.path()), &state, "s1", "add", &json!({"topic": "a", "recipient": "Lenar", "body": "x"})).unwrap();
        write_draft_at(Some(root.path()), &state, "s1", "add", &json!({"topic": "b", "recipient": "standup", "body": "y"})).unwrap();
        let vault = vault_with(&[("Lenar Rakhmatulin", "aliases: [Lenar]\nrelationship: \"coworker (Zirtue QA)\"")]);
        let v = list_message_drafts_in(Some(root.path()), Some(vault.path()), &state, "s1").unwrap();
        assert_eq!(v["drafts"][0]["variants"][0]["person"], "Lenar Rakhmatulin");
        assert_eq!(v["drafts"][1]["variants"][0]["platform"], "Standup");
        assert_eq!(v["people"].as_array().unwrap().len(), 1);
        assert_eq!(v["people"][0]["relationship"], "coworker (Zirtue QA)");
        // Read-time only: the store still holds what was written.
        assert!(list_at_path(root.path())[0].variants[0].person.is_none());
    }

    #[test]
    fn list_names_old_platforms_the_way_the_panel_shows_them() {
        let root = tempfile::tempdir().unwrap();
        let state = registered();
        write_draft_at(Some(root.path()), &state, "s1", "add", &json!({"topic": "55910 handoff", "recipient": "zng-admin chat", "platform": "Claude chats", "body": "Pick up sc-55910"})).unwrap();
        write_draft_at(Some(root.path()), &state, "s1", "add", &json!({"topic": "sc-56157 retest note", "recipient": "Lenar", "body": "@lenar a draft now only counts once"})).unwrap();
        write_draft_at(Some(root.path()), &state, "s1", "add", &json!({"topic": "Lender DOB, sc-56160", "recipient": "Stevan", "body": "Ej, https://app.shortcut.com/zirtue/story/56160"})).unwrap();
        let v = list_message_drafts_in(Some(root.path()), None, &state, "s1").unwrap();
        assert_eq!(v["drafts"][0]["variants"][0]["platform"], "Prompts");
        assert_eq!(v["drafts"][1]["variants"][0]["platform"], "Shortcut", "an @mention on a ticket topic is a Shortcut comment");
        assert!(v["drafts"][2]["variants"][0]["platform"].is_null(), "a DM about a ticket is not posted on Shortcut");
    }

    fn list_at_path(root: &Path) -> Vec<MessageDraft> {
        list_for(Some(root), "proj-1")
    }

    #[test]
    fn receipts_skip_malformed_entries_instead_of_failing_the_write() {
        let parsed = receipts_from(Some(&json!([
            {"claim": "refreshToken()", "source": "src/auth/session.ts:88"},
            {"claim": "  ", "source": "nowhere"},
            {"claim": "no source"},
            "not an object"
        ])));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].claim, "refreshToken()");
    }
}
