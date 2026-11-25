//! The per-account "Show plan usage" switch. A fetcher whose route is not in
//! the provider's published docs (`Fetcher::needs_opt_in`, today Kimi Code) makes
//! no call until Joe turns it on for that account; DeepSeek and OpenRouter
//! (documented routes) are always on and have no switch.
//!
//! Persisted because the switch is Joe's consent to a call the provider does not
//! document: it must survive a daemon restart or the first poll after one would
//! silently go back to "off" (or, worse, a default of "on" would call without
//! asking). The file holds only `{ "<account id>": true|false }`.

use std::collections::HashMap;
use std::path::PathBuf;

const FILE_NAME: &str = "provider-usage-switches.json";

#[derive(Default)]
pub(super) struct Switches {
    /// `None` until `load`: tests and any caller that never loads keep the
    /// switches in memory only.
    path: Option<PathBuf>,
    map: HashMap<String, bool>,
}

impl Switches {
    /// Reads the file under the data dir. A missing file is "all off"; one that
    /// does not parse is set aside as `.bad` and read as "all off" too, never
    /// as "all on".
    pub(super) fn load(&mut self) {
        let Ok(dir) = crate::settings::paths::data_dir() else { return };
        self.load_from(dir.join(FILE_NAME));
    }

    pub(super) fn load_from(&mut self, path: PathBuf) {
        self.map = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| {
                let _ = std::fs::rename(&path, path.with_extension("json.bad"));
                HashMap::new()
            }),
            Err(_) => HashMap::new(),
        };
        self.path = Some(path);
    }

    pub(super) fn is_on(&self, account_id: &str) -> bool {
        self.map.get(account_id).copied().unwrap_or(false)
    }

    /// Every account that has an explicit answer, for the view.
    pub(super) fn snapshot(&self) -> HashMap<String, bool> {
        self.map.clone()
    }

    /// Records the answer and writes it out. A write that fails takes an "on" back
    /// (the caller reports the failure and the page puts the switch back to off, so
    /// the daemon must not keep calling the provider); an "off" stays off in memory,
    /// since stopping is the safe side of a failure, though the file may still say
    /// "on" until the next successful save.
    pub(super) fn set(&mut self, account_id: &str, on: bool) -> Result<(), String> {
        let before = self.map.insert(account_id.to_string(), on);
        let saved = self.write();
        if saved.is_err() && on {
            match before {
                Some(prev) => self.map.insert(account_id.to_string(), prev),
                None => self.map.remove(account_id),
            };
        }
        saved
    }

    // Entries of a deleted account stay: ids are UUIDs and never reused, and a
    // pruning pass would wipe every answer whenever the registry read fails.

    fn write(&self) -> Result<(), String> {
        let Some(path) = &self.path else { return Ok(()) };
        let text = serde_json::to_string_pretty(&self.map).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text).map_err(|e| format!("could not save the switch: {e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("could not save the switch: {e}"))
    }
}

#[cfg(test)]
mod tests;
