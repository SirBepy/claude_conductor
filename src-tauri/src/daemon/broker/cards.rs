//! The three broker cards only Joe can answer (step 7): import the tokens from
//! `~/.claude/.env` into the protected store, add or replace one token, and add
//! the policy row a denied call needs. What each one changes is `card_ops`; this
//! file decides who may raise one and who may answer it.
//!
//! **Raising.** A chat raises a card through the `api_card` MCP tool
//! (`hooks_server::api_broker_card`). The card is an ordinary daemon card
//! (`subchats::cards::raise_card_with`: ring, push, parked store, dropped when its
//! chat ends) whose `card_kind` starts with `broker_`. The rows it will change are
//! built here, by the daemon, from the machine's own state; a chat names only the
//! kind and, for a policy card, the call it was denied.
//!
//! **Answering.** Only `respond_broker_card`, an RPC on the desktop pipe that is
//! absent from `TRANSPORT_TABLE`, answers one, and it checks `ctx.transport ==
//! Local` as well. Every other answer path refuses a broker card: `respond_question`
//! (`respond_question_as`), the `<auq-answer id="..."/>` marker in a user message
//! (`settle_answered_questions`) and the when-done engine (`auto_by` goes through
//! `respond_question`). A phone or a paired machine never lists one
//! (`list_pending_prompts`, the global stream pump).
//!
//! **Values.** A pasted token travels only in `respond_broker_card`'s `value`, into
//! `card_ops::replace_secret`. It is never in a prompt payload, a question answer,
//! the decisions log, the audit log or any error text.

use super::card_ops::{self, CardEnv, ImportRow, ImportStatus, PolicyProposal};
use super::policy_rules::PolicyRow;
use super::services::{Service, ServiceTable};
use crate::api_keys;
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::cards::{raise_card_with, CardOption, RaisedCard};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

pub const KIND_IMPORT: &str = "broker_import";
pub const KIND_REPLACE: &str = "broker_replace";
pub const KIND_POLICY: &str = "broker_policy";

/// Open broker cards a chat may have at once. A chat that keeps asking gets one
/// refusal naming the cap instead of a stack of cards.
const MAX_OPEN_PER_CHAT: usize = 3;

pub const APPROVE_LABEL: &str = "Approve";
pub const DECLINE_LABEL: &str = "Decline";

/// Whether a `card_kind` names a broker card.
pub fn is_broker_kind(kind: &str) -> bool {
    matches!(kind, KIND_IMPORT | KIND_REPLACE | KIND_POLICY)
}

/// Whether a prompt payload is a broker card.
pub fn is_broker_payload(payload: &Value) -> bool {
    payload["card_kind"].as_str().is_some_and(is_broker_kind)
}

/// Whether the open prompt `id` is a broker card. A card that is not open is not one.
pub async fn is_broker_prompt(state: &Arc<DaemonState>, id: &str) -> bool {
    state.prompt_payload(id).await.is_some_and(|p| is_broker_payload(&p))
}

#[derive(Clone)]
enum What {
    Import(Vec<ImportRow>),
    Replace { name: &'static str },
    Policy { service: Service, row: PolicyRow },
}

#[derive(Clone)]
struct Open {
    /// An answer is being applied: a second answer waits for it instead of racing it.
    busy: bool,
    /// The daemon state that raised it, so one state's sweep never forgets another's cards
    /// (the app has one; a test builds many).
    owner: usize,
    /// The chat that asked: the audit line's session.
    requester: String,
    /// The chat whose window shows the card.
    display: String,
    kind: &'static str,
    /// Same kind, chat and subject means the same card.
    subject: String,
    env: Arc<CardEnv>,
    what: What,
}

/// Cards raised by this process and not yet answered. Never persisted: a raised
/// card is dropped at a restart (`subchats::cards`), so this map and the prompt
/// store start empty together.
fn open_cards() -> &'static Mutex<HashMap<String, Open>> {
    static OPEN: OnceLock<Mutex<HashMap<String, Open>>> = OnceLock::new();
    OPEN.get_or_init(Default::default)
}

/// A card the daemon raised, or the one already open for the same ask.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Raised {
    pub card_id: String,
    pub already_open: bool,
    /// What the chat is told: names only.
    pub summary: String,
}

