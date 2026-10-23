//! Backs the `{{last_run:/name}}` template: which command names a card asks
//! about, and the latest run time of each across a set of scanned transcripts.
//! The scan itself (and its per-file cache) is `history_scan::facts_for`; this
//! only reduces its output, so it stays pure.

use super::history_scan::TranscriptFacts;
use super::template::last_run_names;
use super::types::{CardConfig, CardSource};
use std::collections::HashMap;

/// Distinct `{{last_run:...}}` names across every templated field of the card.
pub fn card_last_run_names(card: &CardConfig) -> Vec<String> {
    let mut fields: Vec<&str> = Vec::new();
    match &card.source {
        CardSource::Http { url, headers, body, .. } => {
            fields.push(url);
            fields.extend(headers.values().map(String::as_str));
            fields.extend(body.as_deref());
        }
        CardSource::Command { args, cwd, env, .. } => {
            fields.extend(args.iter().map(String::as_str));
            fields.extend(cwd.as_deref());
            fields.extend(env.values().map(String::as_str));
        }
    }
    let mut names: Vec<String> = Vec::new();
    for f in fields {
        for n in last_run_names(f) {
            if !names.contains(&n) {
                names.push(n);
            }
        }
    }
    names
}

/// For each of `names`, the newest invocation time over all `facts`. A name
/// that never ran is absent from the map (rendering turns that into 0).
pub fn latest_runs(facts: &[&TranscriptFacts], names: &[String]) -> HashMap<String, i64> {
    let mut out: HashMap<String, i64> = HashMap::new();
    for f in facts {
        for (cmd, at_ms) in &f.commands {
            if names.contains(cmd) {
                let slot = out.entry(cmd.clone()).or_insert(*at_ms);
                *slot = (*slot).max(*at_ms);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn facts(commands: &[(&str, i64)]) -> TranscriptFacts {
        TranscriptFacts { commands: commands.iter().map(|(c, t)| (c.to_string(), *t)).collect(), ..Default::default() }
    }

    #[test]
    fn the_newest_run_wins_across_transcripts() {
        let a = facts(&[("/sync", 100), ("/sync", 300), ("/other", 999)]);
        let b = facts(&[("/sync", 200)]);
        let got = latest_runs(&[&a, &b], &["/sync".to_string()]);
        assert_eq!(got.get("/sync"), Some(&300));
        assert!(!got.contains_key("/other"), "only the asked-for names");
    }

    #[test]
    fn a_command_that_never_ran_is_absent() {
        let a = facts(&[("/x", 1)]);
        assert!(latest_runs(&[&a], &["/sync".to_string()]).is_empty());
        assert!(latest_runs(&[], &["/sync".to_string()]).is_empty());
    }

    #[test]
    fn names_are_collected_from_every_templated_field() {
        let card = CardConfig {
            source: CardSource::Command {
                program: "node".into(),
                args: vec!["a.js".into(), "--since={{last_run:/sync}}".into()],
                cwd: None,
                env: BTreeMap::from([("SINCE".to_string(), "{{last_run:/commit}}".to_string())]),
            },
            ..Default::default()
        };
        assert_eq!(card_last_run_names(&card), ["/sync", "/commit"]);
        let http = CardConfig {
            source: CardSource::Http {
                method: "GET".into(),
                url: "https://x/?s={{last_run:/sync}}".into(),
                headers: BTreeMap::from([("H".to_string(), "{{last_run:/sync}}".to_string())]),
                body: Some("{{last_run:/body}}".into()),
            },
            ..Default::default()
        };
        assert_eq!(card_last_run_names(&http), ["/sync", "/body"]);
        assert!(card_last_run_names(&CardConfig::default()).is_empty());
    }
}
