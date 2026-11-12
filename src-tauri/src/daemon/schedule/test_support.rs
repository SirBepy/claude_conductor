//! Item and state builders shared by the schedule modules' tests.

use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::state::DaemonState;
use crate::sessions::scheduled_items::{Recurrence, ScheduledItem, ScheduledKind};
use crate::types::Settings;
use chrono::{DateTime, Utc};
use std::sync::Arc;

pub(super) fn test_state() -> Arc<DaemonState> {
    DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
}

pub(super) fn make_item(fire_at: DateTime<Utc>, recurrence: Option<Recurrence>) -> ScheduledItem {
    ScheduledItem::new(
        ScheduledKind::Message { session_id: "ghost-session".into(), cwd: "Z:\\does\\not\\exist".into() },
        "hi".into(),
        fire_at.to_rfc3339(),
        recurrence,
    )
}

pub(super) fn guarded(guard: &str, cwd: &str, recurrence: Option<Recurrence>) -> ScheduledItem {
    let mut item = ScheduledItem::new(
        ScheduledKind::Message { session_id: "ghost-session".into(), cwd: cwd.into() },
        "hi".into(),
        (Utc::now() - chrono::Duration::minutes(1)).to_rfc3339(),
        recurrence,
    );
    item.guard = Some(guard.to_string());
    item
}

pub(super) fn gated(fire_at: DateTime<Utc>) -> ScheduledItem {
    let mut item = make_item(fire_at, None);
    item.after_meeting = Some(true);
    item
}
