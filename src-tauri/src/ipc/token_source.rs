use crate::state::AppState;
use tauri::State;

fn source_label(kind: Option<crate::sessions::kinds::InstanceKind>) -> &'static str {
    use crate::sessions::kinds::InstanceKind;
    match kind {
        Some(InstanceKind::Interactive) => "interactive",
        Some(InstanceKind::Automated) => "automated",
        Some(InstanceKind::External) => "external",
        None => "unknown",
    }
}

/// Sums the persisted token history by session `kind` (Interactive CLI vs
/// Automated/External app-hosted chats) so the dashboard can compare tokens
/// burned per source. Rows with no `kind` (written before this field existed)
/// land in "unknown" rather than being guessed at.
#[tauri::command]
pub fn token_stats_by_source(state: State<AppState>) -> serde_json::Value {
    let history = {
        let mgr = state.db.lock().unwrap();
        crate::storage::token_store::get_token_records(mgr.conn(), 0).unwrap_or_default()
    };
    serde_json::json!({ "buckets": aggregate_by_source(&history) })
}

/// `history` must arrive newest-first, as `get_token_records` returns it.
fn aggregate_by_source(history: &[crate::tokens::TokenRecord]) -> Vec<serde_json::Value> {
    let order = ["interactive", "automated", "external", "unknown"];
    let mut sessions = std::collections::HashMap::new();
    let mut tokens = std::collections::HashMap::new();
    let mut turns = std::collections::HashMap::new();

    // token_records is append-only and the startup backfill re-inserts a row per
    // session every boot (185k rows / 1.8k sessions on the dev machine), so raw
    // sums over-counted tokens ~658x and reported the row count as "sessions".
    // Newest-first means first-wins per session_id is that session's latest row.
    let mut seen = std::collections::HashSet::new();
    for r in history.iter().filter(|r| seen.insert(r.session_id.as_str())) {
        let key = source_label(r.kind);
        *sessions.entry(key).or_insert(0u64) += 1;
        *tokens.entry(key).or_insert(0u64) +=
            r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens;
        *turns.entry(key).or_insert(0u64) += r.turns;
    }

    order.iter().map(|&key| {
        let s = *sessions.get(key).unwrap_or(&0);
        let t = *tokens.get(key).unwrap_or(&0);
        let tu = *turns.get(key).unwrap_or(&0);
        let avg = if tu > 0 { t as f64 / tu as f64 } else { 0.0 };
        serde_json::json!({
            "kind": key,
            "sessions": s,
            "tokens": t,
            "turns": tu,
            "avgTokensPerTurn": avg,
        })
    }).collect()
}

#[cfg(test)]
mod token_source_tests {
    use super::*;
    use crate::sessions::kinds::InstanceKind;
    use crate::tokens::TokenRecord;

    fn rec(session_id: &str, tokens: u64, turns: u64, kind: Option<InstanceKind>) -> TokenRecord {
        TokenRecord {
            session_id: session_id.into(),
            cwd: None,
            date: "2026-08-12".into(),
            input_tokens: tokens,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            turns,
            started_at: "2026-08-12T00:00:00Z".into(),
            last_active_at: "2026-08-12T00:00:00Z".into(),
            recorded_at: "2026-08-12T00:00:00Z".into(),
            live: None,
            merged_subagents: None,
            kind,
        }
    }

    fn bucket<'a>(buckets: &'a [serde_json::Value], kind: &str) -> &'a serde_json::Value {
        buckets.iter().find(|b| b["kind"] == kind).expect("bucket present")
    }

    #[test]
    fn counts_each_session_once_despite_duplicate_rows() {
        // The backfill re-inserts the same session on every boot; newest row first.
        let history = vec![
            rec("a", 500, 5, None),
            rec("a", 400, 4, None),
            rec("a", 300, 3, None),
            rec("b", 100, 1, None),
        ];
        let out = aggregate_by_source(&history);
        let unknown = bucket(&out, "unknown");
        assert_eq!(unknown["sessions"], 2, "two distinct sessions, not four rows");
        assert_eq!(unknown["tokens"], 600, "newest row per session only");
        assert_eq!(unknown["turns"], 6);
    }

    #[test]
    fn buckets_split_by_kind_and_legacy_rows_stay_unknown() {
        let history = vec![
            rec("a", 100, 1, Some(InstanceKind::Interactive)),
            rec("b", 200, 2, Some(InstanceKind::Automated)),
            rec("c", 300, 3, Some(InstanceKind::External)),
            rec("d", 400, 4, None),
        ];
        let out = aggregate_by_source(&history);
        assert_eq!(bucket(&out, "interactive")["tokens"], 100);
        assert_eq!(bucket(&out, "automated")["tokens"], 200);
        assert_eq!(bucket(&out, "external")["tokens"], 300);
        assert_eq!(bucket(&out, "unknown")["tokens"], 400);
    }

    #[test]
    fn empty_history_yields_four_zero_buckets() {
        let out = aggregate_by_source(&[]);
        assert_eq!(out.len(), 4);
        for b in &out {
            assert_eq!(b["sessions"], 0);
            assert_eq!(b["avgTokensPerTurn"], 0.0);
        }
    }
}
