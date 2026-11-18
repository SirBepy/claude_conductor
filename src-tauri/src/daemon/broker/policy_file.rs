//! `<data_dir>/broker-policy.json`: loading it, reloading it when it changes, and
//! the one function that writes it.
//!
//! - **No file means the seed.** The checked-in `broker-policy-seed.json` (produced
//!   by `scripts/broker-seed-scan.mjs`) is the policy until a file exists. Once a
//!   file exists it is the whole policy, so a row can be removed as well as added.
//! - **Hot reload.** `FilePolicy` reads the file at the start of every decision and
//!   recompiles only when the bytes differ from what it last saw. A file that does
//!   not parse or compile keeps the last good policy, says so in every denial, and
//!   is retried when it changes again. A policy file that is missing at startup
//!   starts from the seed; one that is malformed at startup also starts from the
//!   seed (the narrow default), never from "allow everything".
//! - **Writes.** `write_policy` and `add_row` are the only writers. The engine and
//!   the policy never call them; the policy card (step 7) does. A write validates
//!   first, goes through a temp file and a rename, and refuses to touch a file that
//!   is already malformed (it would destroy rows Joe can still fix by hand).

use super::policy::{Policy, PolicyDecision, PolicyRequest};
use super::policy_rules::{PolicyFile, PolicyRow, Rules};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const POLICY_FILE: &str = "broker-policy.json";
const SEED_JSON: &str = include_str!("broker-policy-seed.json");

pub fn policy_path(data_dir: &Path) -> PathBuf {
    data_dir.join(POLICY_FILE)
}

/// The checked-in seed. Panics only if the file in the repo is bad, which a test
/// proves it is not.
pub fn seed() -> PolicyFile {
    serde_json::from_str(SEED_JSON).expect("broker-policy-seed.json is valid; a test checks it")
}

struct State {
    rules: Arc<Rules>,
    /// The bytes `rules` came from or the last bytes that failed; `None` = no file.
    seen: Option<Option<Vec<u8>>>,
    /// Why the file on disk is not what is applied.
    error: Option<String>,
}

pub struct FilePolicy {
    path: PathBuf,
    state: Mutex<State>,
}

impl FilePolicy {
    pub fn open(data_dir: &Path) -> Self {
        Self::at(policy_path(data_dir))
    }

    pub fn at(path: PathBuf) -> Self {
        let seed_rules = Rules::compile(&seed()).expect("the seed compiles; a test checks it");
        let p = Self { path, state: Mutex::new(State { rules: Arc::new(seed_rules), seen: None, error: None }) };
        p.refresh();
        p
    }

    /// Why the file on disk is not applied (it is malformed), if so.
    pub fn last_error(&self) -> Option<String> {
        self.refresh();
        self.state.lock().unwrap().error.clone()
    }

    /// Rows in force right now.
    pub fn row_count(&self) -> usize {
        self.refresh();
        self.state.lock().unwrap().rules.len()
    }

    fn refresh(&self) -> (Arc<Rules>, Option<String>) {
        let bytes = match std::fs::read(&self.path) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                let mut st = self.state.lock().unwrap();
                st.error = Some(format!("{POLICY_FILE} cannot be read: {e}"));
                return (st.rules.clone(), st.error.clone());
            }
        };
        let mut st = self.state.lock().unwrap();
        if st.seen.as_ref() == Some(&bytes) {
            return (st.rules.clone(), st.error.clone());
        }
        match &bytes {
            None => match Rules::compile(&seed()) {
                Ok(r) => {
                    st.rules = Arc::new(r);
                    st.error = None;
                }
                Err(e) => st.error = Some(e),
            },
            Some(b) => match parse(b) {
                Ok(r) => {
                    log::info!("[broker] policy loaded: {} rows", r.len());
                    st.rules = Arc::new(r);
                    st.error = None;
                }
                Err(e) => {
                    log::error!("[broker] {POLICY_FILE} not applied, keeping the last good policy: {e}");
                    st.error = Some(e);
                }
            },
        }
        st.seen = Some(bytes);
        (st.rules.clone(), st.error.clone())
    }
}

fn parse(bytes: &[u8]) -> Result<Rules, String> {
    let file: PolicyFile = serde_json::from_slice(bytes).map_err(|e| format!("{POLICY_FILE} is not valid: {e}"))?;
    Rules::compile(&file)
}

impl Policy for FilePolicy {
    fn decide(&self, req: &PolicyRequest<'_>) -> PolicyDecision {
        let (rules, error) = self.refresh();
        let decision = rules.evaluate(req).into_decision(POLICY_FILE);
        match (decision, error) {
            (PolicyDecision::Deny { reason, hint }, Some(e)) => PolicyDecision::Deny {
                reason: format!("{reason} (the policy file is not applied, so the last good policy is in force: {e})"),
                hint,
            },
            (d, _) => d,
        }
    }
}

// ---- writing: the policy card (step 7) calls these, nothing else does ------------------

/// One writer at a time within the process; a read-modify-write must not interleave.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// The policy as it would apply now: the file when there is one, else the seed.
/// A file that exists but is malformed is an error, never "empty".
pub fn load_effective(path: &Path) -> Result<PolicyFile, String> {
    match std::fs::read(path) {
        Ok(b) => {
            let file: PolicyFile = serde_json::from_slice(&b).map_err(|e| format!("{POLICY_FILE} is not valid: {e}"))?;
            Rules::compile(&file)?;
            Ok(file)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(seed()),
        Err(e) => Err(format!("{POLICY_FILE} cannot be read: {e}")),
    }
}

/// Replaces the whole file. Refuses a file that would not compile.
pub fn write_policy(path: &Path, file: &PolicyFile) -> Result<(), String> {
    let _g = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    write_locked(path, file)
}

/// Appends `row` to the effective policy (writing the seed plus the row when no
/// file exists yet). `Ok(false)` when an identical row is already there.
pub fn add_row(path: &Path, row: PolicyRow) -> Result<bool, String> {
    let _g = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = load_effective(path)?;
    if file.rows.iter().any(|r| same_row(r, &row)) {
        return Ok(false);
    }
    file.rows.push(row);
    write_locked(path, &file)?;
    Ok(true)
}

/// Rows equal in what they allow; the note is for Joe and does not count.
fn same_row(a: &PolicyRow, b: &PolicyRow) -> bool {
    let key = |r: &PolicyRow| {
        (r.service.to_ascii_lowercase(), r.method.as_ref().map(|m| m.to_ascii_uppercase()), r.path.clone(), r.op.clone(), r.require_owner)
    };
    key(a) == key(b)
}

fn write_locked(path: &Path, file: &PolicyFile) -> Result<(), String> {
    Rules::compile(file)?;
    let out = PolicyFile { version: 1, rows: file.rows.clone() };
    let text = serde_json::to_string_pretty(&out).map_err(|e| e.to_string())? + "\n";
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}
