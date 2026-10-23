//! Which chats an armed run speaks for. The chats busy at arm time are armed:
//! their prompts are auto-resolved and they hold the run until idle. A chat
//! that appears later joins the armed set only when an armed chat started it
//! (its `spawn_chat` child, or its respawn successor), since that is still the
//! work the dev chose to let finish. Any other late chat (started by hand, by
//! a schedule) is ignored: its prompts stay pending for the dev, and it never
//! holds the sleep back, or the run would stall until the no-progress guard
//! disarmed it.

use std::collections::HashSet;

pub(super) struct ArmScope {
    armed: HashSet<String>,
    /// Chats alive at arm time plus every late chat admitted to `armed`.
    seen: HashSet<String>,
    /// Late chats with no armed parent yet. Re-checked every tick: the parent
    /// link is written while the child is starting, so the first tick that
    /// sees a child can be early.
    ignored: HashSet<String>,
}

impl ArmScope {
    /// `live` is every chat alive at arm time, `busy` the ones in flight.
    pub(super) fn new(live: &[String], busy: &[String]) -> Self {
        Self {
            armed: busy.iter().cloned().collect(),
            seen: live.iter().cloned().collect(),
            ignored: HashSet::new(),
        }
    }

    /// Classifies every late chat in `live` not yet armed. Repeats until
    /// nothing changes, so a grandchild that shows up in the same tick as its
    /// parent is still admitted.
    pub(super) fn admit(&mut self, live: &[String], parent_of: impl Fn(&str) -> Option<String>) {
        let mut pending: Vec<&String> = live.iter().filter(|id| !self.seen.contains(*id)).collect();
        loop {
            let before = pending.len();
            pending.retain(|id| match parent_of(id) {
                Some(p) if self.armed.contains(&p) => {
                    self.armed.insert((*id).clone());
                    self.ignored.remove(*id);
                    self.seen.insert((*id).clone());
                    false
                }
                _ => true,
            });
            if pending.len() == before {
                break;
            }
        }
        for id in pending {
            self.ignored.insert(id.clone());
        }
    }

    pub(super) fn armed(&self) -> &HashSet<String> {
        &self.armed
    }

    pub(super) fn is_ignored(&self, id: &str) -> bool {
        self.ignored.contains(id)
    }
}

#[cfg(test)]
#[path = "scope_tests.rs"]
mod tests;
