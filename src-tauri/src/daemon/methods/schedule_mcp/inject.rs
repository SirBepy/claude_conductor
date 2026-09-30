//! Turn-hook rendering for the `schedule` tool: the pending-items block the
//! daemon injects on `UserPromptSubmit`, split out of the parent module
//! (todo 1011) because it is the one concern here with no MCP-facing
//! counterpart - it only ever runs on the daemon's own hook path.

use crate::daemon::methods::injection_util::{append_capped, short};
use crate::daemon::state::DaemonState;
use crate::sessions::scheduled_items::{self, RecurrenceRule, ScheduledItem, ScheduledKind, ScheduledStatus};
use chrono::{DateTime, Local};
use std::sync::Arc;

/// Cap on injected rows, mirroring `user_todos::MAX_INJECTED`.
const MAX_INJECTED: usize = 10;

/// Pending items this session can act on: anything firing into this session,
/// plus new-chat items aimed at the directory it is working in. Deliberately
/// not every item on the machine - an unrelated project's schedule is noise
/// here, and the point of this block is to hand over ids the model may cancel.
pub(crate) fn render_for_injection(state: &Arc<DaemonState>, session_id: &str) -> Option<String> {
    let caller = state.registry.get(session_id)?;
    let mine: Vec<ScheduledItem> = scheduled_items::list()
        .into_iter()
        .filter(|it| matches!(it.status, ScheduledStatus::Pending))
        .filter(|it| match &it.kind {
            ScheduledKind::Message { session_id: target, .. } => target == session_id,
            ScheduledKind::NewChat { cwd, .. } => {
                crate::util::same_dir(&caller.cwd, std::path::Path::new(cwd))
            }
            ScheduledKind::JarvisHygiene => false,
        })
        .collect();
    if mine.is_empty() {
        return None;
    }

    let mut out = String::from(
        "[scheduled] Prompts already queued to fire later, from the app's Schedule panel. \
         They run on their own - never re-create one, and never promise to \"remember\" to do \
         something one of these already covers. Cancel with the `schedule` tool's \
         `cancel` action and the id below.\n",
    );
    append_capped(&mut out, &mine, MAX_INJECTED, |it| line_for(it));
    Some(out)
}

fn line_for(item: &ScheduledItem) -> String {
    let when = DateTime::parse_from_rfc3339(&item.fire_at)
        .map(|dt| dt.with_timezone(&Local).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|_| item.fire_at.clone());
    let repeat = match item.recurrence.as_ref().map(|r| &r.rule) {
        None => String::new(),
        Some(RecurrenceRule::Daily) => ", daily".to_string(),
        Some(RecurrenceRule::Weekly { weekdays }) => format!(", weekly on {weekdays:?}"),
        Some(RecurrenceRule::EveryNDays { n }) => format!(", every {n}d"),
    };
    let target = match &item.kind {
        ScheduledKind::Message { .. } => "this chat",
        ScheduledKind::NewChat { .. } => "new chat",
        ScheduledKind::JarvisHygiene => "jarvis",
    };
    format!("- [{}] {when}{repeat} -> {target}: {}", short(&item.id), item.prompt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_id_is_the_injected_prefix() {
        assert_eq!(short("0123456789abcdef"), "01234567");
    }
}
