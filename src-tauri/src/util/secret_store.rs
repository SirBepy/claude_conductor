//! At-rest wrapping for small secrets (the claude.ai session cookie, peer
//! bearer tokens), so a stray file read, a copied app-data folder or a
//! backup/sync tool does not hand over a usable credential.
//!
//! Windows: DPAPI (`CryptProtectData`, current-user scope). The blob is only
//! decryptable by the same Windows user on the same machine. This does NOT
//! stop a process running as that user from calling `CryptUnprotectData`
//! itself; it stops plain file reads and copies.
//!
//! Elsewhere: values are stored as given. The macOS and Linux builds have no
//! equivalent wired in here (macOS Keychain is used for the Claude OAuth item
//! only, see `accounts::keychain`), so those files stay as protected as the
//! file mode on the app-data directory.
//!
//! A protected value is `PREFIX` plus base64 of the DPAPI blob. The prefix is
//! versioned so a future scheme can coexist, and so a value without it is
//! recognised as a legacy plaintext file that still reads fine and is
//! rewritten protected the next time the owner saves it.

use anyhow::{anyhow, Result};

/// On-disk marker for a wrapped value. Bump the digit on any format change.
pub const PREFIX: &str = "ccsec1:";

/// Whether `protect` actually wraps on this platform.
pub const WRAPS_AT_REST: bool = cfg!(windows);

/// True when `stored` is already in the wrapped on-disk form.
pub fn is_protected(stored: &str) -> bool {
    stored.starts_with(PREFIX)
}

/// True when `stored` should be rewritten through `protect`: this platform
/// wraps, and the value is still legacy plaintext.
pub fn needs_migration(stored: &str) -> bool {
    WRAPS_AT_REST && !is_protected(stored)
}

/// Wraps `plain` for storage. Idempotent: an already wrapped value is returned
/// unchanged, so a value that failed to unwrap on load can be saved back
/// without being wrapped a second time.
pub fn protect(plain: &str) -> Result<String> {
    if is_protected(plain) {
        return Ok(plain.to_string());
    }
    platform::protect(plain)
}

/// Inverse of `protect`. A value without `PREFIX` is legacy plaintext and is
/// returned as is. A wrapped value that cannot be decrypted (tampered, written
/// by another Windows user or machine, or a Windows file opened elsewhere) is
/// an `Err`, never a panic and never a silent empty string.
pub fn unprotect(stored: &str) -> Result<String> {
    match stored.strip_prefix(PREFIX) {
        None => Ok(stored.to_string()),
        Some(body) => platform::unprotect(body),
    }
}

/// Moves a file whose wrapped value will not unwrap out of the way, keeping it
/// for recovery: the first goes to `<stem>.unreadable`, later ones to
/// `.unreadable.1`, `.2`, ... because a rename replaces an existing target on
/// Windows and would destroy the earlier blob. Returns where it went, or
/// `None` if the rename failed.
pub fn set_aside_unreadable(path: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut aside = path.with_extension("unreadable");
    let mut n = 1u32;
    while aside.exists() {
        aside = path.with_extension(format!("unreadable.{n}"));
        n += 1;
    }
    std::fs::rename(path, &aside).ok().map(|()| aside)
}

// ---- Strict mode (API token broker) ----------------------------------------
//
// `protect` above keeps the legacy "plaintext off Windows" behaviour for the
// session cookie and peer tokens. Broker tokens must never reach disk as
// plaintext on any platform, so they go through `protect_strict`, which has no
// plaintext branch: Windows wraps with DPAPI, macOS writes the macOS Keychain,
// and anything else (or a Keychain that refuses) is an `Err` saying why.

/// Stored form of a Keychain-held secret: `PREFIX_KEYCHAIN` plus the account
/// name. The secret itself lives only in the Keychain.
pub const PREFIX_KEYCHAIN: &str = "cckc1:";

/// Keychain service every broker item is filed under.
const KEYCHAIN_SERVICE: &str = "cc-conductor-broker";

/// Where a strict secret is kept on this platform.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    Dpapi,
    Keychain,
    /// No protected store exists (Linux): strict callers get an `Err`.
    Unavailable,
}

