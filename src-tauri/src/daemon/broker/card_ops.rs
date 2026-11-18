//! What the three broker cards change: the protected store (import and
//! add/replace) and `broker-policy.json` (policy edit). Pure of any card or
//! prompt: a card module decides WHO may trigger these, this file only does the
//! work, so each effect and refusal is a plain test with an injected store.
//!
//! A value passes through here only as a local on its way into
//! `api_keys::set_broker_secret`. No function returns one, no error names one, and
//! `ImportRow` holds names and a status, never a value.

use super::audit::{AuditEntry, AuditLog};
use super::guards::{self, Limits, Method};
use super::policy::PolicyRequest;
use super::policy_file;
use super::policy_rules::{suggest_row, PolicyFile, PolicyRow, Rules, LINEAR_OPS};
use super::services::{Service, ServiceTable};
use crate::api_keys::{self, SecretOrigin};
use crate::util::secret_store::{native_backend, Backend, CommandRunner, SystemRunner};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// The one key that rotates on every use. It lives only in a store the engine can
/// rewrite (`SecretSource::can_rotate`), which is DPAPI on the PC.
pub const PC_ONLY_KEY: &str = "HUBSTAFF_REFRESH_TOKEN";

/// Where the cards read and write. `system` is the real machine; a test builds its own.
pub struct CardEnv {
    pub store_path: PathBuf,
    pub env_file: Option<PathBuf>,
    pub backend: Backend,
    pub runner: Box<dyn CommandRunner + Send + Sync>,
    pub policy_path: PathBuf,
    pub audit_path: PathBuf,
}

impl CardEnv {
    pub fn system(data_dir: &Path) -> Self {
        Self {
            store_path: api_keys::broker_store_path(data_dir),
            env_file: api_keys::env_path(),
            backend: native_backend(),
            runner: Box::new(SystemRunner),
            policy_path: policy_file::policy_path(data_dir),
            audit_path: data_dir.join(super::front::AUDIT_FILE),
        }
    }

    /// Where a stored token lives on this machine, as a word the card shows.
    pub fn backend_label(&self) -> &'static str {
        match self.backend {
            Backend::Dpapi => "Windows DPAPI",
            Backend::Keychain => "macOS Keychain",
            Backend::Unavailable => "no protected store",
        }
    }

    /// Whether Hubstaff's rotating refresh token may be kept here.
    pub fn can_hold_rotating(&self) -> bool {
        self.backend == Backend::Dpapi
    }
}

/// The machine the card is about, in the words the card shows ("one per machine").
pub fn machine_label() -> &'static str {
    if cfg!(windows) {
        "this PC"
    } else if cfg!(target_os = "macos") {
        "this Mac"
    } else {
        "this machine"
    }
}

pub const PC_ONLY_NOTE: &str = "PC only: the refresh token rotates on every use, so it is never copied to a Mac";

// ---- import ------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportStatus {
    /// In `.env`, not yet in the protected store: the card copies it.
    Copy,
    /// Already in the protected store; import never replaces it (the replace card does).
    Kept,
    /// Not in `.env`: nothing to copy, and the add/replace card is the way to add it.
    Missing,
    /// Hubstaff on a machine that cannot hold a rotating token.
    PcOnly,
}

/// One registry key and what import would do with it. No value, ever.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ImportRow {
    pub name: &'static str,
    pub label: &'static str,
    pub status: ImportStatus,
    /// The `.env` line name the value is read from, when it differs from `name`
    /// (Trello's key is `TRELLO_KEY` in the file the `~/.claude` tools wrote).
    pub from: Option<&'static str>,
}

fn env_text(env: &CardEnv) -> String {
    env.env_file.as_deref().map(|p| std::fs::read_to_string(p).unwrap_or_default()).unwrap_or_default()
}

