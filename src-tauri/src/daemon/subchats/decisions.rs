//! The decisions log: one markdown file per main chat that records what was
//! decided and what was ruled out (spec section 10). It is for AI to read.
//!
//! The whole design rests on one property: only code writes it. No chat carries
//! it in context, so nothing can misremember a card answer. Three writers feed it:
//! - a card answer, recorded word for word with its question when Joe submits it
//!   ([`record_card_answer`]), with no model involved;
//! - a sub's `decided` / `ruled_out` rows at finish ([`record_finish_in`]);
//! - nothing else. The log holds decisions only, never state like "unpushed":
//!   the daemon reads state from git, and on the zng day a state line was the
//!   kind that went stale within hours.
//!
//! File: `<data_dir>/subchats/<parent_id>.decisions.md`. Entries get stable ids
//! (`D1`, `D2`, ...) so a later entry can name what it replaces. A replaced entry
//! is CLOSED, never deleted: it stays in the file marked `Closed by:` and is not
//! injected into subs.
//!
//! Every write rereads the file and replaces it whole through a temp file and a
//! rename, under one process-wide lock. A crash mid-write leaves the previous
//! file intact, and two writers cannot interleave. Appending in place was
//! rejected because closing an entry has to edit an earlier one.
//!
//! Every field line is followed only by two-space-indented continuation lines,
//! so a card answer that itself contains `## D9 - ...` can never forge a heading.

use super::finish::FinishRecord;
use crate::daemon::state::DaemonState;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

mod format;
mod store;
mod write;
mod digest;
pub use format::*;
pub use store::*;
pub use write::*;
pub use digest::*;

/// Budget for the entry lines a new or continued sub is shown. The header and
/// the footer (the cut count and the file path) come on top. Kept short on
/// purpose: a study of repo context files found they did not generally help and
/// added over 20% cost (`arxiv.org/abs/2602.11988`, which studied AGENTS.md, not
/// decision logs).
pub const INJECT_CAP: usize = 1500;
/// One entry never takes more than this much of [`INJECT_CAP`], so a long card
/// answer cannot crowd out every other decision.
const INJECT_ENTRY_CAP: usize = 300;
/// What a single stored field keeps. Joe's card answers are short; this only
/// stops a pasted wall of text from bloating a file every sub is pointed at.
const STORED_CAP: usize = 4000;

const FILE_HEADER: &str = "# Decisions log\n\nWritten by the Conductor daemon only. Do not edit. Entries are never deleted: one that a later entry replaces is marked `Closed by` and is no longer current. `card` entries are Joe's own answers to a question card, word for word. `finish` entries are what a sub reported when it finished.\n";

/// Serializes every read-modify-write of every log. Contention is a handful of
/// tiny files a few times an hour, so one lock beats one per file.
static LOG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Joe's answer to a question card.
    Card,
    /// A decision a sub reported at finish.
    Decided,
    /// An option a sub reported dropping at finish.
    RuledOut,
}

impl Kind {
    fn source(self) -> &'static str {
        match self {
            Kind::Card => "card",
            Kind::Decided | Kind::RuledOut => "finish",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Kind::Card => "Answer",
            Kind::Decided => "Decided",
            Kind::RuledOut => "Ruled out",
        }
    }

    fn word(self) -> &'static str {
        match self {
            Kind::Card => "Joe's answer",
            Kind::Decided => "decided",
            Kind::RuledOut => "ruled out",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: u32,
    pub kind: Kind,
    pub date: String,
    /// The sub's name, or `main chat`.
    pub who: String,
    /// The sub's session id, when a sub asked or wrote it. Names are chosen by the
    /// main chat and can repeat, so anything that must tell two subs apart (the one
    /// line back reporting a sub's answers) matches on this. `None` for an entry
    /// written before the id was recorded, and for the main chat's own.
    pub sub: Option<String>,
    /// The card's question, for a `Card` entry.
    pub question: Option<String>,
    pub body: String,
    pub replaces: Vec<u32>,
    pub closed_by: Option<u32>,
}

impl Entry {
    pub fn is_live(&self) -> bool {
        self.closed_by.is_none()
    }
}

/// An entry before it has an id.
#[derive(Clone, Debug)]
pub struct NewEntry {
    pub kind: Kind,
    pub who: String,
    pub sub: Option<String>,
    pub question: Option<String>,
    pub body: String,
}

#[cfg(test)]
mod tests;
