use super::*;

// ---- file format ----------------------------------------------------------

pub(super) fn put_field(out: &mut String, label: &str, text: &str) {
    let mut lines = text.split('\n');
    out.push_str(label);
    out.push_str(": ");
    out.push_str(lines.next().unwrap_or(""));
    out.push('\n');
    for line in lines {
        out.push_str("  ");
        out.push_str(line);
        out.push('\n');
    }
}

pub(super) fn render_entry(e: &Entry, out: &mut String) {
    out.push_str(&format!("\n## D{} - {} - {} - {}\n", e.id, e.kind.source(), e.date, e.who));
    if let Some(sub) = &e.sub {
        put_field(out, "Sub", sub);
    }
    if let Some(q) = &e.question {
        put_field(out, "Question", q);
    }
    put_field(out, e.kind.label(), &e.body);
    if !e.replaces.is_empty() {
        let ids: Vec<String> = e.replaces.iter().map(|i| format!("D{i}")).collect();
        put_field(out, "Replaces", &ids.join(", "));
    }
    if let Some(c) = e.closed_by {
        put_field(out, "Closed by", &format!("D{c}"));
    }
}

pub fn render(entries: &[Entry]) -> String {
    let mut out = String::from(FILE_HEADER);
    for e in entries {
        render_entry(e, &mut out);
    }
    out
}

pub(super) fn label_value<'a>(line: &'a str, label: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(label)?.strip_prefix(':')?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

pub(super) fn parse_id_list(text: &str) -> Vec<u32> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter_map(|t| t.strip_prefix(['D', 'd']).and_then(|n| n.parse().ok()))
        .collect()
}

/// `## D12 - card - 2026-11-05 - header sub` into its parts. The name is last
/// so it may itself contain " - ".
pub(super) fn parse_heading(line: &str) -> Option<(u32, &str, &str, &str)> {
    let rest = line.strip_prefix("## D")?;
    let mut parts = rest.splitn(4, " - ");
    let id = parts.next()?.parse().ok()?;
    Some((id, parts.next()?, parts.next()?, parts.next()?))
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Field {
    Question,
    Body,
    Replaces,
    Closed,
}

pub fn parse(text: &str) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::new();
    let mut cur: Option<(Entry, Option<Field>, bool)> = None;
    let flush = |cur: &mut Option<(Entry, Option<Field>, bool)>, out: &mut Vec<Entry>| {
        if let Some((e, _, has_body)) = cur.take() {
            if has_body {
                out.push(e);
            }
        }
    };
    for raw in text.lines() {
        let line = raw.trim_end_matches('\r');
        if let Some((id, source, date, who)) = parse_heading(line) {
            flush(&mut cur, &mut out);
            // The kind is settled by the body label below; `card` is the only
            // source that is not `finish`.
            let kind = if source == "card" { Kind::Card } else { Kind::Decided };
            cur = Some((
                Entry {
                    id,
                    kind,
                    date: date.to_string(),
                    who: who.to_string(),
                    sub: None,
                    question: None,
                    body: String::new(),
                    replaces: Vec::new(),
                    closed_by: None,
                },
                None,
                false,
            ));
            continue;
        }
        let Some((e, field, has_body)) = cur.as_mut() else { continue };
        if let Some(cont) = line.strip_prefix("  ") {
            match field {
                Some(Field::Question) => {
                    let q = e.question.get_or_insert_with(String::new);
                    q.push('\n');
                    q.push_str(cont);
                }
                Some(Field::Body) => {
                    e.body.push('\n');
                    e.body.push_str(cont);
                }
                _ => {}
            }
            continue;
        }
        if let Some(v) = label_value(line, "Sub") {
            e.sub = Some(v.trim().to_string()).filter(|s| !s.is_empty());
            *field = None;
        } else if let Some(v) = label_value(line, "Question") {
            e.question = Some(v.to_string());
            *field = Some(Field::Question);
        } else if let Some(v) = label_value(line, "Answer") {
            e.kind = Kind::Card;
            e.body = v.to_string();
            *field = Some(Field::Body);
            *has_body = true;
        } else if let Some(v) = label_value(line, "Decided") {
            e.kind = Kind::Decided;
            e.body = v.to_string();
            *field = Some(Field::Body);
            *has_body = true;
        } else if let Some(v) = label_value(line, "Ruled out") {
            e.kind = Kind::RuledOut;
            e.body = v.to_string();
            *field = Some(Field::Body);
            *has_body = true;
        } else if let Some(v) = label_value(line, "Replaces") {
            e.replaces = parse_id_list(v);
            *field = Some(Field::Replaces);
        } else if let Some(v) = label_value(line, "Closed by") {
            e.closed_by = parse_id_list(v).first().copied();
            *field = Some(Field::Closed);
        } else {
            *field = None;
        }
    }
    flush(&mut cur, &mut out);
    out
}
