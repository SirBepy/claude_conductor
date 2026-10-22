//! Mines one Claude transcript for the dashboard's reports: slash commands the
//! dev ran, the last message the chat sent them, images, and files written.
//!
//! A raw line scan, not `chat::history::replay`: replay builds a `ChatEvent` for
//! every line (base64 image payloads included), while nearly every transcript
//! line is irrelevant here. A substring prefilter skips the JSON parse for those,
//! and an image is recorded as a byte offset so its bytes are only read when the
//! gallery asks for that one picture.

use super::snapshot_parts::parse_ms;
use base64::Engine;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

const SEND_MESSAGE_TOOL: &str = "mcp__cc_conductor__send_message";

/// Where one image lives inside a transcript.
#[derive(Clone, Debug, PartialEq)]
pub struct ImageRef {
    /// Byte offset of the line's first byte.
    pub offset: u64,
    /// `"<content index>"` for a pasted image, `"<content index>.<inner index>"`
    /// for one inside a tool result.
    pub block: String,
    pub at_ms: i64,
}

#[derive(Clone, Debug, Default)]
pub struct TranscriptFacts {
    /// Slash commands the dev ran, leading slash included, with when.
    pub commands: Vec<(String, i64)>,
    /// Text and time of the last top-level `send_message` call.
    pub outcome: Option<(String, i64)>,
    pub images: Vec<ImageRef>,
    /// `Write` targets with when.
    pub writes: Vec<(String, i64)>,
}

/// Cheap reject before any JSON parse. Over-inclusive on purpose (a tool result
/// quoting `"image"` just costs one wasted parse); the structural checks in
/// `scan_line` are what decide.
fn might_matter(line: &str) -> bool {
    line.contains("command-name")
        || line.contains("send_message")
        || line.contains("\"Write\"")
        || line.contains("\"image\"")
}

/// `/name` out of a slash-command invocation turn. Only a turn that STARTS with
/// the command markup counts, so a message that merely quotes one does not.
fn command_name(text: &str) -> Option<String> {
    let t = text.trim_start();
    if !(t.starts_with("<command-message>") || t.starts_with("<command-name>")) {
        return None;
    }
    let open = "<command-name>";
    let start = t.find(open)? + open.len();
    let end = t[start..].find("</command-name>")? + start;
    let name = t[start..end].trim();
    let valid = name.starts_with('/') && name.len() > 1 && name.len() <= 64 && !name.contains(char::is_whitespace);
    valid.then(|| name.to_string())
}

fn has_image_data(block: &Value) -> bool {
    block["type"] == "image" && block["source"]["data"].as_str().is_some_and(|d| !d.is_empty())
}

fn scan_line(line: &str, offset: u64, fallback_ms: i64, facts: &mut TranscriptFacts) {
    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { return };
    // A subagent's calls and outputs are not what the chat itself did.
    if v["isSidechain"] == true || !v["parent_tool_use_id"].is_null() {
        return;
    }
    let at_ms = v["timestamp"].as_str().and_then(parse_ms).unwrap_or(fallback_ms);
    let content = &v["message"]["content"];
    match v["type"].as_str() {
        Some("user") => scan_user(content, offset, at_ms, facts),
        Some("assistant") => scan_assistant(content, at_ms, facts),
        _ => {}
    }
}

fn scan_user(content: &Value, offset: u64, at_ms: i64, facts: &mut TranscriptFacts) {
    if let Some(text) = content.as_str() {
        if let Some(cmd) = command_name(text) {
            facts.commands.push((cmd, at_ms));
        }
        return;
    }
    let Some(blocks) = content.as_array() else { return };
    for (i, b) in blocks.iter().enumerate() {
        match b["type"].as_str() {
            Some("text") => {
                if let Some(cmd) = b["text"].as_str().and_then(command_name) {
                    facts.commands.push((cmd, at_ms));
                }
            }
            Some("image") if has_image_data(b) => {
                facts.images.push(ImageRef { offset, block: i.to_string(), at_ms });
            }
            Some("tool_result") => {
                for (j, inner) in b["content"].as_array().into_iter().flatten().enumerate() {
                    if has_image_data(inner) {
                        facts.images.push(ImageRef { offset, block: format!("{i}.{j}"), at_ms });
                    }
                }
            }
            _ => {}
        }
    }
}

