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
}
