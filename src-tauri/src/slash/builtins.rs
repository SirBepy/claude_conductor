use super::{SlashEntry, SlashSource};

pub fn all() -> Vec<SlashEntry> {
    vec![
        e("help",        None, "Show supported commands"),
        e("clear",       None, "End current session, start a fresh one"),
        e("config",      None, "Open settings"),
        e("permissions", None, "Open permissions settings"),
        e("exit",        None, "Close this session"),
        e("cost",        None, "Show running session cost"),
    ]
}

fn e(name: &str, args: Option<&str>, desc: &str) -> SlashEntry {
    SlashEntry {
        name: name.to_string(),
        args: args.map(str::to_string),
        description: desc.to_string(),
        source: SlashSource::Builtin,
        path: None,
    }
}