/// Key prefix of a card whose prompt is still being raised: the cap sees it, and a second ask for
/// the same card is told to retry, so two asks made at once cannot both pass; `prune` leaves it alone.
const RESERVING: &str = "reserving-";

/// A reserved slot; dropping it (a failed raise, or a `post` dropped mid-way) frees the slot.
struct Reservation {
    key: String,
    armed: bool,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if self.armed {
            open_cards().lock().unwrap_or_else(|e| e.into_inner()).remove(&self.key);
        }
    }
}

fn owner_of(state: &Arc<DaemonState>) -> usize {
    Arc::as_ptr(state) as usize
}

/// Forgets cards whose prompt is gone (their chat ended, or the daemon swept them).
async fn prune(state: &Arc<DaemonState>) {
    let owner = owner_of(state);
    let ids: Vec<String> = open_cards().lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|(id, o)| o.owner == owner && !id.starts_with(RESERVING)).map(|(id, _)| id.clone()).collect();
    for id in ids {
        if state.prompt_session_id(&id).await.is_none() {
            open_cards().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        }
    }
}

/// The registry key names' service, for clearing what the engine remembered.
pub fn service_of_name(name: &str) -> Option<Service> {
    let table = ServiceTable::production();
    Service::ALL.into_iter().find(|s| table.get(*s).is_some_and(|spec| spec.secret_names().contains(&name)))
}

struct Posted {
    kind: &'static str,
    subject: String,
    header: String,
    question: String,
    extra: Value,
    what: What,
}

