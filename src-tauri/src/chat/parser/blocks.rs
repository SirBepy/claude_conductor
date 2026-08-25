//! Sentinel-stripping and content-block extraction shared by `parse_line`'s
//! `user`/`assistant` arms and `tool_result_output`.

use crate::types::chat::ContentBlock;
use serde_json::Value;

/// Strips a leading `DAEMON_META_SENTINEL` off the first text block, if
/// present, and reports whether it found one. Always written at the very
/// start of the wire text by `lifecycle::send_message`, so a plain
/// `starts_with` on the first block is the only check needed.
pub(super) fn strip_daemon_meta_sentinel(content: &mut [ContentBlock]) -> bool {
    let Some(ContentBlock::Text { text }) = content.first_mut() else { return false };
    let Some(stripped) = text.strip_prefix(crate::types::chat::DAEMON_META_SENTINEL) else { return false };
    *text = stripped.to_string();
    true
}

/// Strips a leading `DAEMON_AUTHOR_SENTINEL_PREFIX..SUFFIX` marker off the
/// first text block, returning the extracted sending-session id if present.
/// Mirrors `strip_daemon_meta_sentinel`'s single-first-block check.
pub(super) fn strip_daemon_author_sentinel(content: &mut [ContentBlock]) -> Option<String> {
    let Some(ContentBlock::Text { text }) = content.first_mut() else { return None };
    let (author, remainder) = crate::types::chat::strip_daemon_author_sentinel(text);
    let author = author.map(str::to_string);
    if author.is_some() {
        *text = remainder.to_string();
    }
    author
}

pub(super) fn extract_content_blocks(v: &Value) -> Vec<ContentBlock> {
    if let Some(s) = v.as_str() {
        return vec![ContentBlock::Text { text: s.to_string() }];
    }
    if let Some(arr) = v.as_array() {
        return arr.iter().filter_map(|item| {
            match item.get("type")?.as_str()? {
                "text" => Some(ContentBlock::Text {
                    text: item.get("text")?.as_str()?.to_string(),
                }),
                "image" => Some(ContentBlock::Image {
                    mime: item.get("source")?.get("media_type")?.as_str()?.to_string(),
                    data: item.get("source")?.get("data")?.as_str()?.to_string(),
                }),
                _ => None,
            }
        }).collect();
    }
    vec![]
}