fn scan_assistant(content: &Value, at_ms: i64, facts: &mut TranscriptFacts) {
    for b in content.as_array().into_iter().flatten() {
        if b["type"] != "tool_use" {
            continue;
        }
        match b["name"].as_str() {
            Some(SEND_MESSAGE_TOOL) => {
                if let Some(text) = b["input"]["text"].as_str().filter(|t| !t.trim().is_empty()) {
                    facts.outcome = Some((text.to_string(), at_ms));
                }
            }
            Some("Write") => {
                if let Some(p) = b["input"]["file_path"].as_str().filter(|p| !p.is_empty()) {
                    facts.writes.push((p.to_string(), at_ms));
                }
            }
            _ => {}
        }
    }
}

/// One pass over a transcript. `fallback_ms` stamps lines with no timestamp.
pub fn scan_reader<R: BufRead>(mut reader: R, fallback_ms: i64) -> TranscriptFacts {
    let mut facts = TranscriptFacts::default();
    let mut offset = 0u64;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let line_offset = offset;
        offset += n as u64;
        if let Ok(line) = std::str::from_utf8(&buf) {
            if might_matter(line) {
                scan_line(line, line_offset, fallback_ms, &mut facts);
            }
        }
    }
    facts
}

type FactsCache = Mutex<HashMap<PathBuf, (SystemTime, Arc<TranscriptFacts>)>>;

fn cache() -> &'static FactsCache {
    static C: std::sync::OnceLock<FactsCache> = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Past this many entries the cache is dropped wholesale: it only has to cover
/// the handful of recent transcripts the dashboard reads, so an LRU would be
/// bookkeeping for a size that is never reached.
const CACHE_MAX: usize = 400;

/// `scan_reader` over a file, memoised by (path, mtime) so a repeat call costs
/// a stat. A chat that is still writing re-scans each time its mtime moves.
pub fn facts_for(path: &Path) -> Option<Arc<TranscriptFacts>> {
    let mtime = std::fs::metadata(path).ok()?.modified().ok()?;
    if let Some((cached_at, facts)) = cache().lock().unwrap_or_else(|e| e.into_inner()).get(path) {
        if *cached_at == mtime {
            return Some(facts.clone());
        }
    }
    let fallback_ms = mtime
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let file = std::fs::File::open(path).ok()?;
    let facts = Arc::new(scan_reader(BufReader::with_capacity(256 * 1024, file), fallback_ms));
    let mut guard = cache().lock().unwrap_or_else(|e| e.into_inner());
    if guard.len() >= CACHE_MAX {
        guard.clear();
    }
    guard.insert(path.to_path_buf(), (mtime, facts.clone()));
    Some(facts)
}

/// The transcript folder name for a repo. The CLI derives it from the cwd as IT
/// saw it, so the same folder can appear as `c--Users-...` or `C--Users-...`;
/// `collect_history` filters on the exact name, so on case-insensitive
/// filesystems this returns the spelling actually on disk.
pub fn project_dir_slug(projects_dir: &Path, cwd: &str) -> String {
    let slug = crate::tokens::encode_cwd_as_project_dir(Path::new(cwd));
    if !cfg!(any(windows, target_os = "macos")) {
        return slug;
    }
    // No `is_dir` shortcut: on these filesystems the wrong-case name "exists"
    // too, which is exactly the spelling `collect_history` would then miss.
    std::fs::read_dir(projects_dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .find(|name| name.eq_ignore_ascii_case(&slug))
        .unwrap_or(slug)
}

// ---- gallery ids -----------------------------------------------------------

const URL_SAFE: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// Opaque id the gallery hands back to `read_image`: the transcript path, the
/// line's byte offset and the block spec.
pub fn encode_image_id(path: &Path, offset: u64, block: &str) -> String {
    URL_SAFE.encode(format!("{}|{}|{}", path.to_string_lossy(), offset, block))
}

fn decode_image_id(id: &str) -> Option<(PathBuf, u64, String)> {
    let raw = String::from_utf8(URL_SAFE.decode(id).ok()?).ok()?;
    // Split from the right: the block and offset never contain '|', the path might.
    let mut parts = raw.rsplitn(3, '|');
    let block = parts.next()?.to_string();
    let offset = parts.next()?.parse().ok()?;
    let path = PathBuf::from(parts.next()?);
    Some((path, offset, block))
}

/// Locates a block by its spec inside an already-parsed transcript line.
fn block_at<'a>(line: &'a Value, spec: &str) -> Option<&'a Value> {
    let content = line["message"]["content"].as_array()?;
    match spec.split_once('.') {
        None => content.get(spec.parse::<usize>().ok()?),
        Some((i, j)) => content.get(i.parse::<usize>().ok()?)?["content"].as_array()?.get(j.parse::<usize>().ok()?),
    }
}

