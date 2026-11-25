//! What a chat on an `Endpoint` account (Kimi Code, DeepSeek, OpenRouter, a
//! custom URL) carries less of than a Claude chat: the small provider plans burn
//! on the fixed prefix every call re-sends and on a long context, so three
//! levers are pulled for that account kind and never for a Claude main or plain
//! chat. Each takes `endpoint: bool` and returns its input unchanged for `false`,
//! which `claude_accounts_get_no_trim` below pins. A sub is trimmed on any
//! account, Claude included: [`SUB_DENIED_TOOLS`] through `trim_sub_args(is_sub)`.
//!
//! Left alone on purpose: the global and project CLAUDE.md (they carry the commit
//! and safety rules), the `Agent` tool, the billing guard, the ask channel, and
//! the `cc_conductor` tool schemas (already deferred behind ToolSearch in every
//! chat, so there is nothing left to defer). Auto-memory is NOT trimmed here: that
//! one waits on Joe's yes or no (see `docs/architecture/providers.md`).

use serde_json::{Map, Value};

use crate::slash::{SlashEntry, SlashSource};

/// Built-in tools an Endpoint chat never uses: each one's schema is re-sent on
/// every call, and none has a user of its own on a third-party model (a
/// workflow script, a wakeup timer, the code-review reporter, the agent list).
/// `Agent` stays: subs and reviewers need it.
pub(crate) const ENDPOINT_DENIED_TOOLS: [&str; 4] = ["Workflow", "ScheduleWakeup", "ReportFindings", "ListAgents"];

/// Where an Endpoint chat compacts, whatever the provider's own window. Calls
/// over ~150K of context carried 61% of a week's tokens (plan, 2026-11-24), and
/// a 262K window compacting at its edge pays for that whole tail.
pub(crate) const ENDPOINT_COMPACT_WINDOW_TOKENS: u64 = 120_000;

/// Built-in tools a sub never uses, on any account: a sub is a worktree chat that
/// works one brief and finishes, so a workflow script, a wakeup timer and the
/// code-review reporter have no user there (1, 54 and 2 uses in 7 days across all
/// chats, none by a sub that mattered; their three schemas are ~4.7K tokens on every
/// call of ~46K sub calls a week, plan 2026-11-25 step 7). `/loop` and `/code-review`
/// stay in main and plain chats, which are never trimmed here.
pub(crate) const SUB_DENIED_TOOLS: [&str; 3] = ["Workflow", "ScheduleWakeup", "ReportFindings"];

/// Adds `tools` to the `--disallowedTools` value `base_claude_args` set
/// (`AskUserQuestion`), in the same space-separated form.
/// A second `--disallowedTools` flag is not used: whether the CLI keeps the first
/// of a repeated flag is unverified, an extended value is not.
fn deny_more(args: &mut [String], tools: &[&str]) {
    let Some(i) = args.iter().position(|a| a == "--disallowedTools") else { return };
    if let Some(value) = args.get_mut(i + 1) {
        for tool in tools {
            if !value.split(' ').any(|t| t == *tool) {
                value.push(' ');
                value.push_str(tool);
            }
        }
    }
}

/// The Endpoint deny list for an Endpoint chat; the argv of any other account is unchanged.
pub(crate) fn trim_args(args: &mut [String], endpoint: bool) {
    if endpoint {
        deny_more(args, &ENDPOINT_DENIED_TOOLS);
    }
}

/// The sub deny list for a sub of any account; a main or plain chat's argv is unchanged.
pub(crate) fn trim_sub_args(args: &mut [String], is_sub: bool) {
    if is_sub {
        deny_more(args, &SUB_DENIED_TOOLS);
    }
}

/// The argv a chat's `claude` starts with: `base_claude_args`, trimmed when the
/// chat runs on an Endpoint account and when it is a sub. The one place
/// `spawn_session` builds it, so a test can hold a plain Claude chat to the
/// untrimmed argv.
pub(crate) fn chat_args(
    resume_id: Option<&str>,
    session_id: &str,
    model: &str,
    effort: &str,
    fork: bool,
    endpoint: bool,
    is_sub: bool,
) -> Vec<String> {
    let mut args = super::base_claude_args(resume_id, session_id, model, effort, fork);
    trim_args(&mut args, endpoint);
    trim_sub_args(&mut args, is_sub);
    args
}

/// The window the CLI's own auto-compact measures an Endpoint chat against:
/// the lower of `own_window` (the account's stated window, if its env set one)
/// and [`ENDPOINT_COMPACT_WINDOW_TOKENS`]. `None` for any other account kind.
pub(crate) fn compact_window(endpoint: bool, own_window: Option<u64>) -> Option<u64> {
    endpoint.then(|| own_window.map_or(ENDPOINT_COMPACT_WINDOW_TOKENS, |w| w.min(ENDPOINT_COMPACT_WINDOW_TOKENS)))
}

