//! The small YAML-frontmatter subset the vault's notes use.

/// Every `key: value` in a note's frontmatter, in order. A key with an empty
/// value followed by `- item` lines is a block list.
#[derive(Default)]
pub(super) struct Frontmatter {
    entries: Vec<(String, FmValue)>,
}

enum FmValue {
    Scalar(String),
    List(Vec<String>),
}

impl Frontmatter {
    /// The YAML subset the Person template uses: `key: value`, an inline
    /// `[a, "b"]` list, or a block list of `- a` lines under an empty key.
    pub(super) fn parse(text: &str) -> Self {
        let mut out = Frontmatter::default();
        let mut lines = text.lines();
        if lines.next().map(str::trim) != Some("---") {
            return out;
        }
        for line in lines {
            if line.trim() == "---" {
                break;
            }
            if let Some(item) = line.trim().strip_prefix("- ") {
                if let Some((_, value)) = out.entries.last_mut() {
                    if let FmValue::Scalar(s) = value {
                        if s.is_empty() {
                            *value = FmValue::List(Vec::new());
                        }
                    }
                    if let FmValue::List(items) = value {
                        push_nonempty(items, item);
                    }
                }
                continue;
            }
            let Some((key, value)) = line.split_once(':') else { continue };
            let value = value.trim();
            let parsed = match value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
                Some(inner) => {
                    let mut items = Vec::new();
                    for item in inner.split(',') {
                        push_nonempty(&mut items, item);
                    }
                    FmValue::List(items)
                }
                None => FmValue::Scalar(unquote(value)),
            };
            out.entries.push((key.trim().to_string(), parsed));
        }
        out
    }

    pub(super) fn scalar(&self, key: &str) -> String {
        match self.entries.iter().find(|(k, _)| k == key) {
            Some((_, FmValue::Scalar(s))) => s.clone(),
            _ => String::new(),
        }
    }

    pub(super) fn list(&self, key: &str) -> Vec<String> {
        match self.entries.iter().find(|(k, _)| k == key) {
            Some((_, FmValue::List(items))) => items.clone(),
            _ => Vec::new(),
        }
    }
}

fn push_nonempty(list: &mut Vec<String>, raw: &str) {
    let v = unquote(raw.trim());
    if !v.is_empty() {
        list.push(v);
    }
}

pub(super) fn unquote(v: &str) -> String {
    let v = v.trim();
    let stripped = v
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')));
    stripped.unwrap_or(v).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_reads_inline_and_block_alias_lists() {
        let inline = Frontmatter::parse("---\nname: Bruno Kecman\naliases: [Bruno, \"Nuno\"]\nrelationship: friend\n---\n# x");
        assert_eq!(inline.scalar("name"), "Bruno Kecman");
        assert_eq!(inline.list("aliases"), vec!["Bruno", "Nuno"]);
        assert_eq!(inline.scalar("relationship"), "friend");
        let block = Frontmatter::parse("---\naliases:\n  - Dani\n  - 'Donna'\nrelationship: \"\"\n---\n");
        assert_eq!(block.list("aliases"), vec!["Dani", "Donna"]);
        assert_eq!(block.scalar("relationship"), "");
    }
}