const MIME_ALLOWED: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

fn is_base64(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'\r' | b'\n'))
}

/// The `data:` URL for a gallery id. The id is client-supplied, so it is only
/// honoured for a `.jsonl` file inside `projects_root` (compared after
/// canonicalising, which also defeats `..` and symlink escapes): without that
/// the RPC would be an arbitrary-file-read primitive.
pub fn read_image(id: &str, projects_root: &Path) -> Result<String, String> {
    let (path, offset, block) = decode_image_id(id).ok_or("invalid image id")?;
    let root = projects_root.canonicalize().map_err(|_| "projects folder not found".to_string())?;
    let real = path.canonicalize().map_err(|_| "transcript not found".to_string())?;
    if !real.starts_with(&root) || real.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err("image is outside the transcripts folder".to_string());
    }
    let mut file = std::fs::File::open(&real).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(file.take(64 * 1024 * 1024)).read_line(&mut line).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(line.trim()).map_err(|_| "transcript changed since the gallery was built")?;
    let b = block_at(&v, &block).ok_or("image not found in transcript")?;
    let mime = b["source"]["media_type"].as_str().unwrap_or("");
    let data = b["source"]["data"].as_str().unwrap_or("");
    if !MIME_ALLOWED.contains(&mime) || data.is_empty() || !is_base64(data) {
        return Err("not a displayable image".to_string());
    }
    Ok(format!("data:{mime};base64,{}", data.replace(['\r', '\n'], "")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn scan(lines: &[&str]) -> TranscriptFacts {
        scan_reader(Cursor::new(lines.join("\n")), 1)
    }

    const PNG: &str = "iVBORw0KGgo=";

    #[test]
    fn slash_commands_are_read_from_user_turns_in_both_content_shapes() {
        let f = scan(&[
            r#"{"type":"user","timestamp":"2026-10-22T10:00:00Z","message":{"role":"user","content":[{"type":"text","text":"<command-message>close</command-message>\n<command-name>/close</command-name>"}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/commit</command-name>\n<command-args>x</command-args>"}}"#,
        ]);
        let names: Vec<&str> = f.commands.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["/close", "/commit"]);
        assert_eq!(f.commands[0].1, parse_ms("2026-10-22T10:00:00Z").unwrap());
        assert_eq!(f.commands[1].1, 1, "a line with no timestamp takes the fallback");
    }

    #[test]
    fn a_message_that_only_quotes_a_command_is_not_a_command() {
        let f = scan(&[r#"{"type":"user","message":{"role":"user","content":"look at <command-name>/close</command-name> in the log"}}"#]);
        assert!(f.commands.is_empty());
    }

    #[test]
    fn command_names_must_look_like_a_slash_command() {
        assert_eq!(command_name("<command-name>/rate-it</command-name>").as_deref(), Some("/rate-it"));
        assert_eq!(command_name("<command-name>/figma:use</command-name>").as_deref(), Some("/figma:use"));
        assert_eq!(command_name("<command-name>close</command-name>"), None);
        assert_eq!(command_name("<command-name>/</command-name>"), None);
        assert_eq!(command_name("<command-name>/a b</command-name>"), None);
    }

    #[test]
    fn the_last_top_level_send_message_is_the_outcome() {
        let f = scan(&[
            r#"{"type":"assistant","timestamp":"2026-10-22T10:00:00Z","message":{"content":[{"type":"tool_use","name":"mcp__cc_conductor__send_message","input":{"text":"first"}}]}}"#,
            r#"{"type":"assistant","timestamp":"2026-10-22T11:00:00Z","message":{"content":[{"type":"tool_use","name":"mcp__cc_conductor__send_message","input":{"text":"final answer"}}]}}"#,
            r#"{"type":"assistant","timestamp":"2026-10-22T12:00:00Z","parent_tool_use_id":"toolu_x","message":{"content":[{"type":"tool_use","name":"mcp__cc_conductor__send_message","input":{"text":"from a subagent"}}]}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"tool_use","name":"mcp__cc_conductor__send_message","input":{"text":"sidechain"}}]}}"#,
        ]);
        let (text, at) = f.outcome.unwrap();
        assert_eq!(text, "final answer");
        assert_eq!(at, parse_ms("2026-10-22T11:00:00Z").unwrap());
    }

    #[test]
    fn a_chat_with_no_send_message_has_no_outcome() {
        let f = scan(&[r#"{"type":"assistant","message":{"content":[{"type":"text","text":"send_message is mentioned here"}]}}"#]);
        assert!(f.outcome.is_none());
    }

    #[test]
    fn writes_record_their_file_path() {
        let f = scan(&[r#"{"type":"assistant","timestamp":"2026-10-22T10:00:00Z","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"C:\\x\\report.md","content":"hi"}}]}}"#]);
        assert_eq!(f.writes.len(), 1);
        assert_eq!(f.writes[0].0, "C:\\x\\report.md");
    }

    #[test]
    fn images_are_recorded_by_offset_for_pasted_and_tool_result_blocks() {
        let l1 = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"see"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]}}"#;
        let l2 = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":[{"type":"text","text":"ok"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]}]}}"#;
        let f = scan(&[l1, l2]);
        assert_eq!(f.images.len(), 2);
        assert_eq!((f.images[0].offset, f.images[0].block.as_str()), (0, "1"));
        assert_eq!(f.images[1].offset, l1.len() as u64 + 1);
        assert_eq!(f.images[1].block, "0.1");
    }

    #[test]
    fn a_line_that_is_not_json_is_skipped() {
        let f = scan(&["{broken command-name", r#"{"type":"user","message":{"content":"<command-name>/ok</command-name>"}}"#]);
        assert_eq!(f.commands.len(), 1);
    }

    #[test]
    fn the_slug_follows_whatever_case_the_folder_has_on_disk() {
        let root = tempfile::tempdir().unwrap();
        let cwd = r"C:\Users\x\app";
        let exact = crate::tokens::encode_cwd_as_project_dir(Path::new(cwd));
        // Nothing on disk: the computed name comes back unchanged.
        assert_eq!(project_dir_slug(root.path(), cwd), exact);
        if cfg!(any(windows, target_os = "macos")) {
            let lowered = exact.replacen('C', "c", 1);
            std::fs::create_dir(root.path().join(&lowered)).unwrap();
            assert_eq!(project_dir_slug(root.path(), cwd), lowered);
        }
    }

    fn transcript_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn write_transcript(root: &Path, lines: &[&str]) -> PathBuf {
        let dir = root.join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("{}.jsonl", uuid::Uuid::new_v4()));
        std::fs::write(&p, lines.join("\n")).unwrap();
        p
    }

    fn pasted(media: &str, data: &str) -> String {
        format!(r#"{{"type":"user","message":{{"role":"user","content":[{{"type":"image","source":{{"type":"base64","media_type":"{media}","data":"{data}"}}}}]}}}}"#)
    }

    #[test]
    fn a_gallery_id_round_trips_to_the_image_bytes() {
        let root = transcript_dir();
        let filler = r#"{"type":"user","message":{"content":"padding line so the offset is not zero"}}"#;
        let p = write_transcript(root.path(), &[filler, &pasted("image/png", PNG)]);
        let facts = scan_reader(BufReader::new(std::fs::File::open(&p).unwrap()), 0);
        let r = &facts.images[0];
        let id = encode_image_id(&p, r.offset, &r.block);
        assert_eq!(read_image(&id, root.path()).unwrap(), format!("data:image/png;base64,{PNG}"));
    }

    #[test]
    fn a_tool_result_image_round_trips_too() {
        let root = transcript_dir();
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":[{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"/9j/4AAQ"}}]}]}}"#;
        let p = write_transcript(root.path(), &[line]);
        let id = encode_image_id(&p, 0, "0.0");
        assert_eq!(read_image(&id, root.path()).unwrap(), "data:image/jpeg;base64,/9j/4AAQ");
    }

    #[test]
    fn an_id_pointing_outside_the_transcripts_folder_is_refused() {
        let root = transcript_dir();
        let outside = transcript_dir();
        let secret = write_transcript(outside.path(), &[&pasted("image/png", PNG)]);
        let id = encode_image_id(&secret, 0, "0");
        let err = read_image(&id, root.path()).unwrap_err();
        assert!(err.contains("outside"), "{err}");
    }

    #[test]
    fn dot_dot_escapes_are_refused() {
        let parent = transcript_dir();
        let root = parent.path().join("root");
        std::fs::create_dir_all(root.join("proj")).unwrap();
        let secret = write_transcript(&parent.path().join("outside"), &[&pasted("image/png", PNG)]);
        // Textually inside the root, but climbs out of it to the sibling folder.
        let sneaky = root
            .join("proj")
            .join("..")
            .join("..")
            .join("outside")
            .join("proj")
            .join(secret.file_name().unwrap());
        assert!(sneaky.exists(), "fixture must reach the secret through the dot-dot path");
        let err = read_image(&encode_image_id(&sneaky, 0, "0"), &root).unwrap_err();
        assert!(err.contains("outside"), "{err}");
    }

    #[test]
    fn a_non_transcript_file_inside_the_root_is_refused() {
        let root = transcript_dir();
        let f = root.path().join("notes.txt");
        std::fs::write(&f, pasted("image/png", PNG)).unwrap();
        let err = read_image(&encode_image_id(&f, 0, "0"), root.path()).unwrap_err();
        assert!(err.contains("outside"), "{err}");
    }

    #[test]
    fn garbage_ids_and_missing_files_are_errors_not_panics() {
        let root = transcript_dir();
        assert!(read_image("not base64 !!", root.path()).is_err());
        assert!(read_image(&URL_SAFE.encode("no-pipes"), root.path()).is_err());
        let missing = root.path().join("proj").join("gone.jsonl");
        assert!(read_image(&encode_image_id(&missing, 0, "0"), root.path()).is_err());
    }

    #[test]
    fn only_image_mime_types_and_base64_payloads_are_served() {
        let root = transcript_dir();
        let svg = write_transcript(root.path(), &[&pasted("image/svg+xml", PNG)]);
        assert!(read_image(&encode_image_id(&svg, 0, "0"), root.path()).is_err());
        let injected = write_transcript(root.path(), &[&pasted("image/png", "AAAA\\\"onerror=x")]);
        assert!(read_image(&encode_image_id(&injected, 0, "0"), root.path()).is_err());
    }

    #[test]
    fn a_stale_offset_or_block_is_an_error() {
        let root = transcript_dir();
        let p = write_transcript(root.path(), &[&pasted("image/png", PNG)]);
        assert!(read_image(&encode_image_id(&p, 5, "0"), root.path()).is_err());
        assert!(read_image(&encode_image_id(&p, 0, "9"), root.path()).is_err());
        assert!(read_image(&encode_image_id(&p, 0, "x.y"), root.path()).is_err());
    }

    #[test]
    fn facts_are_cached_until_the_file_changes() {
        let root = transcript_dir();
        let p = write_transcript(root.path(), &[r#"{"type":"user","message":{"content":"<command-name>/one</command-name>"}}"#]);
        let a = facts_for(&p).unwrap();
        let b = facts_for(&p).unwrap();
        assert!(Arc::ptr_eq(&a, &b), "unchanged file must hit the cache");
        std::fs::write(&p, r#"{"type":"user","message":{"content":"<command-name>/two</command-name>"}}"#).unwrap();
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        std::fs::File::options().write(true).open(&p).unwrap().set_modified(later).unwrap();
        let c = facts_for(&p).unwrap();
        assert_eq!(c.commands[0].0, "/two");
    }
}