/// The lean skill listing for an Endpoint chat: every user skill listed by name
/// only (its description, the bulk of the listing, is dropped; `/commit` and the
/// rest still run when named) and every plugin, synced or cached, switched off
/// (`skillOverrides` has no effect on a plugin's skills, so `enabledPlugins` is
/// the only lever). Project skills and user commands are not touched.
pub(crate) fn lean_skill_settings(entries: &[SlashEntry]) -> Map<String, Value> {
    let mut overrides = Map::new();
    let mut plugins = Map::new();
    for e in entries {
        let Some(key) = e.scope_key.as_deref() else { continue };
        match e.source {
            SlashSource::UserSkill => {
                overrides.insert(key.to_string(), Value::String("name-only".into()));
            }
            SlashSource::PluginSkill { .. } | SlashSource::PluginCommand { .. } => {
                plugins.insert(key.to_string(), Value::Bool(false));
            }
            _ => {}
        }
    }
    let mut out = Map::new();
    if !overrides.is_empty() {
        out.insert("skillOverrides".into(), Value::Object(overrides));
    }
    if !plugins.is_empty() {
        out.insert("enabledPlugins".into(), Value::Object(plugins));
    }
    out
}

/// The `skillOverrides` / `enabledPlugins` keys for one chat's `--settings`:
/// `scoped` (the project's own per-skill scope, `slash::scope::chat_settings`)
/// for a Claude chat, untouched; for an Endpoint chat the lean listing with
/// `scoped` laid over it, so a skill Joe scoped `off` stays off and a plugin he
/// scoped into this project stays on.
pub(crate) fn skill_settings(endpoint: bool, scoped: Map<String, Value>, lean_entries: &[SlashEntry]) -> Map<String, Value> {
    if !endpoint {
        return scoped;
    }
    let mut out = lean_skill_settings(lean_entries);
    for (section, value) in scoped {
        match (out.get_mut(&section), value) {
            (Some(Value::Object(base)), Value::Object(over)) => base.extend(over),
            (_, value) => {
                out.insert(section, value);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::claude_config::base_claude_args;
    use serde_json::json;

    fn entry(name: &str, source: SlashSource, key: Option<&str>) -> SlashEntry {
        SlashEntry {
            name: name.into(),
            args: None,
            description: "a long description".into(),
            source,
            path: None,
            menu_hidden: false,
            scope_key: key.map(str::to_string),
            off_here: false,
        }
    }

    fn disallowed(args: &[String]) -> &str {
        let i = args.iter().position(|a| a == "--disallowedTools").expect("--disallowedTools");
        &args[i + 1]
    }

    #[test]
    fn an_endpoint_chat_denies_the_four_tools_beside_the_ask_builtin() {
        let mut args = base_claude_args(None, "s", "m", "high", false);
        trim_args(&mut args, true);
        let tools: Vec<&str> = disallowed(&args).split(' ').collect();
        assert_eq!(tools, ["AskUserQuestion", "Workflow", "ScheduleWakeup", "ReportFindings", "ListAgents"]);
        assert_eq!(args.iter().filter(|a| *a == "--disallowedTools").count(), 1, "one flag, one extended value");
    }

    #[test]
    fn the_deny_list_never_names_agent_or_the_conductor_tools() {
        for banned in ["Agent", "ToolSearch", "Read", "Edit", "Bash"] {
            assert!(!ENDPOINT_DENIED_TOOLS.contains(&banned), "{banned} must stay available");
        }
        let mut args = base_claude_args(None, "s", "m", "high", false);
        trim_args(&mut args, true);
        assert!(!disallowed(&args).contains("mcp__"), "no cc_conductor tool is denied: {}", disallowed(&args));
        // The ask channel is the one builtin that stays denied, and the allow list is untouched.
        assert!(disallowed(&args).split(' ').any(|t| t == "AskUserQuestion"));
        let before = base_claude_args(None, "s", "m", "high", false);
        let allow = |a: &[String]| a[a.iter().position(|x| x == "--allowedTools").unwrap() + 1].clone();
        assert_eq!(allow(&args), allow(&before));
    }

    /// What `spawn_session` calls: the Endpoint flag decides the argv, nothing else does.
    #[test]
    fn chat_args_trims_only_for_an_endpoint_account() {
        let plain = base_claude_args(Some("a"), "a", "opus", "high", false);
        assert_eq!(chat_args(Some("a"), "a", "opus", "high", false, false, false), plain, "a Claude account's argv is base_claude_args exactly");
        let trimmed = chat_args(Some("a"), "a", "kimi", "high", false, true, false);
        assert_ne!(trimmed, base_claude_args(Some("a"), "a", "kimi", "high", false));
        assert!(disallowed(&trimmed).contains("Workflow"));
    }

    #[test]
    fn a_sub_on_a_claude_account_denies_three_tools_and_a_main_chat_none() {
        let sub = chat_args(None, "s", "opus", "high", false, false, true);
        let tools: Vec<&str> = disallowed(&sub).split(' ').collect();
        assert_eq!(tools, ["AskUserQuestion", "Workflow", "ScheduleWakeup", "ReportFindings"]);
        let main = chat_args(None, "s", "opus", "high", false, false, false);
        assert_eq!(disallowed(&main), "AskUserQuestion", "/loop and /code-review stay in a main chat");
        assert_eq!(main, base_claude_args(None, "s", "opus", "high", false));
        for banned in ["Agent", "ToolSearch", "Read", "Edit", "Bash"] {
            assert!(!SUB_DENIED_TOOLS.contains(&banned), "{banned} must stay available to a sub");
        }
    }

    #[test]
    fn a_sub_on_an_endpoint_account_gets_the_union_once() {
        let args = chat_args(None, "s", "kimi", "high", false, true, true);
        let tools: Vec<&str> = disallowed(&args).split(' ').collect();
        assert_eq!(tools, ["AskUserQuestion", "Workflow", "ScheduleWakeup", "ReportFindings", "ListAgents"]);
    }

    #[test]
    fn a_second_trim_adds_nothing() {
        let mut args = base_claude_args(None, "s", "m", "high", false);
        trim_args(&mut args, true);
        let once = args.clone();
        trim_args(&mut args, true);
        assert_eq!(args, once);
    }

    /// A Claude account's argv is byte for byte what `base_claude_args` built.
    #[test]
    fn claude_accounts_get_no_trim() {
        let base = base_claude_args(Some("old"), "new", "opus", "high", true);
        let mut args = base.clone();
        trim_args(&mut args, false);
        assert_eq!(args, base);
        assert_eq!(disallowed(&args), "AskUserQuestion");
        assert_eq!(compact_window(false, None), None);
        assert_eq!(compact_window(false, Some(262_144)), None);
        let scoped: Map<String, Value> = json!({ "skillOverrides": { "figma-tiles": "off" } }).as_object().unwrap().clone();
        let entries = [entry("commit", SlashSource::UserSkill, Some("commit"))];
        assert_eq!(skill_settings(false, scoped.clone(), &entries), scoped);
        assert!(skill_settings(false, Map::new(), &entries).is_empty(), "a Claude chat with no scope writes nothing");
    }

    #[test]
    fn an_endpoint_chat_compacts_at_120k_or_its_own_smaller_window() {
        assert_eq!(compact_window(true, None), Some(120_000), "deepseek / openrouter / custom: no stated window");
        assert_eq!(compact_window(true, Some(262_144)), Some(120_000), "kimi's 262K window");
        assert_eq!(compact_window(true, Some(64_000)), Some(64_000), "never later than the model's own window");
    }

    #[test]
    fn the_lean_listing_names_user_skills_only_and_switches_plugins_off() {
        let entries = [
            entry("commit", SlashSource::UserSkill, Some("commit")),
            entry("test", SlashSource::UserSkill, Some("test")),
            entry("pdf", SlashSource::PluginSkill { plugin: "anthropic-skills".into() }, Some("anthropic-skills@synced")),
            entry("figma-use", SlashSource::PluginCommand { plugin: "figma".into() }, Some("figma@claude-plugins-official")),
            entry("repo-skill", SlashSource::ProjectSkill { project: "p".into() }, None),
            entry("pickup", SlashSource::UserCommand, None),
            entry("help", SlashSource::Builtin, None),
        ];
        assert_eq!(
            Value::Object(lean_skill_settings(&entries)),
            json!({
                "skillOverrides": { "commit": "name-only", "test": "name-only" },
                "enabledPlugins": { "anthropic-skills@synced": false, "figma@claude-plugins-official": false }
            })
        );
    }

    #[test]
    fn a_projects_own_scope_beats_the_lean_listing() {
        let entries = [
            entry("figma-tiles", SlashSource::UserSkill, Some("figma-tiles")),
            entry("commit", SlashSource::UserSkill, Some("commit")),
            entry("figma-use", SlashSource::PluginSkill { plugin: "figma".into() }, Some("figma@x")),
        ];
        let scoped: Map<String, Value> =
            json!({ "skillOverrides": { "figma-tiles": "off" }, "enabledPlugins": { "figma@x": true } }).as_object().unwrap().clone();
        assert_eq!(
            Value::Object(skill_settings(true, scoped, &entries)),
            json!({
                "skillOverrides": { "figma-tiles": "off", "commit": "name-only" },
                "enabledPlugins": { "figma@x": true }
            })
        );
    }

    #[test]
    fn with_nothing_to_list_an_endpoint_chat_writes_no_skill_keys() {
        assert!(skill_settings(true, Map::new(), &[]).is_empty());
    }
}
