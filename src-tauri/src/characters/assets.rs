//! Convert a character asset (icon or sound) on disk into a base64 data URL
//! the webview can embed directly. Same approach the old soundpacks module used.

use std::path::Path;

pub fn file_data_url_at(asset_path: &Path) -> Option<String> {
    if !asset_path.exists() { return None; }
    let bytes = std::fs::read(asset_path).ok()?;
    let mime = mime_from_filename(asset_path.file_name()?.to_str()?);
    let b64 = base64_encode(&bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

/// [`file_data_url_at`] for a path that must live under `root`: a `..`, a link or
/// a different folder entirely reads nothing. For a path that came out of a
/// character's `character.json`, which a paired machine can have written.
pub fn file_data_url_within(root: &Path, asset_path: &Path) -> Option<String> {
    let confined = crate::util::path::confine_absolute(root, asset_path).ok()?;
    file_data_url_at(&confined)
}

/// Convenience for IPC: resolve under the standard characters dir.
pub fn file_data_url(character_id: &str, relative: &str) -> Option<String> {
    let dir = crate::settings::paths::characters_dir().ok()?;
    let path = dir.join(character_id).join(relative);
    file_data_url_at(&path)
}

fn mime_from_filename(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".mp3") { "audio/mpeg" }
    else if lower.ends_with(".wav") { "audio/wav" }
    else if lower.ends_with(".ogg") { "audio/ogg" }
    else if lower.ends_with(".flac") { "audio/flac" }
    else if lower.ends_with(".png") { "image/png" }
    else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") { "image/jpeg" }
    else if lower.ends_with(".gif") { "image/gif" }
    else { "application/octet-stream" }
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn a_path_outside_the_root_reads_nothing() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("characters");
        fs::create_dir_all(root.join("g/c")).unwrap();
        fs::write(root.join("g/c/hi.wav"), b"riff").unwrap();
        fs::write(tmp.path().join("settings.json"), b"secret").unwrap();
        assert!(file_data_url_within(&root, &root.join("g/c/hi.wav")).is_some());
        assert!(file_data_url_within(&root, &root.join("g/c/../../../settings.json")).is_none());
        assert!(file_data_url_within(&root, &tmp.path().join("settings.json")).is_none());
    }

    #[test]
    fn returns_none_for_missing_file() {
        assert!(file_data_url_at(Path::new("/nonexistent/x.png")).is_none());
    }

    #[test]
    fn returns_data_url_with_correct_mime_for_png() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("icon.png");
        fs::write(&p, b"fake").unwrap();
        let url = file_data_url_at(&p).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn returns_data_url_with_correct_mime_for_wav() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("hi.wav");
        fs::write(&p, b"riff").unwrap();
        let url = file_data_url_at(&p).unwrap();
        assert!(url.starts_with("data:audio/wav;base64,"));
    }

    #[test]
    fn unknown_extension_falls_back_to_octet_stream() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("blob.xyz");
        fs::write(&p, b"x").unwrap();
        let url = file_data_url_at(&p).unwrap();
        assert!(url.starts_with("data:application/octet-stream;base64,"));
    }

    #[test]
    fn case_insensitive_extension_mime() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("ICON.PNG");
        fs::write(&p, b"x").unwrap();
        let url = file_data_url_at(&p).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
    }
}