/// The `.env` line a registry key is read from, `None` when absent or empty.
fn env_line_for(text: &str, name: &'static str) -> Option<&'static str> {
    let names: &[&'static str] = match api_keys::env_names(name) {
        [] => return crate::env_file::read_value(text, name).map(|_| name),
        aliases => aliases,
    };
    names.iter().copied().find(|n| crate::env_file::read_value(text, n).is_some())
}

/// What importing would do, key by key. `Err` when this machine has no protected
/// store at all: nothing could be imported, and the card should say why instead
/// of listing rows it cannot apply.
pub fn plan_import(env: &CardEnv) -> Result<Vec<ImportRow>, String> {
    if env.backend == Backend::Unavailable {
        return Err("this machine has no protected secret store, and broker tokens are never kept as plaintext".into());
    }
    let text = env_text(env);
    Ok(api_keys::REGISTRY
        .iter()
        .map(|e| {
            let line = env_line_for(&text, e.env_name);
            let status = if e.env_name == PC_ONLY_KEY && !env.can_hold_rotating() {
                ImportStatus::PcOnly
            } else if api_keys::broker_has(&env.store_path, e.env_name) {
                ImportStatus::Kept
            } else if line.is_some() {
                ImportStatus::Copy
            } else {
                ImportStatus::Missing
            };
            ImportRow { name: e.env_name, label: e.label, status, from: line.filter(|l| *l != e.env_name) }
        })
        .collect())
}

/// What an applied import did. Names only.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImportReport {
    pub stored: Vec<&'static str>,
    /// A key the card listed that could not be stored now, with a reason that names no value.
    pub failed: Vec<(&'static str, String)>,
}

/// Copies the keys the card listed as `Copy` from `.env` into the protected store.
/// Each is judged again now (the file or the store may have changed while the card
/// was open) and anything that is no longer a plain `Copy` is left alone, so the
/// card can never change a row it did not show. `.env` is not touched.
pub fn apply_import(env: &CardEnv, shown: &[ImportRow]) -> ImportReport {
    let mut report = ImportReport::default();
    let Ok(now) = plan_import(env) else {
        for r in shown.iter().filter(|r| r.status == ImportStatus::Copy) {
            report.failed.push((r.name, "no protected store on this machine".into()));
        }
        return report;
    };
    let text = env_text(env);
    for shown_row in shown.iter().filter(|r| r.status == ImportStatus::Copy) {
        let still_copy = now.iter().any(|n| n.name == shown_row.name && n.status == ImportStatus::Copy);
        if !still_copy {
            report.failed.push((shown_row.name, "changed while the card was open, so it was left alone".into()));
            continue;
        }
        let Some(value) = api_keys::read_env_value(&text, shown_row.name) else {
            report.failed.push((shown_row.name, "no longer in .env".into()));
            continue;
        };
        match store_and_verify(env, shown_row.name, &value) {
            Ok(()) => report.stored.push(shown_row.name),
            Err(e) => report.failed.push((shown_row.name, e)),
        }
    }
    report
}

/// Stores `value` and reads it back, so "stored" means the engine will find it.
/// The error never carries the value: `set_broker_secret` and the backends name the
/// key and the reason only, and the comparison below prints nothing.
fn store_and_verify(env: &CardEnv, name: &str, value: &str) -> Result<(), String> {
    api_keys::set_broker_secret(&env.store_path, env.backend, &*env.runner, name, value)?;
    match api_keys::resolve_secret(&env.store_path, None, env.backend, &*env.runner, name)? {
        Some((v, SecretOrigin::BrokerStore)) if v == value => Ok(()),
        _ => Err("the stored value did not read back".into()),
    }
}

// ---- add / replace -----------------------------------------------------------

/// Why a name cannot take a pasted value on this machine, `None` when it can.
pub fn replace_refusal(env: &CardEnv, name: &str) -> Option<String> {
    if api_keys::entry(name).is_none() {
        return Some(format!("{name} is not a key the broker knows"));
    }
    if env.backend == Backend::Unavailable {
        return Some("this machine has no protected secret store, and broker tokens are never kept as plaintext".into());
    }
    if name == PC_ONLY_KEY && !env.can_hold_rotating() {
        return Some(format!("{name}: {PC_ONLY_NOTE}"));
    }
    None
}

/// Stores a pasted token under a registry name, replacing any earlier one.
/// Surrounding whitespace is dropped (a paste usually carries a newline); a value
/// left empty or with a newline inside is refused.
pub fn replace_secret(env: &CardEnv, name: &str, pasted: &str) -> Result<(), String> {
    if let Some(why) = replace_refusal(env, name) {
        return Err(why);
    }
    let value = pasted.trim();
    if value.is_empty() {
        return Err("the field is empty".into());
    }
    store_and_verify(env, name, value)
}

/// Whether the broker store already holds `name`, for "Add" versus "Replace".
pub fn is_stored(env: &CardEnv, name: &str) -> bool {
    api_keys::broker_has(&env.store_path, name)
}

// ---- policy ------------------------------------------------------------------

/// The call a chat was denied, as the policy card receives it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyProposal {
    pub service: Service,
    pub method: String,
    pub path: String,
    pub op: Option<String>,
}