async fn post(state: &Arc<DaemonState>, env: Arc<CardEnv>, requester: &str, p: Posted) -> Result<Raised, String> {
    static RESERVED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    prune(state).await;
    let display = crate::daemon::subchats::display_session_id(state, requester);
    let owner = owner_of(state);
    let key = format!("{RESERVING}{}", RESERVED.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    // The check and the reservation are one step under the lock.
    let mut reservation = Reservation { key: key.clone(), armed: false };
    {
        let mut open = open_cards().lock().unwrap_or_else(|e| e.into_inner());
        if let Some((id, o)) = open.iter().find(|(_, o)| o.owner == owner && o.kind == p.kind && o.display == display && o.subject == p.subject) {
            // Neither a card still being raised nor one Joe just answered is "open for Joe" to report.
            if id.starts_with(RESERVING) {
                return Err("another ask for this card is being raised: ask again in a moment".into());
            }
            if o.busy {
                return Err("Joe is answering that card right now: ask again in a moment".into());
            }
            return Ok(Raised { card_id: id.clone(), already_open: true, summary: "that card is already open for Joe".into() });
        }
        if open.values().filter(|o| o.owner == owner && o.display == display).count() >= MAX_OPEN_PER_CHAT {
            return Err(format!("Joe already has {MAX_OPEN_PER_CHAT} broker cards open in this chat: wait for him to answer one"));
        }
        open.insert(
            key.clone(),
            Open { busy: false, owner, requester: requester.to_string(), display: display.clone(), kind: p.kind, subject: p.subject, env, what: p.what },
        );
        reservation.armed = true;
    }
    let card = RaisedCard {
        kind: p.kind,
        display_session_id: display,
        sub_id: None,
        header: p.header,
        question: p.question,
        options: vec![
            CardOption::new(APPROVE_LABEL, "Does exactly what the card lists"),
            CardOption::new(DECLINE_LABEL, "Changes nothing"),
        ],
        domain: Some("sec"),
    };
    let handle = raise_card_with(state, card, json!({ "broker_card": p.extra })).await?;
    let card_id = handle.card_id.clone();
    // Nothing waits on the handle: `respond` does the work and settles the prompt.
    drop(handle);
    {
        let mut open = open_cards().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(o) = open.remove(&key) {
            open.insert(card_id.clone(), o);
        }
        reservation.armed = false;
    }
    Ok(Raised { card_id, already_open: false, summary: "a card is open for Joe; he answers it himself".into() })
}

fn name_list(rows: &[&ImportRow]) -> String {
    rows.iter().map(|r| r.name).collect::<Vec<_>>().join(", ")
}

// ---- raising -----------------------------------------------------------------

/// The import card: copies the tokens in `~/.claude/.env` that the protected store lacks.
/// `Err` (no card) when this machine has no protected store, or nothing is left to copy;
/// the text then lists what is missing.
pub async fn raise_import(state: &Arc<DaemonState>, env: Arc<CardEnv>, requester: &str) -> Result<Raised, String> {
    let plan = card_ops::plan_import(&env)?;
    let copy: Vec<&ImportRow> = plan.iter().filter(|r| r.status == ImportStatus::Copy).collect();
    if copy.is_empty() {
        let missing: Vec<&ImportRow> = plan.iter().filter(|r| r.status == ImportStatus::Missing).collect();
        return Err(if missing.is_empty() {
            "nothing to import: every token the broker knows is already in the protected store (or PC only)".into()
        } else {
            format!("nothing to import from .env; not found there: {}. Joe adds them with the replace card (kind \"replace\")", name_list(&missing))
        });
    }
    let machine = card_ops::machine_label();
    let question = format!(
        "Copy {} token{} from ~/.claude/.env into {}'s protected store ({})? The file is left as it is.",
        copy.len(),
        if copy.len() == 1 { "" } else { "s" },
        machine,
        env.backend_label()
    );
    let extra = json!({
        "kind": "import",
        "machine": machine,
        "store": env.backend_label(),
        "rows": plan,
    });
    post(state, env, requester, Posted {
        kind: KIND_IMPORT,
        subject: "import".into(),
        header: "Import tokens".into(),
        question,
        extra,
        what: What::Import(plan.clone()),
    })
    .await
}

/// The add/replace card for one registry key. `Err` (no card) when this machine cannot
/// hold it: no protected store, or Hubstaff on a Mac.
pub async fn raise_replace(state: &Arc<DaemonState>, env: Arc<CardEnv>, requester: &str, name: &str) -> Result<Raised, String> {
    let entry = api_keys::entry(name).ok_or_else(|| {
        let known: Vec<&str> = api_keys::REGISTRY.iter().map(|e| e.env_name).collect();
        format!("{name} is not a token the broker knows: {}", known.join(", "))
    })?;
    if let Some(why) = card_ops::replace_refusal(&env, entry.env_name) {
        return Err(why);
    }
    let stored = card_ops::is_stored(&env, entry.env_name);
    let machine = card_ops::machine_label();
    let verb = if stored { "Replace" } else { "Add" };
    let question = format!("{verb} {} on {}. Joe pastes it into the field; it goes straight into the protected store.", entry.label, machine);
    let extra = json!({
        "kind": "replace",
        "name": entry.env_name,
        "label": entry.label,
        "purpose": entry.purpose,
        "create_url": entry.create_url,
        "stored": stored,
        "machine": machine,
        "store": env.backend_label(),
    });
    post(state, env, requester, Posted {
        kind: KIND_REPLACE,
        subject: entry.env_name.to_string(),
        header: format!("{verb} token"),
        question,
        extra,
        what: What::Replace { name: entry.env_name },
    })
    .await
}

/// The policy card for a denied call: the daemon builds the one row that would allow it.
/// `Err` (no card) when the chat is not bound to the service, the call is already
/// allowed, or no row can allow it.
pub async fn raise_policy(state: &Arc<DaemonState>, env: Arc<CardEnv>, requester: &str, proposal: PolicyProposal) -> Result<Raised, String> {
    // Same rule as a denial: an unbound service gets the binding line, never a card.
    // No claims is a refusal, not a pass: after a daemon restart the in-memory claims are empty until the
    // chat relaunches, and a forged session id on the card route has none either, so "unknown" must not
    // read as "bound to everything".
    let Some(claims) = state.broker_sessions.current(requester) else {
        return Err("this chat has no broker scope (the daemon restarted since its last turn, or the id is not a chat of this daemon): send a message to the chat so it relaunches with its scope, then ask again".to_string());
    };
    if !claims.services.contains(&proposal.service) {
        return Err(format!(
            "{} is not bound to this chat, so the policy cannot be asked about it: add it to the project's broker_services first",
            proposal.service.name()
        ));
    }
    let current = super::policy_file::load_effective(&env.policy_path)?;
    let row = card_ops::propose_row_against(&proposal, Some(&current))?;
    let line = card_ops::row_line(&row);
    let extra = json!({
        "kind": "policy",
        "service": proposal.service.name(),
        "method": row.method,
        "path": row.path,
        "op": row.op,
        "require_owner": row.require_owner,
        "line": line,
        "file": super::policy_file::POLICY_FILE,
    });
    let question = format!("Allow this call from now on? One row is added to {}.", super::policy_file::POLICY_FILE);
    post(state, env, requester, Posted {
        kind: KIND_POLICY,
        subject: line.clone(),
        header: "Policy edit".into(),
        question,
        extra,
        what: What::Policy { service: proposal.service, row },
    })
    .await
}

// ---- answering ---------------------------------------------------------------

/// What Joe did on the card.
pub enum Action {
    /// `value` is the pasted token, for a replace card only.
    Approve { value: Option<String> },
    Decline,
}

/// Clears the busy mark when an answer ends, however it ends (a refusal, or a call dropped mid-way).
struct Busy(String);

impl Drop for Busy {
    fn drop(&mut self) {
        if let Some(o) = open_cards().lock().unwrap_or_else(|e| e.into_inner()).get_mut(&self.0) {
            o.busy = false;
        }
    }
}

/// Answers that mean the card is gone: the response carries `closed: true`, so the card on screen
/// leaves instead of staying up with nothing to answer.
const CLOSED: &str = "this card was already closed";
const NO_SUCH_CARD: &str = "no such broker card";

/// Test seams: a card whose entry was lost while its prompt stays up, and one that is mid-answer.
#[cfg(test)]
pub(crate) fn lose_entry(id: &str) {
    open_cards().lock().unwrap_or_else(|e| e.into_inner()).remove(id);
}

#[cfg(test)]
pub(crate) fn mark_busy(id: &str) {
    if let Some(o) = open_cards().lock().unwrap_or_else(|e| e.into_inner()).get_mut(id) {
        o.busy = true;
    }
}

/// Applies Joe's answer. `Err` leaves the card open for a retry (the store refused
/// the value, the policy file would not take the row) with a reason that names no value;
/// `Ok` carries what changed and the card is gone.
pub async fn respond(state: &Arc<DaemonState>, request_id: &str, action: Action) -> Result<Value, String> {
    // The entry stays in the registry while the answer applies, marked busy, so a second answer
    // cannot apply the same card twice and a call dropped mid-way leaves a card that still answers.
    let found = {
        let mut cards = open_cards().lock().unwrap_or_else(|e| e.into_inner());
        match cards.get_mut(request_id) {
            None => None,
            Some(entry) if entry.busy => return Err("this card is being answered".into()),
            Some(entry) => {
                entry.busy = true;
                Some(entry.clone())
            }
        }
    };
    let Some(open) = found else {
        // A broker prompt with no entry (a raise or an answer cut off mid-way) would stay on screen
        // for good: take it down, and say so instead of leaving the card unanswerable.
        if is_broker_prompt(state, request_id).await {
            settle(state, request_id).await;
            return Err(CLOSED.into());
        }
        return Err(NO_SUCH_CARD.into());
    };
    let _busy = Busy(request_id.to_string());
    let open = &open;
    let outcome = match action {
        Action::Decline => {
            card_ops::audit_card(&open.env, &open.requester, service_label(&open.what), card_name(&open.what), "card_declined", "declined".into());
            Ok(json!({ "declined": true }))
        }
        Action::Approve { value } => apply(state, open, value).await,
    };
    let result = outcome?;
    open_cards().lock().unwrap_or_else(|e| e.into_inner()).remove(request_id);
    settle(state, request_id).await;
    Ok(result)
}

fn card_name(what: &What) -> &'static str {
    match what {
        What::Import(_) => "import",
        What::Replace { .. } => "replace",
        What::Policy { .. } => "policy",
    }
}

