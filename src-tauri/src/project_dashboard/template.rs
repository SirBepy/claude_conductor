//! `{{...}}` substitution for card URLs, headers, bodies and command args.
//!
//! Supported: `{{secret:NAME}}` (from `~/.claude/.env`), `{{cwd}}`, `{{repo}}`
//! (folder name of the cwd), `{{today}}`, `{{week_start}}` (Monday, ISO date),
//! `{{now_iso}}`. Anything else is an error rather than passed through: a
//! typo'd placeholder sent to a third-party API is worse than a card error.

use chrono::{Datelike, Local, SecondsFormat, Utc};

/// A secret lookup. Injected so tests never read the real `.env`. `Sync` so a
/// `run_card` future holding one is `Send` (daemon RPC handlers require it).
pub type SecretLookup<'a> = &'a (dyn Fn(&str) -> Option<String> + Sync);

/// Values behind the non-secret placeholders, captured once per card run.
#[derive(Clone, Debug, PartialEq)]
pub struct TemplateCtx {
    pub cwd: String,
    pub repo: String,
    pub today: String,
    pub week_start: String,
    pub now_iso: String,
}

impl TemplateCtx {
    pub fn for_cwd(cwd: &str) -> Self {
        Self::at(cwd, Local::now())
    }

    /// `now` is the dev's local clock: "today" and "this week" mean their
    /// calendar, not UTC's.
    pub fn at(cwd: &str, now: chrono::DateTime<Local>) -> Self {
        let date = now.date_naive();
        let monday = date - chrono::Duration::days(date.weekday().num_days_from_monday() as i64);
        TemplateCtx {
            cwd: cwd.to_string(),
            repo: cwd.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("").to_string(),
            today: date.format("%Y-%m-%d").to_string(),
            week_start: monday.format("%Y-%m-%d").to_string(),
            now_iso: now.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Secs, true),
        }
    }
}

/// Reads one secret from `~/.claude/.env`.
pub fn env_secret(name: &str) -> Option<String> {
    let path = dirs::home_dir()?.join(".claude").join(".env");
    crate::env_file::read_value(&std::fs::read_to_string(path).ok()?, name)
}

pub fn render(template: &str, ctx: &TemplateCtx, secrets: SecretLookup) -> Result<String, String> {
    render_collect(template, ctx, secrets, &mut Vec::new())
}

