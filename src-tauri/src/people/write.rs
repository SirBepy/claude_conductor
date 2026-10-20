//! Writing to the vault: new person notes from the template, and one-line
//! frontmatter list edits that leave the rest of the note alone.

use super::frontmatter::{unquote, Frontmatter};
use super::{person_from, Person, PEOPLE_DIR};
use std::fs;
use std::path::Path;

const TEMPLATE: &str = "Templates/Person.md";

/// Mirrors the vault's `Templates/Person.md`, used only when that file is gone.
const FALLBACK_TEMPLATE: &str = "---\nname: \"\"\naliases: []\nbirthday: \nrelationship: \"\"\nlast_seen: \ngender: \nlanguage: \nmessaged_on: []\nprojects: []\nproject_aliases: []\ntags: [person]\n---\n\n# {{title}}\n\n## Notes\n\n";

/// Adds `value` to the list `key` in `People/<id>.md`'s frontmatter, editing
/// only that line (or appending one block item, or adding the key), so a
/// concurrent edit elsewhere in the note survives. Already present
/// (case-insensitive) is a no-op. Returns the person as re-read.
pub fn add_to_list_at(vault: &Path, id: &str, key: &str, value: &str) -> Result<Person, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("nothing to add to {key}"));
    }
    let path = vault.join(PEOPLE_DIR).join(format!("{id}.md"));
    let text = fs::read_to_string(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let current = person_from(id.to_string(), &text);
    let existing = Frontmatter::parse(&text).list(key);
    if existing.iter().any(|v| v.eq_ignore_ascii_case(value)) {
        return Ok(current);
    }
    let updated = with_list_item(&text, key, value).ok_or_else(|| format!("{} has no frontmatter", path.display()))?;
    fs::write(&path, &updated).map_err(|e| format!("writing {}: {e}", path.display()))?;
    Ok(person_from(id.to_string(), &updated))
}

/// `text` with `value` appended to frontmatter list `key`. `None` when the
/// note has no frontmatter block to put it in.
fn with_list_item(text: &str, key: &str, value: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.first().map(|l| l.trim()) != Some("---") {
        return None;
    }
    let close = lines.iter().skip(1).position(|l| l.trim() == "---")? + 1;
    let item = yaml_str(value);
    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    let at = (1..close).find(|&i| lines[i].split_once(':').map(|(k, _)| k.trim()) == Some(key));
    match at {
        Some(i) => {
            let rest = lines[i].split_once(':').map(|(_, v)| v.trim()).unwrap_or("");
            if let Some(inner) = rest.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
                let joined = if inner.trim().is_empty() { item } else { format!("{}, {item}", inner.trim()) };
                out[i] = format!("{key}: [{joined}]");
            } else if rest.is_empty() {
                // A block list (or an empty key): the item goes after its last `- ` line.
                let mut end = i + 1;
                while end < close && lines[end].trim().starts_with("- ") {
                    end += 1;
                }
                out.insert(end, format!("  - {item}"));
            } else {
                out[i] = format!("{key}: [{}, {item}]", yaml_str(&unquote(rest)));
            }
        }
        None => out.insert(close, format!("{key}: [{item}]")),
    }
    // `lines()` drops `\r`; a note saved with CRLF keeps CRLF, or every edit
    // would rewrite all its line endings.
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut joined = out.join(nl);
    if text.ends_with('\n') {
        joined.push_str(nl);
    }
    Some(joined)
}

/// What the new-person questionnaire collects, beyond the name.
#[derive(Default)]
pub struct NewPerson {
    pub aliases: Vec<String>,
    pub relationship: String,
    pub gender: String,
    pub language: String,
    pub messaged_on: Vec<String>,
    pub projects: Vec<String>,
}

