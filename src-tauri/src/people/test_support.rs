//! Fixtures shared by the sibling modules' tests.

use super::{Person, PEOPLE_DIR};
use std::fs;

pub(super) fn person(id: &str, aliases: &[&str]) -> Person {
    Person { id: id.into(), name: id.into(), aliases: aliases.iter().map(|a| a.to_string()).collect(), ..Default::default() }
}

pub(super) fn vault_with(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(PEOPLE_DIR)).unwrap();
    for (name, body) in files {
        fs::write(dir.path().join(PEOPLE_DIR).join(format!("{name}.md")), body).unwrap();
    }
    dir
}

pub(super) const STEVAN: &str = "---\nname: \"Stevan\"\naliases: []\nrelationship: \"coworker (Zirtue backend dev)\"\ngender: male\nlanguage: Croatian in DMs, English on Shortcut\nmessaged_on: [Slack, Shortcut]\nprojects: [zirtue]\nproject_aliases: [\"zirtue: backend\"]\ntags: [person, work]\n---\n\n# Stevan\n";
