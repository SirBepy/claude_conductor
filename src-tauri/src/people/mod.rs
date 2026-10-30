//! The user's people, read from the `People/` folder of their Obsidian vault.
//! One `.md` file per person, frontmatter per the vault's own
//! `Templates/Person.md` (`name`, `aliases`, `relationship`). The vault is the
//! single source of truth: the app never keeps its own copy of the list, so a
//! person added or renamed in Obsidian shows up on the next read.
//!
//! A person's identity is the file stem, because that is what Obsidian links
//! by (`[[Bruno Kecman]]`); `name` is only a display override and the
//! template ships it empty.
//!
//! A client (Zirtue, Revaire) is any note at the vault root whose frontmatter
//! lists `repos:`; its slug is the lowercased note name. A person's
//! `projects: [zirtue]` ties them to clients, and `project_aliases:
//! ["zirtue: backend"]` holds names used for them inside one client only.

mod frontmatter;
mod resolve;
#[cfg(test)]
mod test_support;
mod vault;
pub mod vault_detector;
mod write;

pub use resolve::{resolve, resolve_in, similar, Resolved};
pub use vault::{client_for, clients_at, vault_dir};
pub use write::{add_to_list_at, create_at, NewPerson};

use frontmatter::Frontmatter;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use ts_rs::TS;

const PEOPLE_DIR: &str = "People";
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct Person {
    /// File stem under `People/`. The stable key drafts store.
    pub id: String,
    /// Frontmatter `name`, or the stem when that is empty.
    pub name: String,
    pub aliases: Vec<String>,
    pub relationship: String,
    #[serde(default)]
    pub gender: String,
    #[serde(default)]
    pub language: String,
    /// Where the user writes to them: Slack, Shortcut, Google Chat...
    #[serde(default)]
    pub messaged_on: Vec<String>,
    /// Client slugs they belong to. Empty means not tied to one client (a
    /// friend, an agency contact), so they count as known everywhere.
    #[serde(default)]
    pub projects: Vec<String>,
    /// `"zirtue: backend"`: a name for them inside that client only.
    #[serde(default)]
    pub project_aliases: Vec<String>,
}

impl Person {
    /// Their names that only apply inside `client`, e.g. "backend".
    pub fn aliases_in<'a>(&'a self, client: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.project_aliases.iter().filter_map(move |entry| {
            let (slug, name) = entry.split_once(':')?;
            (slug.trim().eq_ignore_ascii_case(client)).then(|| name.trim())
        })
    }

    pub fn belongs_to(&self, client: &str) -> bool {
        self.projects.iter().any(|p| p.trim().eq_ignore_ascii_case(client))
    }
}

/// A client note: `Zirtue.md` with `repos: [zng-app, ...]`.
#[derive(Clone, Debug, PartialEq)]
pub struct Client {
    /// Lowercased note name, the key `projects`/`project_aliases` use.
    pub slug: String,
    pub name: String,
    pub repos: Vec<String>,
}

/// Everyone under `<vault>/People/`, sorted by id. Unreadable files are
/// skipped, never an error: a half-synced vault must not break drafting.
pub fn list_at(vault: &Path) -> Vec<Person> {
    let Ok(entries) = fs::read_dir(vault.join(PEOPLE_DIR)) else { return Vec::new() };
    let mut people: Vec<Person> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("md") {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_string();
            let text = fs::read_to_string(&path).unwrap_or_default();
            Some(person_from(id, &text))
        })
        .collect();
    people.sort_by(|a, b| a.id.cmp(&b.id));
    people
}

fn person_from(id: String, text: &str) -> Person {
    let fm = Frontmatter::parse(text);
    let name = fm.scalar("name");
    Person {
        name: if name.is_empty() { id.clone() } else { name },
        id,
        aliases: fm.list("aliases"),
        relationship: fm.scalar("relationship"),
        gender: fm.scalar("gender"),
        language: fm.scalar("language"),
        messaged_on: fm.list("messaged_on"),
        projects: fm.list("projects"),
        project_aliases: fm.list("project_aliases"),
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{vault_with, STEVAN};
    use super::*;

    #[test]
    fn a_person_reads_the_questionnaire_fields() {
        let p = person_from("Stevan".into(), STEVAN);
        assert_eq!(p.gender, "male");
        assert_eq!(p.language, "Croatian in DMs, English on Shortcut");
        assert_eq!(p.messaged_on, vec!["Slack", "Shortcut"]);
        assert_eq!(p.projects, vec!["zirtue"]);
        assert!(p.belongs_to("Zirtue"));
        assert_eq!(p.aliases_in("zirtue").collect::<Vec<_>>(), vec!["backend"]);
        assert_eq!(p.aliases_in("revaire").count(), 0);
    }

    #[test]
    fn an_empty_template_name_falls_back_to_the_file_stem() {
        let vault = vault_with(&[("Lenar Rakhmatulin", "---\nname: \"\"\naliases: []\n---\n")]);
        let people = list_at(vault.path());
        assert_eq!(people.len(), 1);
        assert_eq!(people[0].id, "Lenar Rakhmatulin");
        assert_eq!(people[0].name, "Lenar Rakhmatulin");
    }
}