/// Creates `<vault>/People/<name>.md` from the vault's Person template, with
/// name, aliases and relationship filled in. Never overwrites: a file that
/// already exists is read back and returned as-is.
pub fn create_at(vault: &Path, name: &str, fields: &NewPerson) -> Result<Person, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 100 || name.starts_with('.') || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(format!("not a usable file name for a person: {name:?}"));
    }
    let dir = vault.join(PEOPLE_DIR);
    if !dir.is_dir() {
        return Err(format!("no People folder in the vault at {}", vault.display()));
    }
    let path = dir.join(format!("{name}.md"));
    let template = fs::read_to_string(vault.join(TEMPLATE)).unwrap_or_else(|_| FALLBACK_TEMPLATE.to_string());
    let text = fill_template(&template, name, fields);
    match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut f) => {
            use std::io::Write;
            f.write_all(text.as_bytes()).map_err(|e| format!("writing {}: {e}", path.display()))?;
            Ok(person_from(name.to_string(), &text))
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Ok(person_from(name.to_string(), &fs::read_to_string(&path).unwrap_or_default()))
        }
        Err(e) => Err(format!("creating {}: {e}", path.display())),
    }
}

fn yaml_str(v: &str) -> String {
    format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
}

fn yaml_list(items: &[String]) -> String {
    let list: Vec<String> = items.iter().map(|a| a.trim()).filter(|a| !a.is_empty()).map(yaml_str).collect();
    format!("[{}]", list.join(", "))
}

