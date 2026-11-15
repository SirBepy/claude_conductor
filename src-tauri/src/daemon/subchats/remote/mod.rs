//! Subs whose main chat lives on another paired machine: the home owns the
//! family, the host runs the sub's process. Design, trust rules, wire and the
//! build steps: `docs/cross-machine-subchats.md`.

pub mod git_sync;
pub mod host;
pub mod project_match;
pub mod records;
#[cfg(test)]
mod test_support;

pub use records::sweep_at_start;
