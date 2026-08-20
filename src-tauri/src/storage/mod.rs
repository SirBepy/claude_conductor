//! Consolidated SQLite store for usage snapshots, token records, and skill
//! events. Self-contained module; not yet wired into `AppState`, the
//! scheduler, or IPC (that lands in a later slice).
//!
//! All three datasets share one shape (`id`, unix-second `timestamp`, JSON
//! `data` blob), which makes retention a single query per table and lets the
//! existing Rust structs persist unchanged via serde.

pub mod db;
pub mod migration;
pub mod retention;
pub mod skill_store;
pub mod skipped_question_store;
pub mod token_store;
pub mod usage_store;

pub use retention::{
    clear_dataset, dataset_stats, prune_all, prune_one, Dataset, DatasetStats, RetentionPolicies,
    RetentionPolicy,
};

use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;

/// Owns the live SQLite connection. In `AppState` this will sit behind a
/// `Mutex`; here it is a plain wrapper so the store functions (all of which
/// take `&Connection`) can borrow it.
pub struct StorageManager {
    conn: Connection,
}

impl StorageManager {
    /// Opens (creating if absent) the database at `path`, runs schema init and
    /// any pending migrations, and returns the manager. The parent directory
    /// must already exist (use `settings::paths::ensure_data_dir` first).
    pub fn open(path: &Path) -> Result<Self> {
        let conn = db::open_db(path)?;
        db::run_migrations(&conn)?;
        Ok(Self { conn })
    }

    /// Borrows the underlying connection for store/retention calls.
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Prunes every dataset per the supplied policies. Returns rows deleted.
    pub fn prune(&self, policies: &RetentionPolicies) -> Result<usize> {
        prune_all(&self.conn, policies)
    }
}
