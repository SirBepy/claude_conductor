//! Per-project dashboard: stored config (groups, custom cards), the card
//! runner, and the path language that turns a response into card values.
//! The daemon owns the store; nothing here talks to the vault or settings.

pub mod card_extras;
pub mod card_rules;
pub mod extract;
pub mod history_build;
pub mod history_scan;
pub mod last_run;
pub mod open_state;
pub mod plan;
pub mod runner;
pub mod snapshot_parts;
pub mod snapshot_types;
pub mod store;
pub mod store_file;
pub mod targets;
pub mod template;
pub mod types;
pub mod vault_seed;

pub use runner::run_card;
pub use store::{CacheStore, DashboardStore};
pub use template::{env_secret, TemplateCtx};
pub use types::{
    CardAction, CardConfig, CardDisplay, CardProgress, CardResult, CardSource, CardView, GroupDef, LabelValue, RowValue, Scope, StatSpec, BUILTIN_CARDS,
};
pub use snapshot_types::{
    ChannelNote, CommitRow, DashChatRow, DashTodo, DashboardHistory, DashboardListRow, DashboardSnapshot,
    DashboardTarget, DashboardTargetRef, FileRow, GalleryItem, NeedsYouItem, OutcomeRow, PlanItem, QuickAction,
    RepoRef, RepoShip, ScheduledRow, ServerRow,
};
pub use vault_seed::seed_groups;
