//! Matching spoken or typed names against the people in a vault.

use super::Person;

/// Lowercased, a trailing `(...)` dropped: "Tajana (Linear comment on REV-7345)"
/// is still Tajana.
fn norm(text: &str) -> String {
    let t = text.trim();
    let t = match (t.rfind('('), t.ends_with(')')) {
        (Some(i), true) if i > 0 => &t[..i],
        _ => t,
    };
    t.trim().to_lowercase()
}

fn first_word(text: &str) -> &str {
    text.split_whitespace().next().unwrap_or("")
}

#[derive(Debug, PartialEq)]
pub enum Resolved<'a> {
    One(&'a Person),
    Ambiguous(Vec<&'a Person>),
    None,
}

/// Matches `text` against every id, name and alias. An exact hit wins; a bare
/// first name ("Johanna") falls back to a first-word match, and only counts
/// when exactly one person has that first word.
pub fn resolve<'a>(people: &'a [Person], text: &str) -> Resolved<'a> {
    resolve_in(people, text, None)
}

/// `resolve`, also matching the names people go by inside `client` only
/// ("backend" for Stevan in zirtue).
pub fn resolve_in<'a>(people: &'a [Person], text: &str, client: Option<&'a str>) -> Resolved<'a> {
    let wanted = norm(text);
    if wanted.is_empty() {
        return Resolved::None;
    }
    let names = |p: &'a Person| {
        std::iter::once(p.id.as_str())
            .chain(std::iter::once(p.name.as_str()))
            .chain(p.aliases.iter().map(String::as_str))
            .chain(client.into_iter().flat_map(move |c| p.aliases_in(c)))
    };
    let exact: Vec<&Person> = people.iter().filter(|p| names(p).any(|n| norm(n) == wanted)).collect();
    if let [one] = exact.as_slice() {
        return Resolved::One(one);
    }
    if exact.len() > 1 {
        return Resolved::Ambiguous(exact);
    }
    if wanted.split_whitespace().count() != 1 {
        return Resolved::None;
    }
    let by_first: Vec<&Person> =
        people.iter().filter(|p| names(p).any(|n| first_word(&norm(n)) == wanted)).collect();
    match by_first.len() {
        0 => Resolved::None,
        1 => Resolved::One(by_first[0]),
        _ => Resolved::Ambiguous(by_first),
    }
}

/// People whose name or alias is within two letters of `text` ("Stefan" for
/// Stevan): the suggestions for a name nobody matches, since a voice mishear
/// is the common way a known person comes in unrecognised.
pub fn similar<'a>(people: &'a [Person], text: &str) -> Vec<&'a Person> {
    let wanted = norm(text);
    if wanted.chars().count() < 3 {
        return Vec::new();
    }
    let close = |n: &str| {
        let n = norm(n);
        edit_distance(&n, &wanted) <= 2 || edit_distance(first_word(&n), &wanted) <= 2
    };
    people
        .iter()
        .filter(|p| close(&p.id) || close(&p.name) || p.aliases.iter().any(|a| close(a)))
        .collect()
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cur = row[j + 1];
            row[j + 1] = if ca == *cb { prev } else { 1 + prev.min(cur).min(row[j]) };
            prev = cur;
        }
    }
    row[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::people::person_from;
    use crate::people::test_support::{person, STEVAN};

    #[test]
    fn a_client_nickname_resolves_only_inside_that_client() {
        let people = vec![person_from("Stevan".into(), STEVAN), person("Lenar Rakhmatulin", &["Lenar"])];
        assert_eq!(resolve_in(&people, "backend", Some("zirtue")), Resolved::One(&people[0]));
        assert_eq!(resolve_in(&people, "backend", Some("revaire")), Resolved::None);
        assert_eq!(resolve(&people, "backend"), Resolved::None);
    }

    #[test]
    fn a_mishear_suggests_the_close_name() {
        let people = vec![person("Stevan", &[]), person("Lenar Rakhmatulin", &["Lenar"]), person("Tajana", &[])];
        let hits: Vec<&str> = similar(&people, "Stefan").iter().map(|p| p.id.as_str()).collect();
        assert_eq!(hits, vec!["Stevan"]);
        assert!(similar(&people, "Jo").is_empty(), "too short to guess from");
    }

    #[test]
    fn resolve_matches_alias_and_strips_a_trailing_parenthetical() {
        let people = vec![person("Bruno Kecman", &["Nuno"]), person("Tajana", &[])];
        assert_eq!(resolve(&people, "nuno"), Resolved::One(&people[0]));
        assert_eq!(resolve(&people, "Tajana (Linear comment on REV-7345)"), Resolved::One(&people[1]));
    }

    #[test]
    fn a_bare_first_name_resolves_only_when_unique() {
        let people = vec![person("Johanna Chen", &[]), person("Storm Theobald", &[]), person("Storm's Mom", &[])];
        assert_eq!(resolve(&people, "Johanna"), Resolved::One(&people[0]));
        assert_eq!(resolve(&people, "Bruno"), Resolved::None);
        let two = vec![person("Jon Kojakovic", &[]), person("Jon Snow", &[])];
        assert!(matches!(resolve(&two, "Jon"), Resolved::Ambiguous(v) if v.len() == 2));
    }
}