pub fn native_backend() -> Backend {
    if cfg!(windows) {
        Backend::Dpapi
    } else if cfg!(target_os = "macos") {
        Backend::Keychain
    } else {
        Backend::Unavailable
    }
}

/// Runs an external command; injectable so the Keychain path is testable
/// without a Keychain.
pub trait CommandRunner {
    /// Returns (exit success, stdout). `stdin` is fed to the child.
    fn run(&self, program: &str, args: &[&str], stdin: &str) -> Result<(bool, String)>;
}

pub struct SystemRunner;

impl CommandRunner for SystemRunner {
    fn run(&self, program: &str, args: &[&str], stdin: &str) -> Result<(bool, String)> {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| anyhow!("could not start {program}: {e}"))?;
        if let Some(mut pipe) = child.stdin.take() {
            // A child that exits early closes the pipe; its exit status says why.
            let _ = pipe.write_all(stdin.as_bytes());
        }
        let out = child.wait_with_output().map_err(|e| anyhow!("{program} failed: {e}"))?;
        Ok((out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned()))
    }
}

/// Account names reach a `security -i` command line, so they are restricted to
/// characters that need no quoting there.
fn valid_account(account: &str) -> bool {
    !account.is_empty()
        && account.len() <= 64
        && account.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

fn hex_encode(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(h: &str) -> Option<String> {
    let h = h.trim();
    // from_str_radix accepts a leading '+', so digits are checked first.
    if h.len() % 2 != 0 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let bytes: Option<Vec<u8>> =
        (0..h.len()).step_by(2).map(|i| h.get(i..i + 2).and_then(|p| u8::from_str_radix(p, 16).ok())).collect();
    String::from_utf8(bytes?).ok()
}

/// Wraps `plain` for the broker store on this platform. Never returns the
/// plaintext. `account` names the Keychain item on macOS and is ignored by DPAPI.
pub fn protect_strict(account: &str, plain: &str) -> Result<String> {
    protect_strict_with(native_backend(), &SystemRunner, account, plain)
}

/// Inverse of `protect_strict`. A value that is not in a protected form (legacy
/// plaintext) is refused rather than passed through.
pub fn unprotect_strict(stored: &str) -> Result<String> {
    unprotect_strict_with(native_backend(), &SystemRunner, stored)
}

pub fn protect_strict_with(
    backend: Backend,
    runner: &dyn CommandRunner,
    account: &str,
    plain: &str,
) -> Result<String> {
    if plain.is_empty() {
        return Err(anyhow!("refusing to store an empty secret"));
    }
    match backend {
        Backend::Dpapi => dpapi_protect(plain),
        Backend::Keychain => {
            if !valid_account(account) {
                return Err(anyhow!("keychain account name {account:?} has characters outside [A-Za-z0-9_.-]"));
            }
            // The value goes in through `security -i` on stdin, never argv, so a
            // process listing never shows it. It is stored as hex text so the
            // item is always printable and reads back unambiguously.
            let line = format!(
                "add-generic-password -U -s {KEYCHAIN_SERVICE} -a {account} -w {}\n",
                hex_encode(plain)
            );
            let (ok, _) = runner
                .run("/usr/bin/security", &["-i"], &line)
                .map_err(|e| anyhow!("macOS Keychain is unavailable: {e}"))?;
            // `security -i` can exit 0 after a failed command, so the write is
            // proven by reading the item back.
            let stored = format!("{PREFIX_KEYCHAIN}{account}");
            match keychain_read(runner, account) {
                Ok(v) if ok && v == plain => Ok(stored),
                Ok(_) | Err(_) => Err(anyhow!(
                    "macOS Keychain refused the write for {account} (locked, denied or unavailable); no plaintext fallback exists"
                )),
            }
        }
        Backend::Unavailable => {
            Err(anyhow!("no protected secret store on this platform; broker tokens are never stored as plaintext"))
        }
    }
}

pub fn unprotect_strict_with(backend: Backend, runner: &dyn CommandRunner, stored: &str) -> Result<String> {
    if let Some(account) = stored.strip_prefix(PREFIX_KEYCHAIN) {
        if backend != Backend::Keychain {
            return Err(anyhow!("secret lives in the macOS Keychain and cannot be read on this platform"));
        }
        if !valid_account(account) {
            return Err(anyhow!("stored keychain reference is malformed"));
        }
        return keychain_read(runner, account);
    }
    if is_protected(stored) {
        return match backend {
            Backend::Dpapi => unprotect(stored),
            _ => Err(anyhow!("secret was wrapped by Windows DPAPI and cannot be read on this platform")),
        };
    }
    Err(anyhow!("stored value is not in a protected form"))
}

fn keychain_read(runner: &dyn CommandRunner, account: &str) -> Result<String> {
    let (ok, out) = runner
        .run("/usr/bin/security", &["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], "")
        .map_err(|e| anyhow!("macOS Keychain is unavailable: {e}"))?;
    if !ok {
        return Err(anyhow!("no Keychain item for {account}"));
    }
    hex_decode(out.trim_end_matches('\n')).ok_or_else(|| anyhow!("Keychain item for {account} is unreadable"))
}

#[cfg(windows)]
fn dpapi_protect(plain: &str) -> Result<String> {
    platform::protect(plain)
}

#[cfg(not(windows))]
fn dpapi_protect(_plain: &str) -> Result<String> {
    Err(anyhow!("DPAPI is only available on Windows"))
}

// ---- Encoded variants for the masker -----------------------------------------

/// Every form a secret can take inside a response body, header, error or file,
/// derived from the stored value (nothing extra is stored): raw, percent-encoded
/// (upper and lower hex), JSON-escaped (with and without `\/`), hex, padded and
/// unpadded standard and URL-safe base64, and the base64 payloads of a
/// Basic header that carries the secret alone as `secret:` or `:secret`
/// (a `user:secret` form cannot be derived without the user, so the masker
/// covers it only when the user part is empty). Deduplicated, empties dropped.
pub fn encoded_variants(secret: &str) -> Vec<String> {
    use base64::Engine;
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
    if secret.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    let mut push = |s: String| {
        if !s.is_empty() && !out.contains(&s) {
            out.push(s);
        }
    };
    push(secret.to_string());
    push(percent_encode(secret, false));
    if let Ok(j) = serde_json::to_string(secret) {
        // Strip exactly the outer quotes: an escaped quote at the end of the
        // secret must keep its closing `"`.
        let inner = j[1..j.len() - 1].to_string();
        // Some servers escape '/' as `\/`; serde_json does not.
        push(inner.replace('/', "\\/"));
        push(inner);
    }
    push(percent_encode(secret, true));
    // The Keychain item holds the secret as hex text, so a leak of the stored
    // form would show this.
    push(hex_encode(secret));
    for shaped in [secret.to_string(), format!("{secret}:"), format!(":{secret}")] {
        push(STANDARD.encode(&shaped));
        push(STANDARD_NO_PAD.encode(&shaped));
        push(URL_SAFE.encode(&shaped));
        push(URL_SAFE_NO_PAD.encode(&shaped));
    }
    out
}

/// RFC 3986 unreserved characters pass; everything else becomes `%XX`.
fn percent_encode(s: &str, lower_hex: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else if lower_hex {
            out.push_str(&format!("%{b:02x}"));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(windows)]
mod platform {
    use super::*;
    use base64::Engine;
    use windows::core::w;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    /// Copies the OS-allocated output blob and frees it.
    ///
    /// # Safety
    /// `blob` must have been filled in by a successful DPAPI call.
    unsafe fn take_blob(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let out = std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(blob.pbData as *mut core::ffi::c_void));
        out
    }

    pub fn protect(plain: &str) -> Result<String> {
        let input = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_ptr() as *mut u8 };
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: `input` borrows `plain` for the call only; DPAPI does not
        // write through it. `output` is filled by the OS and freed in take_blob.
        let bytes = unsafe {
            CryptProtectData(&input, w!("cc-conductor"), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
                .map_err(|e| anyhow!("DPAPI protect failed: {e}"))?;
            take_blob(output)
        };
        Ok(format!("{PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    }

    pub fn unprotect(body: &str) -> Result<String> {
        let blob = base64::engine::general_purpose::STANDARD
            .decode(body.trim())
            .map_err(|e| anyhow!("stored secret is not valid base64: {e}"))?;
        let input = CRYPT_INTEGER_BLOB { cbData: blob.len() as u32, pbData: blob.as_ptr() as *mut u8 };
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: as in `protect`; DPAPI validates the blob and returns an
        // error for malformed or tampered input rather than reading past it.
        let bytes = unsafe {
            CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
                .map_err(|e| anyhow!("DPAPI unprotect failed: {e}"))?;
            take_blob(output)
        };
        String::from_utf8(bytes).map_err(|_| anyhow!("stored secret decrypted to non-UTF-8 bytes"))
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub fn protect(plain: &str) -> Result<String> {
        Ok(plain.to_string())
    }

    /// Only reachable for a value that carries `PREFIX`, i.e. a file written on
    /// Windows and opened here; there is no key to open it with.
    pub fn unprotect(_body: &str) -> Result<String> {
        Err(anyhow!("stored secret was wrapped by Windows DPAPI and cannot be read on this platform"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let stored = protect("sk-ant-sid01-abc").unwrap();
        assert_eq!(unprotect(&stored).unwrap(), "sk-ant-sid01-abc");
        if WRAPS_AT_REST {
            assert!(is_protected(&stored));
            assert!(!stored.contains("sk-ant-sid01-abc"), "plaintext must not survive in the stored form");
        }
    }

    #[test]
    fn protect_is_idempotent_on_a_wrapped_value() {
        let once = protect("secret").unwrap();
        assert_eq!(protect(&once).unwrap(), once);
    }

    #[test]
    fn legacy_plaintext_reads_back_and_is_flagged_for_migration() {
        assert_eq!(unprotect("plain-old-token").unwrap(), "plain-old-token");
        assert_eq!(needs_migration("plain-old-token"), WRAPS_AT_REST);
        assert!(!needs_migration(&protect("x").unwrap()) || !WRAPS_AT_REST);
    }

    #[test]
    fn garbage_after_the_prefix_is_an_error_not_a_panic() {
        assert!(unprotect(&format!("{PREFIX}!!! not base64 !!!")).is_err());
        assert!(unprotect(&format!("{PREFIX}")).is_err());
        // Valid base64, but not a DPAPI blob.
        assert!(unprotect(&format!("{PREFIX}AAAAAAAAAAAAAAAAAAAA")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn a_tampered_blob_is_an_error() {
        use base64::Engine;
        let stored = protect("secret").unwrap();
        let mut raw = base64::engine::general_purpose::STANDARD.decode(&stored[PREFIX.len()..]).unwrap();
        let mid = raw.len() / 2;
        raw[mid] ^= 0xff;
        let last = raw.len() - 1;
        raw[last] ^= 0xff;
        let tampered = format!("{PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(raw));
        assert!(unprotect(&tampered).is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn a_wrapped_value_cannot_be_read_off_windows() {
        assert!(unprotect(&format!("{PREFIX}AAAA")).is_err());
    }

    use std::cell::RefCell;
    use std::collections::HashMap;

    /// Fake `security`: records every call and keeps items in memory.
    #[derive(Default)]
    struct FakeKeychain {
        items: RefCell<HashMap<String, String>>,
        calls: RefCell<Vec<(Vec<String>, String)>>,
        refuse: bool,
    }

    impl CommandRunner for FakeKeychain {
        fn run(&self, _p: &str, args: &[&str], stdin: &str) -> Result<(bool, String)> {
            self.calls.borrow_mut().push((args.iter().map(|s| s.to_string()).collect(), stdin.to_string()));
            if self.refuse {
                return Err(anyhow!("user interaction is not allowed"));
            }
            if args == ["-i"] {
                let t: Vec<&str> = stdin.split_whitespace().collect();
                let acct = t[t.iter().position(|x| *x == "-a").unwrap() + 1];
                let val = t[t.iter().position(|x| *x == "-w").unwrap() + 1];
                self.items.borrow_mut().insert(acct.to_string(), val.to_string());
                return Ok((true, String::new()));
            }
            let acct = args[args.iter().position(|x| *x == "-a").unwrap() + 1];
            Ok(match self.items.borrow().get(acct) {
                Some(v) => (true, format!("{v}\n")),
                None => (false, String::new()),
            })
        }
    }

    const CANARY: &str = "CANARY-tok/en+1=&\"x\"";

    #[test]
    fn keychain_write_round_trips_and_keeps_the_secret_off_argv() {
        let kc = FakeKeychain::default();
        let stored = protect_strict_with(Backend::Keychain, &kc, "shortcut", CANARY).unwrap();
        assert_eq!(stored, "cckc1:shortcut");
        assert!(!stored.contains(CANARY));
        assert_eq!(unprotect_strict_with(Backend::Keychain, &kc, &stored).unwrap(), CANARY);
        for (args, _) in kc.calls.borrow().iter() {
            assert!(args.iter().all(|a| !a.contains("CANARY") && !a.contains(&hex_encode(CANARY))));
        }
        // The write used `security -i` with the value on stdin.
        assert!(kc.calls.borrow().iter().any(|(a, stdin)| a == &["-i"] && stdin.contains(&hex_encode(CANARY))));
    }

    #[test]
    fn strict_refuses_when_the_keychain_is_unavailable() {
        let kc = FakeKeychain { refuse: true, ..Default::default() };
        let err = protect_strict_with(Backend::Keychain, &kc, "figma", CANARY).unwrap_err().to_string();
        assert!(err.contains("Keychain"), "{err}");
        assert!(!err.contains(CANARY));
    }

    #[test]
    fn strict_refuses_when_a_write_does_not_read_back() {
        struct Silent;
        impl CommandRunner for Silent {
            fn run(&self, _: &str, _: &[&str], _: &str) -> Result<(bool, String)> {
                Ok((true, String::new()))
            }
        }
        assert!(protect_strict_with(Backend::Keychain, &Silent, "trello", CANARY).is_err());
    }

    #[test]
    fn strict_has_no_plaintext_branch() {
        let kc = FakeKeychain::default();
        assert!(protect_strict_with(Backend::Unavailable, &kc, "a", CANARY).is_err());
        assert!(protect_strict_with(Backend::Keychain, &kc, "bad name;rm", CANARY).is_err());
        assert!(protect_strict_with(Backend::Keychain, &kc, "a", "").is_err());
        assert!(unprotect_strict_with(Backend::Keychain, &kc, CANARY).is_err());
        assert!(kc.calls.borrow().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn strict_dpapi_round_trips_on_windows() {
        let kc = FakeKeychain::default();
        let stored = protect_strict_with(Backend::Dpapi, &kc, "linear", CANARY).unwrap();
        assert!(stored.starts_with(PREFIX) && !stored.contains("CANARY"));
        assert_eq!(unprotect_strict_with(Backend::Dpapi, &kc, &stored).unwrap(), CANARY);
        assert!(kc.calls.borrow().is_empty());
        assert_eq!(unprotect_strict(&protect_strict("linear", CANARY).unwrap()).unwrap(), CANARY);
    }

    #[cfg(not(windows))]
    #[test]
    fn strict_dpapi_is_refused_off_windows() {
        assert!(protect_strict_with(Backend::Dpapi, &FakeKeychain::default(), "x", CANARY).is_err());
    }

    #[test]
    fn variants_cover_every_encoding_of_the_canary() {
        use base64::Engine;
        let v = encoded_variants(CANARY);
        let std = base64::engine::general_purpose::STANDARD;
        assert!(v.contains(&CANARY.to_string()));
        assert!(v.contains(&"CANARY-tok%2Fen%2B1%3D%26%22x%22".to_string()));
        assert!(v.contains(&"CANARY-tok/en+1=&\\\"x\\\"".to_string()));
        assert!(v.contains(&std.encode(CANARY)));
        assert!(v.contains(&std.encode(format!("{CANARY}:"))));
        assert!(v.contains(&std.encode(format!(":{CANARY}"))));
        assert!(v.contains(&"CANARY-tok\\/en+1=&\\\"x\\\"".to_string()));
        assert!(v.contains(&"CANARY-tok%2fen%2b1%3d%26%22x%22".to_string()));
        assert!(v.contains(&hex_encode(CANARY)));
        assert!(v.contains(&base64::engine::general_purpose::STANDARD_NO_PAD.encode(CANARY)));
        assert_eq!(hex_decode("+f"), None);
        let mut d = v.clone();
        d.sort();
        d.dedup();
        assert_eq!(d.len(), v.len());
        assert!(encoded_variants("").is_empty());
    }
}
