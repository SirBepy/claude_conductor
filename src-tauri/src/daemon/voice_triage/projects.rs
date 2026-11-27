//! The projects a voice note may file a todo into: the folders Conductor already
//! knows (`Settings.projects`), joined to the vault's client notes whose `repos:`
//! list names them (the same match the people system uses, `people::client_for`).

use std::path::{Path, PathBuf};

use crate::people::{client_for, Client};
use crate::types::ProjectConfig;

#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    /// The project folder's name, lowercased: what the model answers with. Unique
    /// in a list (`-2`, `-3` for a second folder of the same name).
    pub key: String,
    /// The name Conductor shows for the project.
    pub name: String,
    pub path: PathBuf,
    /// The client note naming this project in its `repos:`, and every repo it names.
    pub client: Option<String>,
    pub client_repos: Vec<String>,
}

fn folder_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Projects that exist on disk, minus scratch folders. A project with no folder
/// name (a drive root) cannot be keyed and is left out.
pub fn candidates(projects: &[ProjectConfig], clients: &[Client]) -> Vec<Candidate> {
    candidates_with(projects, clients, crate::settings::identity::is_ephemeral_root_path)
}

/// `candidates` with the scratch-folder rule injected: the real one treats
/// everything under the temp dir as scratch, which is where a test's folders live.
pub(super) fn candidates_with(projects: &[ProjectConfig], clients: &[Client], is_scratch: impl Fn(&Path) -> bool) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = Vec::new();
    for p in projects {
        if !p.path.is_dir() || is_scratch(&p.path) {
            continue;
        }
        let folder = folder_name(&p.path);
        if folder.is_empty() {
            continue;
        }
        let base = folder.to_lowercase();
        let mut key = base.clone();
        let mut n = 2;
        while out.iter().any(|c| c.key == key) {
            key = format!("{base}-{n}");
            n += 1;
        }
        let client = client_for(clients, &[p.name.as_str(), folder.as_str()]);
        out.push(Candidate {
            key,
            name: p.name.clone(),
            path: p.path.clone(),
            client: client.map(|c| c.name.clone()),
            client_repos: client.map(|c| c.repos.clone()).unwrap_or_default(),
        });
    }
    out
}