/// `render`, also pushing every resolved secret VALUE onto `used` so the caller
/// can scrub them out of anything it later reports.
pub fn render_collect(
    template: &str,
    ctx: &TemplateCtx,
    secrets: SecretLookup,
    used: &mut Vec<String>,
) -> Result<String, String> {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after.find("}}").ok_or_else(|| "unclosed {{ in template".to_string())?;
        let key = after[..end].trim();
        match key {
            "cwd" => out.push_str(&ctx.cwd),
            "repo" => out.push_str(&ctx.repo),
            "today" => out.push_str(&ctx.today),
            "week_start" => out.push_str(&ctx.week_start),
            "now_iso" => out.push_str(&ctx.now_iso),
            _ => match key.strip_prefix("secret:") {
                Some(name) => {
                    let name = name.trim();
                    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                        return Err(format!("invalid secret name {name:?}"));
                    }
                    let value = secrets(name)
                        .filter(|v| !v.is_empty())
                        .ok_or_else(|| format!("secret {name} is not set in ~/.claude/.env"))?;
                    out.push_str(&value);
                    used.push(value);
                }
                None => return Err(format!("unknown placeholder {{{{{key}}}}}")),
            },
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Replaces every used secret value (raw and URL-encoded, since a query
/// string echoes the encoded form) with `***`.
pub fn redact(text: &str, used: &[String]) -> String {
    let mut out = text.to_string();
    for secret in used.iter().filter(|s| !s.is_empty()) {
        out = out.replace(secret.as_str(), "***");
        let encoded: String = url::form_urlencoded::byte_serialize(secret.as_bytes()).collect();
        if encoded != *secret {
            out = out.replace(&encoded, "***");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn ctx() -> TemplateCtx {
        // Thursday 2026-10-22
        TemplateCtx::at("C:\\Work\\zng-app\\", Local.with_ymd_and_hms(2026, 10, 22, 15, 30, 0).unwrap())
    }

    fn lookup(name: &str) -> Option<String> {
        match name {
            "TOKEN" => Some("s3cr3t/+value".to_string()),
            "EMPTY" => Some(String::new()),
            _ => None,
        }
    }

    #[test]
    fn ctx_derives_repo_today_and_monday() {
        let c = ctx();
        assert_eq!(c.repo, "zng-app");
        assert_eq!(c.today, "2026-10-22");
        assert_eq!(c.week_start, "2026-10-19");
        assert!(c.now_iso.ends_with('Z') && c.now_iso.len() == 20, "{}", c.now_iso);
    }

    #[test]
    fn monday_and_sunday_belong_to_their_own_weeks() {
        let mon = TemplateCtx::at("/a/b", Local.with_ymd_and_hms(2026, 10, 19, 0, 5, 0).unwrap());
        assert_eq!(mon.week_start, "2026-10-19");
        let sun = TemplateCtx::at("/a/b", Local.with_ymd_and_hms(2026, 10, 25, 23, 5, 0).unwrap());
        assert_eq!(sun.week_start, "2026-10-19");
        assert_eq!(sun.repo, "b");
    }

    #[test]
    fn renders_all_placeholders() {
        let out = render("{{cwd}}|{{repo}}|{{today}}|{{week_start}}|{{ now_iso }}", &ctx(), &lookup).unwrap();
        let parts: Vec<_> = out.split('|').collect();
        assert_eq!(&parts[..4], &["C:\\Work\\zng-app\\", "zng-app", "2026-10-22", "2026-10-19"]);
        assert!(parts[4].starts_with("2026-10-2"));
    }

    #[test]
    fn secrets_resolve_and_are_collected() {
        let mut used = Vec::new();
        let out = render_collect("Bearer {{secret:TOKEN}} x {{secret: TOKEN }}", &ctx(), &lookup, &mut used).unwrap();
        assert_eq!(out, "Bearer s3cr3t/+value x s3cr3t/+value");
        assert_eq!(used.len(), 2);
    }

    #[test]
    fn missing_or_empty_secret_names_the_secret_never_a_value() {
        let err = render("a {{secret:NOPE}}", &ctx(), &lookup).unwrap_err();
        assert!(err.contains("NOPE"), "{err}");
        assert!(render("{{secret:EMPTY}}", &ctx(), &lookup).is_err());
    }

    #[test]
    fn bad_templates_are_errors() {
        assert!(render("{{nope}}", &ctx(), &lookup).unwrap_err().contains("nope"));
        assert!(render("{{secret:}}", &ctx(), &lookup).is_err());
        assert!(render("{{secret:a b}}", &ctx(), &lookup).is_err());
        assert!(render("{{secret:../x}}", &ctx(), &lookup).is_err());
        assert!(render("oops {{cwd", &ctx(), &lookup).is_err());
    }

    #[test]
    fn text_without_placeholders_passes_through() {
        let json = r#"{"a":{"b":1}} } {"#;
        assert_eq!(render(json, &ctx(), &lookup).unwrap(), json);
        assert_eq!(render("", &ctx(), &lookup).unwrap(), "");
    }

    #[test]
    fn redact_hides_raw_and_url_encoded_forms() {
        let used = vec!["s3cr3t/+value".to_string()];
        let text = "GET https://x?k=s3cr3t/+value and k=s3cr3t%2F%2Bvalue failed";
        let out = redact(text, &used);
        assert!(!out.contains("s3cr3t"), "{out}");
        assert_eq!(redact("nothing here", &used), "nothing here");
    }
}