/// The one row Joe would add for a denied call, built by the daemon from the call
/// and never taken from the requester as text. `Err` names why no row can allow it
/// (a read is already open, a Linear operation outside the pinned three, a path the
/// guards refuse), so such a card is never raised.
pub fn propose_row(p: &PolicyProposal) -> Result<PolicyRow, String> {
    propose_row_against(p, None)
}

/// [`propose_row`] that also refuses a call the policy in force (`current`) already
/// allows: a row for it would change nothing, so no card is raised for it.
pub fn propose_row_against(p: &PolicyProposal, current: Option<&PolicyFile>) -> Result<PolicyRow, String> {
    let linear_op = if p.service == Service::Linear {
        let op = p.op.as_deref().map(str::trim).filter(|o| !o.is_empty()).ok_or("a Linear write needs its operation: commentCreate, issueCreate or issueUpdate")?;
        if !LINEAR_OPS.iter().any(|(o, _)| *o == op) {
            return Err(format!("{op} is not an operation the policy can allow; only commentCreate, issueCreate and issueUpdate are"));
        }
        Some(op.to_string())
    } else {
        None
    };
    let table = ServiceTable::production();
    let spec = table.get(p.service).ok_or("unknown service")?;
    let (method, path) = if linear_op.is_some() {
        (Method::Post, "/graphql".to_string())
    } else {
        let checked = guards::check(spec, &p.method, &p.path, &[], 0, &Limits::default()).map_err(|e| e.message)?;
        if checked.method == Method::Get {
            return Err("a GET is already open on a bound service, so no row is needed".into());
        }
        (checked.method, checked.path)
    };
    let req = PolicyRequest { session: "policy-card", service: p.service, method, path: &path, query: None, read: false, linear_op: linear_op.as_deref() };
    if let Some(file) = current {
        let now = Rules::compile(file)?;
        if matches!(now.evaluate(&req).into_decision("broker-policy.json"), super::policy::PolicyDecision::Allow { .. }) {
            return Err("the policy already allows this call: retry it".into());
        }
    }
    let row = suggest_row(&req);
    // The row must allow the call it was proposed for, or approving it would not
    // unblock anything and the card would be noise.
    let rules = Rules::compile(&PolicyFile { version: 1, rows: vec![row.clone()] })?;
    match rules.evaluate(&req).into_decision("broker-policy.json") {
        super::policy::PolicyDecision::Allow { .. } => Ok(row),
        super::policy::PolicyDecision::Deny { reason, .. } => Err(format!("no row can allow this call: {reason}")),
    }
}

/// The row exactly as it will be written to the file's `rows`.
pub fn row_line(row: &PolicyRow) -> String {
    serde_json::to_string(row).unwrap_or_default()
}

/// Appends `row` through the policy file's one write function. `Ok(false)` when an
/// identical row was already there.
pub fn apply_policy_row(env: &CardEnv, row: PolicyRow) -> Result<bool, String> {
    policy_file::add_row(&env.policy_path, row)
}

