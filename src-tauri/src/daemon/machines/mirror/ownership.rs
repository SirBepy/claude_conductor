//! Last-known `machine_id -> hosted session ids`, kept on disk. The mirror's
//! row cache is memory only, so right after a daemon restart (before a peer's
//! link reconnects) a mirrored chat's id resolves to nobody and a send falls
//! through to the LOCAL handler, which then tries to resume a chat whose
//! transcript and folder live on the peer. This record is what keeps such a
//! send routed at the peer (and failing "offline" until its link is up).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Default)]
pub(super) struct Ownership {
    /// `None` until `load`: a bare `MirrorState` (tests, a daemon before
    /// `init_machines`) records in memory only.
    path: Option<PathBuf>,
    hosted: HashMap<String, HashSet<String>>,
}

#[derive(Serialize, Deserialize, Default)]
pub(super) struct OwnershipFile {
    #[serde(default)]
    pub(super) hosted: HashMap<String, Vec<String>>,
}

pub(super) fn ownership_path(app_data: &Path) -> PathBuf {
    let suffix = crate::daemon::instance::instance_suffix();
    app_data.join(format!("mirror-owners{suffix}.json"))
}

impl Ownership {
    /// The record persisted under `app_data`, persisting future changes there.
    /// Entries for a machine `is_paired` rejects (unpaired while the daemon was
    /// down) are dropped, and each machine keeps at most `cap` ids.
    pub(super) fn load(app_data: &Path, is_paired: impl Fn(&str) -> bool, cap: usize) -> Self {
        let path = ownership_path(app_data);
        let file: OwnershipFile = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let hosted = file
            .hosted
            .into_iter()
            .filter(|(machine, _)| is_paired(machine))
            .map(|(machine, ids)| (machine, ids.into_iter().take(cap).collect()))
            .collect();
        Self { path: Some(path), hosted }
    }

    pub(super) fn owner_of(&self, session_id: &str) -> Option<String> {
        self.hosted.iter().find(|(_, ids)| ids.contains(session_id)).map(|(machine, _)| machine.clone())
    }

    /// Replaces `machine_id`'s hosted set, writing only on a real change.
    pub(super) fn record(&mut self, machine_id: &str, ids: HashSet<String>) {
        if self.hosted.get(machine_id) == Some(&ids) {
            return;
        }
        self.hosted.insert(machine_id.to_string(), ids);
        self.persist();
    }

    pub(super) fn forget(&mut self, machine_id: &str) {
        if self.hosted.remove(machine_id).is_some() {
            self.persist();
        }
    }

    fn persist(&self) {
        let Some(path) = &self.path else { return };
        let file = OwnershipFile {
            hosted: self
                .hosted
                .iter()
                .map(|(machine, ids)| {
                    let mut ids: Vec<String> = ids.iter().cloned().collect();
                    ids.sort();
                    (machine.clone(), ids)
                })
                .collect(),
        };
        let Ok(body) = serde_json::to_string(&file) else { return };
        if let Err(e) = crate::util::write_json_atomic(path, &body) {
            log::warn!("mirror: failed to persist session ownership: {e}");
        }
    }
}
