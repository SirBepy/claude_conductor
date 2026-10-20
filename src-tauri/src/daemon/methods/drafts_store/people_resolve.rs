//! Vault/person resolution for the draft RPCs: who a recipient is and which
//! platform a draft goes to, split out so the RPC module stays about routing.

use crate::people::{self, Person, Resolved};
use crate::sessions::message_drafts::{self as store, MessageDraft};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

/// Fills `person`/`platform` on variants written before those fields existed,
/// from the free-text `recipient` (else the body, for a Shortcut comment), for
/// this response only - the store keeps what was written. A stored `person` is
/// never second-guessed; a stored platform only gets its current name.
pub(super) fn annotate(drafts: &mut [MessageDraft], everyone: &[Person]) -> Vec<Person> {
    let mut used: BTreeMap<String, Person> = BTreeMap::new();
    for draft in drafts.iter_mut() {
        for variant in draft.variants.iter_mut() {
            variant.platform = match variant.platform.take() {
                Some(p) => Some(store::canonical_platform(&p).to_string()),
                None => store::infer_platform(&variant.recipient)
                    .or_else(|| store::infer_platform_from_body(&draft.topic, store::current_body(variant)))
                    .map(str::to_string),
            };
        }
    }
    for variant in drafts.iter_mut().flat_map(|d| d.variants.iter_mut()) {
        if variant.person.is_none() {
            if let Resolved::One(p) = people::resolve(everyone, &variant.recipient) {
                variant.person = Some(p.id.clone());
            }
        }
        if let Some(p) = variant.person.as_ref().and_then(|id| everyone.iter().find(|p| &p.id == id)) {
            used.entry(p.id.clone()).or_insert_with(|| p.clone());
        }
    }
    used.into_values().collect()
}

/// The `person` a write names, checked against the vault. An unknown name is
/// an error on purpose: a draft is the one place a wrong person costs
/// something, so this refuses rather than guessing. With no vault on this
/// machine the name is trusted as given. Inside a client's repo, the names
/// people go by there ("backend") resolve too, and a new person joins that
/// client.
pub(super) fn person_for_write(vault: Option<&Path>, client: Option<&str>, args: &Value) -> Result<Option<Person>, String> {
    let wanted = args.get("person").and_then(|v| v.as_str()).unwrap_or("").trim();
    if wanted.is_empty() {
        return Ok(None);
    }
    let Some(vault) = vault else {
        return Ok(Some(Person { id: wanted.into(), name: wanted.into(), ..Default::default() }));
    };
    let everyone = people::list_at(vault);
    match people::resolve_in(&everyone, wanted, client) {
        Resolved::One(p) => Ok(Some(p.clone())),
        Resolved::Ambiguous(hits) => {
            let names: Vec<&str> = hits.iter().map(|p| p.id.as_str()).collect();
            Err(format!(
                "\"{wanted}\" matches more than one person in the user's vault: {}. Ask the user which one, then pass that exact name as `person`.",
                names.join(", ")
            ))
        }
        Resolved::None if args.get("new_person").and_then(|v| v.as_bool()).unwrap_or(false) => {
            let aliases: Vec<String> = args
                .get("aliases")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let relationship = args.get("relationship").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let projects = client.map(|c| vec![c.to_string()]).unwrap_or_default();
            people::create_at(vault, wanted, &people::NewPerson { aliases, relationship, projects, ..Default::default() }).map(Some)
        }
        Resolved::None => Err(format!(
            "No one called \"{wanted}\" in the user's vault (People/). If you are not certain who the user means, ask them first with ask_user_question, suggesting likely matches. Once you know: pass their exact vault name as `person`, or, for someone genuinely new, the full name with `new_person: true` plus `aliases`/`relationship` to create their People note."
        )),
    }
}

/// `recipient` is optional on a write: the person's name, else the platform,
/// labels the variant and keys its `Bruno #2` handle.
pub(super) fn recipient_label(given: &str, person: Option<&Person>, platform: &str) -> Result<String, String> {
    [given, person.map(|p| p.name.as_str()).unwrap_or(""), platform]
        .into_iter()
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "recipient, person or platform is required".to_string())
}

/// The platform Claude named, else one read off the recipient text.
pub(super) fn platform_for(given: &str, recipient: &str) -> Option<String> {
    let given = given.trim();
    if given.is_empty() {
        store::infer_platform(recipient).map(str::to_string)
    } else {
        Some(given.to_string())
    }
}