// ---- audit -------------------------------------------------------------------

/// One line in `broker-audit.jsonl` for a card event. `path` names the card
/// (`import`, `replace`, `policy`) and `reason` lists key names or the row, never a value.
pub fn audit_card(env: &CardEnv, session: &str, service: &str, card: &str, outcome: &'static str, reason: String) {
    let entry = AuditEntry {
        session: session.to_string(),
        service: service.to_string(),
        method: "CARD".into(),
        path: card.to_string(),
        status: None,
        outcome,
        reason: Some(reason),
        req_bytes: 0,
        resp_bytes: 0,
        unmasked: false,
    };
    if let Err(e) = AuditLog::new(env.audit_path.clone()).record(&entry) {
        log::error!("[broker] could not audit a {card} card: {e}");
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// In-memory `/usr/bin/security`: `add-generic-password` on stdin, `find-generic-password` in argv.
    #[derive(Default)]
    pub struct FakeKeychain {
        pub items: Mutex<HashMap<String, String>>,
        /// Refuses every write, as a locked Keychain does.
        pub locked: bool,
    }

    impl CommandRunner for FakeKeychain {
        fn run(&self, _program: &str, args: &[&str], stdin: &str) -> anyhow::Result<(bool, String)> {
            if args.first() == Some(&"-i") {
                if self.locked {
                    return Ok((false, String::new()));
                }
                let parts: Vec<&str> = stdin.split_whitespace().collect();
                let account = parts.iter().position(|p| *p == "-a").map(|i| parts[i + 1].to_string());
                let hex = parts.iter().position(|p| *p == "-w").map(|i| parts[i + 1].to_string());
                if let (Some(a), Some(h)) = (account, hex) {
                    self.items.lock().unwrap().insert(a, h);
                }
                return Ok((true, String::new()));
            }
            let account = args.iter().position(|p| *p == "-a").map(|i| args[i + 1]).unwrap_or_default();
            Ok(match self.items.lock().unwrap().get(account) {
                Some(h) => (true, format!("{h}\n")),
                None => (false, String::new()),
            })
        }
    }

    /// A Mac-shaped env in a temp dir, with the given `.env` text (None = no file).
    pub fn mac_env(dir: &Path, env_text: Option<&str>) -> CardEnv {
        let env_file = dir.join(".env");
        if let Some(t) = env_text {
            std::fs::write(&env_file, t).unwrap();
        }
        CardEnv {
            store_path: dir.join("broker-secrets.json"),
            env_file: Some(env_file),
            backend: Backend::Keychain,
            runner: Box::new(FakeKeychain::default()),
            policy_path: dir.join("broker-policy.json"),
            audit_path: dir.join("broker-audit.jsonl"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    const ENV: &str = "SHORTCUT_API_TOKEN=canary-sc-1\nTRELLO_KEY=canary-trkey-2\nTRELLO_TOKEN=canary-trtok-3\nFIGMA_TOKEN=canary-fig-4\nHUBSTAFF_REFRESH_TOKEN=canary-hs-5\nUNRELATED=keep\n";

    fn status_of(rows: &[ImportRow], name: &str) -> ImportStatus {
        rows.iter().find(|r| r.name == name).unwrap().status
    }

    #[test]
    fn the_plan_lists_every_key_and_says_which_are_missing_without_a_value() {
        let dir = tempfile::tempdir().unwrap();
        let env = mac_env(dir.path(), Some(ENV));
        let rows = plan_import(&env).unwrap();
        assert_eq!(rows.len(), api_keys::REGISTRY.len(), "every registry key has a row, found or not");
        assert_eq!(status_of(&rows, "SHORTCUT_API_TOKEN"), ImportStatus::Copy);
        assert_eq!(status_of(&rows, "LINEAR_API_KEY"), ImportStatus::Missing);
        assert_eq!(status_of(&rows, "CLOCKIFY_API_KEY"), ImportStatus::Missing);
        // A Mac cannot hold the rotating token, even though .env has it.
        assert_eq!(status_of(&rows, PC_ONLY_KEY), ImportStatus::PcOnly);
        let shown = serde_json::to_string(&rows).unwrap();
        for v in ["canary-sc-1", "canary-trkey-2", "canary-trtok-3", "canary-fig-4", "canary-hs-5"] {
            assert!(!shown.contains(v), "the plan must not carry a value: {shown}");
        }
    }

    #[test]
    fn trello_key_is_found_under_its_env_name_and_stored_under_the_registry_name() {
        let dir = tempfile::tempdir().unwrap();
        let env = mac_env(dir.path(), Some(ENV));
        let rows = plan_import(&env).unwrap();
        let tr = rows.iter().find(|r| r.name == "TRELLO_API_KEY").unwrap();
        assert_eq!((tr.status, tr.from), (ImportStatus::Copy, Some("TRELLO_KEY")));
        let report = apply_import(&env, &rows);
        assert!(report.stored.contains(&"TRELLO_API_KEY"), "{report:?}");
        let got = api_keys::resolve_secret(&env.store_path, None, env.backend, &*env.runner, "TRELLO_API_KEY").unwrap().unwrap();
        assert_eq!(got.0, "canary-trkey-2");
    }

    #[test]
    fn apply_copies_only_the_listed_copy_rows_leaves_env_alone_and_never_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let env = mac_env(dir.path(), Some(ENV));
        // The store already holds Figma: import keeps it.
        api_keys::set_broker_secret(&env.store_path, env.backend, &*env.runner, "FIGMA_TOKEN", "canary-existing-fig").unwrap();
        let rows = plan_import(&env).unwrap();
        assert_eq!(status_of(&rows, "FIGMA_TOKEN"), ImportStatus::Kept);
        let report = apply_import(&env, &rows);
        assert_eq!(report.stored, ["SHORTCUT_API_TOKEN", "TRELLO_API_KEY", "TRELLO_TOKEN"]);
        assert!(report.failed.is_empty(), "{report:?}");
        let fig = api_keys::resolve_secret(&env.store_path, None, env.backend, &*env.runner, "FIGMA_TOKEN").unwrap().unwrap();
        assert_eq!(fig.0, "canary-existing-fig", "an existing entry is never replaced by import");
        assert!(!api_keys::broker_has(&env.store_path, PC_ONLY_KEY), "the Mac never takes the rotating token");
        assert_eq!(std::fs::read_to_string(env.env_file.as_ref().unwrap()).unwrap(), ENV, ".env is not touched");
        let on_disk = std::fs::read_to_string(&env.store_path).unwrap();
        for v in ["canary-sc-1", "canary-trkey-2", "canary-trtok-3"] {
            assert!(!on_disk.contains(v), "the store file holds no plaintext");
        }
    }

    #[test]
    fn a_row_that_changed_while_the_card_was_open_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let env = mac_env(dir.path(), Some(ENV));
        let shown = plan_import(&env).unwrap();
        // Between the card and the click: Figma is removed from .env and Shortcut gets stored by hand.
        std::fs::write(env.env_file.as_ref().unwrap(), ENV.replace("FIGMA_TOKEN=canary-fig-4\n", "")).unwrap();
        api_keys::set_broker_secret(&env.store_path, env.backend, &*env.runner, "SHORTCUT_API_TOKEN", "canary-hand").unwrap();
        let report = apply_import(&env, &shown);
        assert!(report.failed.iter().any(|(n, _)| *n == "FIGMA_TOKEN"), "{report:?}");
        assert!(report.failed.iter().any(|(n, _)| *n == "SHORTCUT_API_TOKEN"), "{report:?}");
        assert!(!report.stored.contains(&"FIGMA_TOKEN") && !report.stored.contains(&"SHORTCUT_API_TOKEN"));
        let sc = api_keys::resolve_secret(&env.store_path, None, env.backend, &*env.runner, "SHORTCUT_API_TOKEN").unwrap().unwrap();
        assert_eq!(sc.0, "canary-hand");
    }

    #[test]
    fn a_missing_env_file_plans_every_key_as_missing_and_a_locked_keychain_fails_each_row_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = mac_env(dir.path(), None);
        env.env_file = Some(dir.path().join("absent.env"));
        let rows = plan_import(&env).unwrap();
        assert!(rows.iter().all(|r| matches!(r.status, ImportStatus::Missing | ImportStatus::PcOnly)), "{rows:?}");

        let mut env = mac_env(dir.path(), Some(ENV));
        env.runner = Box::new(FakeKeychain { locked: true, ..Default::default() });
        let rows = plan_import(&env).unwrap();
        let report = apply_import(&env, &rows);
        assert!(report.stored.is_empty(), "{report:?}");
        assert!(report.failed.iter().any(|(n, e)| *n == "SHORTCUT_API_TOKEN" && e.contains("Keychain")), "{report:?}");
        assert!(report.failed.iter().all(|(_, e)| !e.contains("canary")), "no error carries a value");
        assert!(!env.store_path.exists(), "a refused write creates no store");
    }

    #[test]
    fn a_machine_without_a_protected_store_plans_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = mac_env(dir.path(), Some(ENV));
        env.backend = Backend::Unavailable;
        assert!(plan_import(&env).unwrap_err().contains("never kept as plaintext"));
        assert!(replace_secret(&env, "FIGMA_TOKEN", "canary-x").is_err());
        assert!(!env.store_path.exists());
    }

    #[test]
    fn replace_stores_trims_and_overwrites_and_refuses_the_bad_cases() {
        let dir = tempfile::tempdir().unwrap();
        let env = mac_env(dir.path(), None);
        assert!(!is_stored(&env, "FIGMA_TOKEN"));
        replace_secret(&env, "FIGMA_TOKEN", "  canary-one \r\n").unwrap();
        assert!(is_stored(&env, "FIGMA_TOKEN"));
        replace_secret(&env, "FIGMA_TOKEN", "canary-two").unwrap();
        let got = api_keys::resolve_secret(&env.store_path, None, env.backend, &*env.runner, "FIGMA_TOKEN").unwrap().unwrap();
        assert_eq!(got.0, "canary-two");
        assert_eq!(replace_secret(&env, "FIGMA_TOKEN", "  \n").unwrap_err(), "the field is empty");
        assert!(replace_secret(&env, "FIGMA_TOKEN", "a\nb").is_err(), "a newline inside is refused");
        assert!(replace_secret(&env, "NOT_A_KEY", "canary-x").unwrap_err().contains("not a key the broker knows"));
        // Hubstaff on a Mac says so and stores nothing.
        let err = replace_secret(&env, PC_ONLY_KEY, "canary-hs").unwrap_err();
        assert!(err.contains("PC only"), "{err}");
        assert!(!is_stored(&env, PC_ONLY_KEY));
        let got = api_keys::resolve_secret(&env.store_path, None, env.backend, &*env.runner, "FIGMA_TOKEN").unwrap().unwrap();
        assert_eq!(got.0, "canary-two", "a refused paste leaves the earlier token");
    }

    fn proposal(service: Service, method: &str, path: &str, op: Option<&str>) -> PolicyProposal {
        PolicyProposal { service, method: method.into(), path: path.into(), op: op.map(str::to_string) }
    }

    #[test]
    fn a_proposal_becomes_the_exact_row_the_denial_prints_and_that_row_allows_the_call() {
        let row = propose_row(&proposal(Service::Shortcut, "PUT", "/api/v3/stories/12345", None)).unwrap();
        assert_eq!(row.service, "shortcut");
        assert_eq!(row.method.as_deref(), Some("PUT"));
        assert!(row.path.as_deref().unwrap().contains(r"\d+"), "an id becomes a class: {row:?}");
        assert!(row.require_owner, "a story write asks for the owner");
        let line = row_line(&row);
        assert!(line.contains(r#""service":"shortcut""#) && !line.contains("12345"), "{line}");

        let linear = propose_row(&proposal(Service::Linear, "POST", "/graphql", Some("commentCreate"))).unwrap();
        assert_eq!((linear.op.as_deref(), linear.require_owner), (Some("commentCreate"), true));
    }

    #[test]
    fn a_proposal_no_row_can_allow_is_refused_before_a_card_is_raised() {
        // A read is open already.
        assert!(propose_row(&proposal(Service::Figma, "GET", "/v1/me", None)).unwrap_err().contains("already open"));
        // Linear is pinned to three operations.
        assert!(propose_row(&proposal(Service::Linear, "POST", "/graphql", Some("issueDelete"))).is_err());
        assert!(propose_row(&proposal(Service::Linear, "POST", "/graphql", None)).is_err());
        // The guards' path rules hold here too: a host, a traversal, a credential query.
        assert!(propose_row(&proposal(Service::Shortcut, "POST", "https://evil.example/api/v3/x", None)).is_err());
        assert!(propose_row(&proposal(Service::Shortcut, "POST", "/api/v3/../admin", None)).is_err());
        assert!(propose_row(&proposal(Service::Shortcut, "POST", "/api/v3/stories?token=abc", None)).is_err());
        assert!(propose_row(&proposal(Service::Shortcut, "TRACE", "/api/v3/stories", None)).is_err());
    }

    #[test]
    fn applying_a_row_appends_it_once_through_the_one_write_function() {
        let dir = tempfile::tempdir().unwrap();
        let env = mac_env(dir.path(), None);
        let row = propose_row(&proposal(Service::Figma, "POST", "/v1/files/abc123def456/comments", None)).unwrap();
        let before = policy_file::load_effective(&env.policy_path).unwrap().rows.len();
        assert_eq!(apply_policy_row(&env, row.clone()), Ok(true));
        assert_eq!(apply_policy_row(&env, row.clone()), Ok(false), "the same row twice is one row");
        let file = policy_file::load_effective(&env.policy_path).unwrap();
        assert_eq!(file.rows.len(), before + 1);
        assert!(file.rows.contains(&row));
        // The hot-reloading policy allows the call now.
        let p = policy_file::FilePolicy::at(env.policy_path.clone());
        let d = super::super::policy::Policy::decide(
            &p,
            &PolicyRequest { session: "s", service: Service::Figma, method: Method::Post, path: "/v1/files/zzz999yyy888/comments", query: None, read: false, linear_op: None },
        );
        assert!(matches!(d, super::super::policy::PolicyDecision::Allow { .. }), "{d:?}");
    }

    #[test]
    fn a_malformed_policy_file_is_never_overwritten_by_a_card() {
        let dir = tempfile::tempdir().unwrap();
        let env = mac_env(dir.path(), None);
        std::fs::write(&env.policy_path, "{ not json").unwrap();
        let row = propose_row(&proposal(Service::Figma, "POST", "/v1/files/abc123def456/comments", None)).unwrap();
        assert!(apply_policy_row(&env, row).is_err());
        assert_eq!(std::fs::read_to_string(&env.policy_path).unwrap(), "{ not json");
    }

    #[test]
    fn an_audit_line_names_the_card_and_the_keys_and_holds_no_value() {
        let dir = tempfile::tempdir().unwrap();
        let env = mac_env(dir.path(), Some(ENV));
        audit_card(&env, "chat-1", "figma", "replace", "card_applied", "stored FIGMA_TOKEN on this Mac".into());
        let line: serde_json::Value = serde_json::from_str(std::fs::read_to_string(&env.audit_path).unwrap().trim()).unwrap();
        assert_eq!((line["method"].as_str(), line["path"].as_str(), line["outcome"].as_str()), (Some("CARD"), Some("replace"), Some("card_applied")));
        assert_eq!(line["session"], "chat-1");
    }
}
