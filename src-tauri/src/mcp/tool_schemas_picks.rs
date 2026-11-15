//! `autopilot_pick`: a choice Claude made by itself on an unattended run, recorded
//! so Joe can review it later (pc-1750). Listed for every chat because the tool
//! list is fixed when the server process starts; the daemon route refuses a chat
//! whose run is not unattended, naming the question card as the way to ask. The
//! description stays short: every chat pays for it on every turn.

use serde_json::{json, Value};

pub const TOOL_AUTOPILOT_PICK: &str = "autopilot_pick";

pub fn pick_schemas() -> Vec<Value> {
    vec![json!({
        "name": TOOL_AUTOPILOT_PICK,
        "description": "Only on an unattended run (autopilot, Joe away): when you hit a choice that has real alternatives and nobody to ask, pick the safest one and record it here so Joe can review it later. Give the question he would have been asked, every candidate option (the one you picked included), the pick, why, and where it landed (commit or files). Never for a status fact (a commit id, a port) and never when Joe is here: ask him on a card then, this call is refused. Once Joe overruled a pick and you changed the code, call again with action 'corrected', the pick's id and a note naming the commit.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["record", "corrected"]},
                "question": {"type": "string", "maxLength": 400},
                "options": {"type": "array", "items": {"type": "string", "maxLength": 200}, "maxItems": 8},
                "pick": {"type": "string", "maxLength": 200},
                "reason": {"type": "string", "maxLength": 600},
                "landed": {"type": "string", "maxLength": 300},
                "id": {"type": "string"},
                "note": {"type": "string", "maxLength": 300}
            }
        }
    })]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_schema_names_the_fields_the_route_reads() {
        let s = &pick_schemas()[0];
        assert_eq!(s["name"], TOOL_AUTOPILOT_PICK);
        let props = s["inputSchema"]["properties"].as_object().unwrap();
        for f in ["action", "question", "options", "pick", "reason", "landed", "id", "note"] {
            assert!(props.contains_key(f), "{f}");
        }
    }
}
