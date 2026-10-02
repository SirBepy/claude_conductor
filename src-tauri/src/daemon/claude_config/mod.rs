//! Claude invocation config builders: MCP config, hook settings, and base CLI
//! args. These are independent of session process lifecycle and consumed by
//! `spawn_session` in `lifecycle.rs`.
//!
//! One sibling module per concern: `args` (CLI arg building,
//! including the system-prompt text and the pre-trusted MCP tool list),
//! `mcp_config` (the per-turn `.mcp.json` writer), `hook_settings` (the
//! per-session `.settings.json` writer and the hook server's port lookup),
//! and `gc` (the temp-file sweep). Every item below is re-exported at this
//! same path so every existing caller (`grep -rn "claude_config::"
//! src-tauri/src`) keeps compiling unchanged.

mod args;
mod gc;
mod hook_settings;
mod mcp_config;

pub(crate) use args::{append_system_prompt, base_claude_args, turn_nonce};
pub(crate) use gc::gc_temp_files;
pub(crate) use hook_settings::{daemon_hook_port, write_hook_settings};
pub(crate) use mcp_config::write_mcp_config;