/// Rewrites only the frontmatter keys this knows, line by line, so whatever
/// else the user's template carries survives untouched. A known key the
/// template lacks (an older template) is added before the closing `---`.
fn fill_template(template: &str, name: &str, f: &NewPerson) -> String {
    let scalar = |v: &str| (!v.trim().is_empty()).then(|| yaml_str(v.trim()));
    let list = |v: &[String]| (!v.is_empty()).then(|| yaml_list(v));
    let mut known: Vec<(&str, Option<String>)> = vec![
        ("name", Some(yaml_str(name))),
        ("aliases", Some(yaml_list(&f.aliases))),
        ("relationship", scalar(&f.relationship)),
        ("gender", scalar(&f.gender)),
        ("language", scalar(&f.language)),
        ("messaged_on", list(&f.messaged_on)),
        ("projects", list(&f.projects)),
    ];
    let mut in_frontmatter = false;
    let mut seen_open = false;
    let mut out = String::with_capacity(template.len() + 128);
    for line in template.lines() {
        if line.trim() == "---" {
            if in_frontmatter {
                for (key, value) in known.iter_mut() {
                    if let Some(v) = value.take() {
                        out.push_str(&format!("{key}: {v}\n"));
                    }
                }
            }
            in_frontmatter = !seen_open;
            seen_open = true;
            out.push_str(line);
            out.push('\n');
            continue;
        }
        let key = line.split_once(':').map(|(k, _)| k.trim());
        let slot = match (in_frontmatter, key) {
            (true, Some(k)) => known.iter_mut().find(|(name, _)| *name == k),
            _ => None,
        };
        let replaced = slot.and_then(|(key, value)| value.take().map(|v| format!("{key}: {v}")));
        out.push_str(&replaced.unwrap_or_else(|| line.replace("{{title}}", name)));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::people::test_support::{vault_with, STEVAN};

    #[test]
    fn adding_to_a_list_edits_one_line_and_keeps_the_rest() {
        let vault = vault_with(&[("Stevan", STEVAN)]);
        let p = add_to_list_at(vault.path(), "Stevan", "project_aliases", "revaire: api guy").unwrap();
        assert_eq!(p.project_aliases, vec!["zirtue: backend", "revaire: api guy"]);
        let again = add_to_list_at(vault.path(), "Stevan", "projects", "ZIRTUE").unwrap();
        assert_eq!(again.projects, vec!["zirtue"], "already there, case-insensitively");
        let text = fs::read_to_string(vault.path().join("People/Stevan.md")).unwrap();
        assert!(text.contains("tags: [person, work]") && text.ends_with("# Stevan\n"), "{text}");

        let block = vault_with(&[("Dani", "---\naliases:\n  - Dani\nrelationship: x\n---\nbody\n")]);
        assert_eq!(add_to_list_at(block.path(), "Dani", "aliases", "Donna").unwrap().aliases, vec!["Dani", "Donna"]);
        let missing = vault_with(&[("Old", "---\nname: Old\n---\nbody\n")]);
        assert_eq!(add_to_list_at(missing.path(), "Old", "projects", "zirtue").unwrap().projects, vec!["zirtue"]);
    }

    #[test]
    fn a_crlf_note_keeps_its_line_endings() {
        let vault = vault_with(&[("Win", "---\r\nname: Win\r\naliases: []\r\n---\r\nbody\r\n")]);
        add_to_list_at(vault.path(), "Win", "aliases", "W").unwrap();
        let text = fs::read_to_string(vault.path().join("People/Win.md")).unwrap();
        assert_eq!(text, "---\r\nname: Win\r\naliases: [\"W\"]\r\n---\r\nbody\r\n");
    }

    #[test]
    fn a_new_person_gets_every_answer_even_from_an_older_template() {
        let vault = vault_with(&[]);
        fs::create_dir_all(vault.path().join("Templates")).unwrap();
        fs::write(vault.path().join(TEMPLATE), "---\nname: \"\"\naliases: []\nrelationship: \"\"\ntags: [person]\n---\n\n# {{title}}\n").unwrap();
        let fields = NewPerson {
            aliases: vec!["Tea".into()],
            relationship: "coworker (Revaire QA)".into(),
            gender: "female".into(),
            language: "Croatian".into(),
            messaged_on: vec!["Slack".into()],
            projects: vec!["revaire".into()],
        };
        let p = create_at(vault.path(), "Tajana", &fields).unwrap();
        assert_eq!((p.gender.as_str(), p.language.as_str()), ("female", "Croatian"));
        assert_eq!(p.messaged_on, vec!["Slack"]);
        assert_eq!(p.projects, vec!["revaire"]);
        let text = fs::read_to_string(vault.path().join("People/Tajana.md")).unwrap();
        assert!(text.contains("tags: [person]\ngender: \"female\""), "added before the closing ---: {text}");
    }

    #[test]
    fn stub_fills_the_users_template_and_never_overwrites() {
        let vault = vault_with(&[]);
        fs::create_dir_all(vault.path().join("Templates")).unwrap();
        fs::write(
            vault.path().join(TEMPLATE),
            "---\nname: \"\"\naliases: []\nbirthday: \nrelationship: \"\"\ntags: [person]\n---\n\n# {{title}}\n\n## Gift Ideas\n",
        )
        .unwrap();
        let fields = NewPerson { aliases: vec!["Johanna".into()], relationship: "coworker".into(), ..Default::default() };
        let made = create_at(vault.path(), "Johanna Chen", &fields).unwrap();
        assert_eq!(made.id, "Johanna Chen");
        assert_eq!(made.aliases, vec!["Johanna"]);
        assert_eq!(made.relationship, "coworker");
        let text = fs::read_to_string(vault.path().join("People/Johanna Chen.md")).unwrap();
        assert!(text.contains("# Johanna Chen"), "{text}");
        assert!(text.contains("## Gift Ideas"), "template body kept: {text}");
        assert!(text.contains("tags: [person]"), "{text}");

        fs::write(vault.path().join("People/Johanna Chen.md"), "---\nrelationship: boss\n---\nmine").unwrap();
        let again = create_at(vault.path(), "Johanna Chen", &NewPerson { relationship: "coworker".into(), ..Default::default() }).unwrap();
        assert_eq!(again.relationship, "boss");
        assert!(fs::read_to_string(vault.path().join("People/Johanna Chen.md")).unwrap().ends_with("mine"));
    }

    #[test]
    fn stub_rejects_a_name_that_would_escape_the_people_folder() {
        let vault = vault_with(&[]);
        assert!(create_at(vault.path(), "../evil", &NewPerson::default()).is_err());
        assert!(create_at(vault.path(), "", &NewPerson::default()).is_err());
    }
}
