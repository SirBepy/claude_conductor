//! Character bundles: icon + grouped sound slots assigned to projects.
//! Replaces the old SoundPack + per-event override system.

pub mod slots;
pub mod loader;
pub mod assets;
pub mod bundled;
pub mod cache;
pub mod assign;
pub mod whitelist;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::characters::slots::Slot;

#[derive(Serialize, Deserialize, Clone, Debug, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct Character {
    pub id: String,
    pub label: String,
    #[serde(default = "default_version")]
    pub version: u32,
    pub icon: String,
    /// Game slug from character.json (e.g. "warcraft3").
    #[serde(default)]
    pub game: Option<String>,
    /// Pretty game name from game.json, injected by the loader.
    #[serde(default)]
    pub game_label: Option<String>,
    /// True for _shared bundles — excluded from the UI list.
    #[serde(default)]
    #[ts(skip)]
    pub shared: bool,
    /// Absolute path to this character's on-disk directory, injected by the loader.
    /// Not serialized to/from JSON.
    #[serde(skip)]
    #[ts(skip)]
    pub dir: PathBuf,
    /// Slot key (lowercase snake_case) -> list of file paths relative to character dir.
    pub slots: HashMap<String, Vec<String>>,
}

// Manual PartialEq that ignores the runtime-only `dir` field so JSON round-trip
// tests comparing two deserialized structs still pass.
impl PartialEq for Character {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
            && self.label == other.label
            && self.version == other.version
            && self.icon == other.icon
            && self.game == other.game
            && self.game_label == other.game_label
            && self.shared == other.shared
            && self.slots == other.slots
    }
}

fn default_version() -> u32 { 1 }

impl Character {
    /// Returns sound files for the named slot, or empty slice when missing.
    pub fn slot_files(&self, slot: Slot) -> &[String] {
        self.slots.get(slot.key()).map(|v| v.as_slice()).unwrap_or(&[])
    }

    /// Resolves an asset path relative to this character's on-disk directory.
    pub fn asset_path(&self, relative: &str) -> PathBuf {
        self.dir.join(relative)
    }

    /// Same as `asset_path`, but canonicalizes both the character's own dir
    /// and the joined target and rejects escape via `..`/symlinks - `relative`
    /// is client-supplied over the `character_asset_url` remote RPC.
    pub fn asset_path_checked(&self, relative: &str) -> Option<PathBuf> {
        let root = self.dir.canonicalize().ok()?;
        let target = self.dir.join(relative).canonicalize().ok()?;
        target.starts_with(&root).then_some(target)
    }
}

#[cfg(test)]
mod char_tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Character {
        let mut slots = HashMap::new();
        slots.insert("work_finished".into(), vec!["sounds/done.wav".into()]);
        slots.insert("question_asked".into(), vec!["sounds/yes.wav".into(), "sounds/what.wav".into()]);
        Character {
            id: "peon".into(),
            label: "Peon (Orc)".into(),
            version: 1,
            icon: "icon.png".into(),
            game: None,
            game_label: None,
            shared: false,
            dir: PathBuf::new(),
            slots,
        }
    }

    #[test]
    fn character_round_trips_json() {
        let c = sample();
        let raw = serde_json::to_string(&c).unwrap();
        let back: Character = serde_json::from_str(&raw).unwrap();
        assert_eq!(c, back);
    }

    #[test]
    fn slot_files_returns_empty_for_missing_slot() {
        let c = sample();
        assert!(c.slot_files(Slot::Death).is_empty());
        assert!(c.slot_files(Slot::Ready).is_empty());
    }

    #[test]
    fn slot_files_returns_files_for_present_slot() {
        let c = sample();
        assert_eq!(c.slot_files(Slot::WorkFinished), &["sounds/done.wav".to_string()]);
        assert_eq!(c.slot_files(Slot::QuestionAsked).len(), 2);
    }

    #[test]
    fn version_defaults_to_one_when_absent() {
        let raw = json!({
            "id": "x", "label": "X", "icon": "icon.png", "slots": {}
        }).to_string();
        let c: Character = serde_json::from_str(&raw).unwrap();
        assert_eq!(c.version, 1);
    }

    #[test]
    fn asset_path_uses_dir_field() {
        let mut c = sample();
        c.dir = std::path::PathBuf::from("/tmp/chars/warcraft/peon");
        assert_eq!(c.asset_path("icon.png"), std::path::PathBuf::from("/tmp/chars/warcraft/peon/icon.png"));
    }

    // Todo 656: `file` in `character_asset_url` is client-supplied over RPC;
    // a traversing `relative` must not escape the character's own dir.
    #[test]
    fn asset_path_checked_rejects_traversal_outside_character_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let char_dir = tmp.path().join("peon");
        std::fs::create_dir_all(&char_dir).unwrap();
        std::fs::write(char_dir.join("icon.png"), b"x").unwrap();
        let secret = tmp.path().join("secret.txt");
        std::fs::write(&secret, b"leak").unwrap();

        let mut c = sample();
        c.dir = char_dir.clone();
        assert_eq!(c.asset_path_checked("icon.png"), Some(char_dir.canonicalize().unwrap().join("icon.png")));
        assert!(c.asset_path_checked("../secret.txt").is_none());
        assert!(c.asset_path_checked("missing.png").is_none());
    }
}

/// Load all characters from the standard app-data dir. Routed through the
/// in-memory cache so notification dispatch doesn't re-scan disk per fire.
/// Frontend invalidates via the `invalidate_characters_cache` IPC.
pub fn list() -> Vec<Character> {
    cache::cached_list()
}

pub fn get(id: &str) -> Option<Character> {
    list().into_iter().find(|c| c.id == id)
}
