//! The chat view re-enforces the `next_actions` limits the MCP tool schema
//! declares (`src/shared/chat/chat-next-actions.ts`), because the model may not
//! honour a schema. The two copies live in different languages, so this pins
//! them to each other. It reads the schema's source text because the builder
//! (`next_actions_schema`) is private to the `mcp` module, out of reach here.

fn number_after(haystack: &str, key: &str) -> u64 {
    let rest = haystack.split(key).nth(1).unwrap_or_else(|| panic!("`{key}` not found"));
    let digits: String = rest.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().unwrap_or_else(|_| panic!("no number after `{key}`"))
}

#[test]
fn the_chat_view_limits_match_the_tool_schema() {
    let ts = include_str!("../../src/shared/chat/chat-next-actions.ts").replace("\r\n", "\n");
    let rs = include_str!("../src/mcp/tool_schemas_coordination.rs").replace("\r\n", "\n");

    let start = rs.find("fn next_actions_schema()").expect("schema builder exists");
    let schema = &rs[start..];
    let schema = &schema[..schema.find("\n}\n").expect("builder ends")];

    assert_eq!(
        number_after(&ts, "MAX_NEXT_ACTIONS ="),
        number_after(schema, "\"maxItems\":"),
        "chat-next-actions.ts MAX_NEXT_ACTIONS drifted from the tool schema's maxItems"
    );
    assert_eq!(
        number_after(&ts, "MAX_NEXT_ACTION_LEN ="),
        number_after(schema, "\"maxLength\":"),
        "chat-next-actions.ts MAX_NEXT_ACTION_LEN drifted from the tool schema's maxLength"
    );
}
