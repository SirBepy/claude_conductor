//! A deliberately narrow reader for Linear's GraphQL bodies. It is not a
//! general GraphQL parser: it answers only "is this a read, a single
//! variable-driven mutation, or something the broker will not classify".
//!
//! A write is allowed only in this shape, so the field name the policy row
//! pins (`commentCreate`, `issueCreate`, `issueUpdate`) is the field the
//! server runs and the ids the ownership check reads are the ids it acts on:
//!
//! ```text
//! mutation [Name] [($v: Type, ...)] { field(arg: $v, ...) { ...selection } }
//! ```
//!
//! One definition, one root field, no alias, no directive, and every argument
//! value a variable (a literal id in the query text would sit beside, and
//! could differ from, the variable the ownership check reads). Anything else
//! that is not a plain `query` is `Unsupported` and denied, because a document
//! the broker cannot classify could hide a mutation.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GqlKind {
    /// A query (or the `{ ... }` shorthand): read only by definition.
    Query,
    Mutation { field: String, args: Vec<(String, String)> },
    Unsupported(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct GqlRequest {
    pub kind: GqlKind,
    pub variables: Value,
}

impl GqlRequest {
    /// The variable a root-field argument is bound to, looked up in `variables`.
    pub fn arg_variable(&self, arg: &str) -> Option<&Value> {
        let GqlKind::Mutation { args, .. } = &self.kind else { return None };
        let var = &args.iter().find(|(a, _)| a == arg)?.1;
        self.variables.get(var)
    }
}

/// Reads a request body (`{ query, variables?, operationName? }`).
pub fn parse_body(body: &Value) -> Result<GqlRequest, String> {
    let obj = body.as_object().ok_or("Linear body must be a JSON object with a query string")?;
    if let Some(k) = obj.keys().find(|k| !matches!(k.as_str(), "query" | "variables" | "operationName")) {
        return Err(format!("Linear body key {k:?} is not allowed; send query, variables and operationName only"));
    }
    let query = obj.get("query").and_then(Value::as_str).ok_or("Linear body needs a query string")?;
    let variables = match obj.get("variables") {
        None | Some(Value::Null) => Value::Object(Default::default()),
        Some(v) if v.is_object() => v.clone(),
        Some(_) => return Err("Linear variables must be a JSON object".into()),
    };
    Ok(GqlRequest { kind: classify(query), variables })
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Name(String),
    Var(String),
    Punct(char),
    Literal,
}

fn lex(src: &str) -> Result<Vec<Tok>, String> {
    let c: Vec<char> = src.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    while i < c.len() {
        let ch = c[i];
        match ch {
            ' ' | '\t' | '\n' | '\r' | ',' | '\u{feff}' => i += 1,
            '#' => {
                while i < c.len() && c[i] != '\n' && c[i] != '\r' {
                    i += 1;
                }
            }
            '"' => {
                if c[i..].starts_with(&['"', '"', '"']) {
                    i += 3;
                    loop {
                        if i >= c.len() {
                            return Err("unterminated block string".into());
                        }
                        if c[i..].starts_with(&['\\', '"', '"', '"']) {
                            i += 4;
                        } else if c[i..].starts_with(&['"', '"', '"']) {
                            i += 3;
                            break;
                        } else {
                            i += 1;
                        }
                    }
                } else {
                    i += 1;
                    loop {
                        match c.get(i) {
                            None | Some('\n') => return Err("unterminated string".into()),
                            Some('\\') => i += 2,
                            Some('"') => {
                                i += 1;
                                break;
                            }
                            Some(_) => i += 1,
                        }
                    }
                }
                out.push(Tok::Literal);
            }
            '$' => {
                let start = i + 1;
                i = start;
                while i < c.len() && (c[i].is_ascii_alphanumeric() || c[i] == '_') {
                    i += 1;
                }
                if i == start {
                    return Err("bare $".into());
                }
                out.push(Tok::Var(c[start..i].iter().collect()));
            }
            '-' | '0'..='9' => {
                i += 1;
                while i < c.len() && (c[i].is_ascii_alphanumeric() || matches!(c[i], '.' | '+' | '-')) {
                    i += 1;
                }
                out.push(Tok::Literal);
            }
            'a'..='z' | 'A'..='Z' | '_' => {
                let start = i;
                while i < c.len() && (c[i].is_ascii_alphanumeric() || c[i] == '_') {
                    i += 1;
                }
                out.push(Tok::Name(c[start..i].iter().collect()));
            }
            '{' | '}' | '(' | ')' | '[' | ']' | ':' | '=' | '!' | '|' | '&' | '@' | '.' => {
                out.push(Tok::Punct(ch));
                i += 1;
            }
            other => return Err(format!("unexpected character {other:?}")),
        }
    }
    Ok(out)
}

/// Index of the token that closes the bracket opened at `open`, or None.
fn matching(toks: &[Tok], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (i, t) in toks.iter().enumerate().skip(open) {
        match t {
            Tok::Punct('{' | '(' | '[') => depth += 1,
            Tok::Punct('}' | ')' | ']') => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

pub fn classify(query: &str) -> GqlKind {
    match classify_inner(query) {
        Ok(k) => k,
        Err(why) => GqlKind::Unsupported(why),
    }
}

fn classify_inner(query: &str) -> Result<GqlKind, String> {
    let toks = lex(query)?;
    let mut i = 0;
    let is_mutation = match toks.first() {
        Some(Tok::Punct('{')) => false,
        Some(Tok::Name(n)) if n == "query" => false,
        Some(Tok::Name(n)) if n == "mutation" => true,
        Some(Tok::Name(n)) => return Err(format!("{n} documents are not supported; send one query or one mutation")),
        _ => return Err("empty or unreadable document".into()),
    };
    if !matches!(toks.first(), Some(Tok::Punct('{'))) {
        i += 1;
        if matches!(toks.get(i), Some(Tok::Name(_))) {
            i += 1;
        }
        if toks.get(i) == Some(&Tok::Punct('(')) {
            i = matching(&toks, i).ok_or("unbalanced variable definitions")? + 1;
        }
        if toks.get(i) == Some(&Tok::Punct('@')) {
            return Err("directives on an operation are not supported".into());
        }
    }
    if toks.get(i) != Some(&Tok::Punct('{')) {
        return Err("expected a selection set".into());
    }
    let close = matching(&toks, i).ok_or("unbalanced braces")?;
    if close + 1 != toks.len() {
        return Err("send one operation per call; fragments and extra definitions are not supported".into());
    }
    if !is_mutation {
        return Ok(GqlKind::Query);
    }
    root_field(&toks[i + 1..close])
}

/// The single root field of a mutation, with its variable-only arguments.
fn root_field(sel: &[Tok]) -> Result<GqlKind, String> {
    let Some(Tok::Name(field)) = sel.first() else { return Err("a mutation must start with its field name".into()) };
    let mut i = 1;
    if sel.get(i) == Some(&Tok::Punct(':')) {
        return Err("aliases are not supported on a mutation".into());
    }
    let mut args = Vec::new();
    if sel.get(i) == Some(&Tok::Punct('(')) {
        let end = matching(sel, i).ok_or("unbalanced arguments")?;
        let inner = &sel[i + 1..end];
        let mut j = 0;
        while j < inner.len() {
            match (&inner[j], inner.get(j + 1), inner.get(j + 2)) {
                (Tok::Name(a), Some(Tok::Punct(':')), Some(Tok::Var(v))) => {
                    args.push((a.clone(), v.clone()));
                    j += 3;
                }
                _ => return Err("every mutation argument must be a variable ($name); pass ids and input through variables".into()),
            }
        }
        i = end + 1;
    }
    if sel.get(i) == Some(&Tok::Punct('@')) {
        return Err("directives on a mutation field are not supported".into());
    }
    if sel.get(i) == Some(&Tok::Punct('{')) {
        i = matching(sel, i).ok_or("unbalanced selection")? + 1;
    }
    if i != sel.len() {
        return Err("exactly one mutation field per call".into());
    }
    Ok(GqlKind::Mutation { field: field.clone(), args })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn m(field: &str, args: &[(&str, &str)]) -> GqlKind {
        GqlKind::Mutation { field: field.into(), args: args.iter().map(|(a, v)| (a.to_string(), v.to_string())).collect() }
    }

    #[test]
    fn queries_and_shorthand_are_reads() {
        assert_eq!(classify("{ viewer { id } }"), GqlKind::Query);
        assert_eq!(classify("query Me { viewer { id name } }"), GqlKind::Query);
        assert_eq!(classify("query($id: String!) { issue(id: $id) { identifier } }"), GqlKind::Query);
        assert_eq!(classify("# note\nquery { teams { nodes { key } } }"), GqlKind::Query);
    }

    #[test]
    fn a_variable_driven_single_field_mutation_is_named() {
        let q = "mutation C($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }";
        assert_eq!(classify(q), m("commentCreate", &[("input", "input")]));
        let q = "mutation U($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success } }";
        assert_eq!(classify(q), m("issueUpdate", &[("id", "id"), ("input", "i")]));
        assert_eq!(classify("mutation { issueCreate(input: $in) { success } }"), m("issueCreate", &[("input", "in")]));
    }

    #[test]
    fn literals_aliases_extra_fields_fragments_and_subscriptions_are_unsupported() {
        for q in [
            r#"mutation { commentCreate(input: {issueId: "X", body: "hi"}) { success } }"#,
            r#"mutation($i: CommentCreateInput!) { commentCreate(input: $i, extra: "x") { success } }"#,
            "mutation($i: I!) { a: commentCreate(input: $i) { success } }",
            "mutation($i: I!) { commentCreate(input: $i) { success } issueDelete(id: $d) { success } }",
            "mutation($i: I!) { commentCreate(input: $i) { success } } query { viewer { id } }",
            "mutation($i: I!) { commentCreate(input: $i) { ...F } } fragment F on Comment { id }",
            "subscription { issueCreated { id } }",
            "mutation($i: I!) @skip(if: true) { commentCreate(input: $i) { success } }",
            "mutation($i: I!) { commentCreate(input: $i) @include(if: true) { success } }",
            "fragment F on Issue { id }",
            "",
            "mutation",
            "mutation { issueUpdate(id: $id input: $i) { success }",
        ] {
            assert!(matches!(classify(q), GqlKind::Unsupported(_)), "{q:?} should be unsupported, got {:?}", classify(q));
        }
    }

    #[test]
    fn a_mutation_word_inside_a_string_or_comment_does_not_change_the_kind() {
        assert_eq!(classify(r#"query { issueSearch(query: "mutation { x }") { nodes { id } } }"#), GqlKind::Query);
        assert_eq!(classify("# mutation { issueDelete }\n{ viewer { id } }"), GqlKind::Query);
        // The reverse: a comment cannot hide a second field.
        let q = "mutation($i: I!) { commentCreate(input: $i) { success } # issueDelete(id: $d)\n }";
        assert_eq!(classify(q), m("commentCreate", &[("input", "i")]));
    }

    #[test]
    fn parse_body_reads_variables_and_rejects_stray_keys() {
        let body = json!({
            "query": "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
            "variables": { "input": { "issueId": "MOB-1", "body": "hi" } }
        });
        let r = parse_body(&body).unwrap();
        assert_eq!(r.arg_variable("input").unwrap()["issueId"], "MOB-1");
        assert!(r.arg_variable("id").is_none());
        assert!(parse_body(&json!({"query": "{ viewer { id } }", "extensions": {}})).is_err());
        assert!(parse_body(&json!({"variables": {}})).is_err());
        assert!(parse_body(&json!({"query": "{ a }", "variables": [1]})).is_err());
        assert!(parse_body(&json!("query")).is_err());
    }

    #[test]
    fn an_unreadable_character_is_unsupported_not_a_panic() {
        assert!(matches!(classify("query { a }\u{0}"), GqlKind::Unsupported(_)));
        assert!(matches!(classify("mutation { a(b: \"unterminated) }"), GqlKind::Unsupported(_)));
    }
}
