use super::*;
use crate::accounts::login_step::LoginPollResult;
use std::path::Path;

fn ident(email: &str, org: &str) -> OauthAccountInfo {
    OauthAccountInfo {
        email_address: email.to_string(),
        organization_uuid: org.to_string(),
        organization_name: None,
        organization_type: None,
    }
}

fn acct(id: &str, org: &str, email: &str, dir: &str) -> Account {
    Account {
        id: id.into(),
        label: format!("label-{id}"),
        colour: "#fff".into(),
        icon: "user".into(),
        config_dir: dir.into(),
        chrome_profile_dir: format!("{dir}-chrome").into(),
        email: email.into(),
        org_uuid: org.into(),
        subscription_tier: "claude_max".into(),
        created_at: "2026-01-01T00:00:00Z".into(),
        fleet_eligible: false,
    }
}

const DIR: &str = "C:/wizard-dir";

#[test]
fn pending_stays_pending_even_with_web_identity() {
    let web = ident("a@x.com", "org-1");
    let out = resolve_login_outcome(
        LoginPollResult::Pending,
        Some(&web),
        None,
        &[],
        Path::new(DIR),
        None,
    );
    assert!(matches!(out, LoginCheckOutcome::Pending { credentials_no_profile: false, .. }));
}

#[test]
fn credentials_no_profile_without_web_identity_reports_flag() {
    let out = resolve_login_outcome(
        LoginPollResult::CredentialsNoProfile,
        None,
        None,
        &[],
        Path::new(DIR),
        None,
    );
    assert!(matches!(out, LoginCheckOutcome::Pending { credentials_no_profile: true, .. }));
}

#[test]
fn credentials_no_profile_with_web_identity_is_ready() {
    // Browser-first flow: valid credentials + cookie-confirmed identity
    // completes the step even though the CLI never wrote oauthAccount.
    let web = ident("a@x.com", "org-1");
    let out = resolve_login_outcome(
        LoginPollResult::CredentialsNoProfile,
        Some(&web),
        None,
        &[],
        Path::new(DIR),
        None,
    );
    match out {
        LoginCheckOutcome::Ready { identity } => assert_eq!(identity.email_address, "a@x.com"),
        other => panic!("expected Ready, got {other:?}"),
    }
}

#[test]
fn cli_ready_mismatching_web_identity_is_mismatch() {
    let web = ident("web@x.com", "org-web");
    let out = resolve_login_outcome(
        LoginPollResult::Ready(ident("cli@x.com", "org-cli")),
        Some(&web),
        None,
        &[],
        Path::new(DIR),
        None,
    );
    match out {
        LoginCheckOutcome::Mismatch { existing_email, new_email } => {
            assert_eq!(existing_email, "web@x.com");
            assert_eq!(new_email, "cli@x.com");
        }
        other => panic!("expected Mismatch, got {other:?}"),
    }
}

#[test]
fn cli_ready_matching_web_identity_prefers_cli_identity() {
    let web = ident("a@x.com", "org-1");
    let out = resolve_login_outcome(
        LoginPollResult::Ready(ident("A@X.COM", "org-1")),
        Some(&web),
        None,
        &[],
        Path::new(DIR),
        None,
    );
    match out {
        LoginCheckOutcome::Ready { identity } => assert_eq!(identity.email_address, "A@X.COM"),
        other => panic!("expected Ready, got {other:?}"),
    }
}

#[test]
fn cli_ready_mismatching_pre_existing_identity_is_mismatch() {
    let pre = ident("old@x.com", "org-old");
    let out = resolve_login_outcome(
        LoginPollResult::Ready(ident("new@x.com", "org-new")),
        None,
        Some(&pre),
        &[],
        Path::new(DIR),
        None,
    );
    assert!(matches!(out, LoginCheckOutcome::Mismatch { .. }));
}

#[test]
fn cli_ready_duplicate_org_is_duplicate() {
    let registered = vec![acct("a1", "org-1", "other@x.com", "C:/other-dir")];
    let out = resolve_login_outcome(
        LoginPollResult::Ready(ident("a@x.com", "org-1")),
        None,
        None,
        &registered,
        Path::new(DIR),
        None,
    );
    match out {
        LoginCheckOutcome::Duplicate { existing_label } => assert_eq!(existing_label, "label-a1"),
        other => panic!("expected Duplicate, got {other:?}"),
    }
}

#[test]
fn cli_ready_own_dir_is_not_duplicate() {
    // Adopting a dir back into its own registered account is fine.
    let registered = vec![acct("a1", "org-1", "a@x.com", DIR)];
    let out = resolve_login_outcome(
        LoginPollResult::Ready(ident("a@x.com", "org-1")),
        None,
        None,
        &registered,
        Path::new(DIR),
        None,
    );
    assert!(matches!(out, LoginCheckOutcome::Ready { .. }));
}

#[test]
fn misdirected_hint_passes_through_pending() {
    let out = resolve_login_outcome(
        LoginPollResult::Pending,
        None,
        None,
        &[],
        Path::new(DIR),
        Some("~/.claude".to_string()),
    );
    match out {
        LoginCheckOutcome::Pending { misdirected, .. } => {
            assert_eq!(misdirected.as_deref(), Some("~/.claude"));
        }
        other => panic!("expected Pending, got {other:?}"),
    }
}