fn service_label(what: &What) -> &str {
    match what {
        What::Import(_) => "all",
        What::Replace { name } => service_of_name(name).map(Service::name).unwrap_or("unknown"),
        What::Policy { service, .. } => service.name(),
    }
}

async fn apply(state: &Arc<DaemonState>, open: &Open, value: Option<String>) -> Result<Value, String> {
    let env = open.env.clone();
    let audit = |outcome: &'static str, reason: String| {
        card_ops::audit_card(&open.env, &open.requester, service_label(&open.what), card_name(&open.what), outcome, reason);
    };
    match &open.what {
        What::Import(rows) => {
            let rows = rows.clone();
            let report = tokio::task::spawn_blocking(move || card_ops::apply_import(&env, &rows)).await.map_err(|e| e.to_string())?;
            let failed: Vec<Value> = report.failed.iter().map(|(n, why)| json!({ "name": n, "reason": why })).collect();
            let reason = format!(
                "stored: [{}]; not stored: [{}]",
                report.stored.join(", "),
                report.failed.iter().map(|(n, why)| format!("{n}: {why}")).collect::<Vec<_>>().join("; ")
            );
            if report.stored.is_empty() && !report.failed.is_empty() {
                audit("card_failed", reason);
                return Err(format!("nothing was stored: {}", report.failed.iter().map(|(n, why)| format!("{n}: {why}")).collect::<Vec<_>>().join("; ")));
            }
            audit("card_import", reason);
            for name in &report.stored {
                forget(state, name).await;
            }
            Ok(json!({ "stored": report.stored, "failed": failed }))
        }
        What::Replace { name } => {
            let Some(pasted) = value else {
                return Err("paste the token into the field first".into());
            };
            let name: &'static str = name;
            let result = tokio::task::spawn_blocking(move || card_ops::replace_secret(&env, name, &pasted)).await.map_err(|e| e.to_string())?;
            match result {
                Ok(()) => {
                    audit("card_replace", format!("{name} stored"));
                    forget(state, name).await;
                    Ok(json!({ "stored": [name] }))
                }
                Err(e) => {
                    audit("card_failed", format!("{name}: {e}"));
                    Err(e)
                }
            }
        }
        What::Policy { row, .. } => {
            let row = row.clone();
            let line = card_ops::row_line(&row);
            match card_ops::apply_policy_row(&env, row) {
                Ok(added) => {
                    audit("card_policy", if added { format!("row added: {line}") } else { format!("row was already there: {line}") });
                    Ok(json!({ "added": added, "line": line }))
                }
                Err(e) => {
                    audit("card_failed", format!("policy row not written: {e}"));
                    Err(e)
                }
            }
        }
    }
}

