//! `main_chat_retro`: a main chat's account of its own run, written once before
//! it closes. Listed for every chat because the tool list is fixed when the
//! server process starts; the daemon route refuses a sub and a chat without Use
//! subchats on, naming why. The description stays short for the same reason as
//! `subchat`: every chat pays for it on every turn.

use serde_json::{json, Value};

pub const TOOL_MAIN_CHAT_RETRO: &str = "main_chat_retro";

pub fn retro_schemas() -> Vec<Value> {
    let cap = crate::daemon::subchats::retro::SECTION_CAP;
    let section = |what: &str| json!({"type": "string", "maxLength": cap, "description": format!("{what} Plain honest prose, at most {cap} chars.")});
    vec![json!({
        "name": TOOL_MAIN_CHAT_RETRO,
        "description": "Only for a chat with Use subchats on: write this main chat's retro, once, before it closes. The app saves it with the app version, model, effort, dates and sub counts it knows itself, so never write those. A later session reads the retros to see how main chats feel. Be honest and specific, no scores. Refused for a sub and for a chat without the mode.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "did": section("What this main chat did, and for whom."),
                "efficient": section("What felt efficient, and was the best way to do the work."),
                "slow": section("What felt slow, wasteful or clumsy."),
                "wrong": section("What went wrong, including bugs of the app itself."),
                "ideas": section("Ideas that would make main chats better.")
            },
            "required": ["did", "efficient", "slow", "wrong", "ideas"]
        }
    })]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_schema_names_the_five_sections_the_route_reads() {
        let s = &retro_schemas()[0];
        assert_eq!(s["name"], TOOL_MAIN_CHAT_RETRO);
        let props = s["inputSchema"]["properties"].as_object().unwrap();
        for (field, _) in crate::daemon::subchats::retro::SECTIONS {
            assert!(props.contains_key(field), "{field}");
        }
        assert_eq!(s["inputSchema"]["required"].as_array().unwrap().len(), 5);
    }
}