/// A token changed: the engine forgets the account it had cached for that service.
async fn forget(state: &Arc<DaemonState>, name: &str) {
    if let (Some(service), Some(engine)) = (service_of_name(name), state.broker_engine_if_built()) {
        engine.forget_service(service).await;
    }
}

/// Closes the card: resolves its waiter, takes the prompt down and settles the
/// chat's "needs input" state.
async fn settle(state: &Arc<DaemonState>, request_id: &str) {
    if let Some(tx) = state.pending.lock().await.remove(request_id) {
        let _ = tx.send(json!({ "answers": { "broker": "answered" } }));
    }
    crate::daemon::methods::permission::settle_prompt(state, request_id, true).await;
}

// ---- the RPC -----------------------------------------------------------------

/// The `respond_broker_card` handler's body, apart from the transport check.
pub async fn respond_from_params(state: &Arc<DaemonState>, params: Value) -> Value {
    #[derive(serde::Deserialize)]
    struct Body {
        request_id: String,
        action: String,
        // Never `Debug`: this is the pasted token.
        #[serde(default)]
        value: Option<String>,
    }
    let b: Body = match serde_json::from_value(params) {
        Ok(b) => b,
        // Fixed text: serde's own error quotes the string that did not fit, which can be the pasted token.
        Err(_) => return json!({ "ok": false, "error": "bad params: request_id and action must be strings, and value a string when given" }),
    };
    let action = match b.action.as_str() {
        "approve" => Action::Approve { value: b.value },
        "decline" => Action::Decline,
        // The action is not echoed either: this call's `value` rides beside it.
        _ => return json!({ "ok": false, "error": "action must be approve or decline" }),
    };
    match respond(state, &b.request_id, action).await {
        Ok(mut result) => {
            result["ok"] = json!(true);
            result
        }
        Err(e) => json!({ "ok": false, "error": e, "closed": e == CLOSED || e == NO_SUCH_CARD }),
    }
}
