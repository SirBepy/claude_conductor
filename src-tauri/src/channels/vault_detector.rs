//! Parses Obsidian's vault registry. Windows: `%APPDATA%\Obsidian\obsidian.json`.
//! macOS: `~/Library/Application Support/{Obsidian,obsidian}/obsidian.json`
//! (directory casing has varied across installer versions, so both are tried).

use anyhow::Result;
use std::path::{Path, PathBuf};

/// One registry entry. `open` and `ts` are what a caller needs to pick the
/// vault the user is actually working in when several are registered.
#[derive(Clone, Debug, PartialEq)]
pub struct Vault {
    pub path: PathBuf,
    pub open: bool,
    pub ts: i64,
}

pub fn parse_entries(raw: &str) -> Result<Vec<Vault>> {
    let v: serde_json::Value = serde_json::from_str(raw)?;
    let Some(vaults) = v.get("vaults").and_then(|v| v.as_object()) else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    for (_, entry) in vaults {
        if let Some(p) = entry.get("path").and_then(|p| p.as_str()) {
            out.push(Vault {
                path: PathBuf::from(p),
                open: entry.get("open").and_then(|o| o.as_bool()).unwrap_or(false),
                ts: entry.get("ts").and_then(|t| t.as_i64()).unwrap_or(0),
            });
        }
    }
    Ok(out)
}

pub fn parse(raw: &str) -> Result<Vec<PathBuf>> {
    Ok(parse_entries(raw)?.into_iter().map(|v| v.path).collect())
}

pub fn detect_entries() -> Result<Vec<Vault>> {
    let Some(cfg) = dirs::config_dir() else { return Ok(vec![]) };
    detect_entries_in(&cfg)
}

/// `cfg` is the platform config dir. On Windows `config_dir()` is
/// %APPDATA%/Roaming, on macOS ~/Library/Application Support.
pub fn detect_entries_in(cfg: &Path) -> Result<Vec<Vault>> {
    let candidates = [
        cfg.join("Obsidian").join("obsidian.json"),
        cfg.join("obsidian").join("obsidian.json"),
    ];
    for path in &candidates {
        match std::fs::read_to_string(path) {
            Ok(s) => return parse_entries(&s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(vec![])
}

pub fn detect() -> Result<Vec<PathBuf>> {
    Ok(detect_entries()?.into_iter().map(|v| v.path).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vaults_with_unix_style_paths() {
        let raw = r#"{"vaults":{"a":{"path":"/Users/joe/Vault A"},"b":{"path":"/Users/joe/Vault B"}}}"#;
        let out = parse(raw).unwrap();
        let paths: Vec<String> = out.iter().map(|p| p.display().to_string()).collect();
        assert!(paths.contains(&"/Users/joe/Vault A".to_string()));
        assert!(paths.contains(&"/Users/joe/Vault B".to_string()));
    }

    #[test]
    fn parses_vaults_with_windows_style_paths() {
        let raw = r#"{"vaults":{"a":{"path":"C:\\Users\\joe\\Vault"}}}"#;
        let out = parse(raw).unwrap();
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn empty_object_returns_empty_vec() {
        assert_eq!(parse(r#"{}"#).unwrap().len(), 0);
        assert_eq!(parse(r#"{"vaults":{}}"#).unwrap().len(), 0);
    }

    #[test]
    fn entries_carry_the_open_flag_and_recency() {
        let raw = r#"{"vaults":{"a":{"path":"/a","ts":9},"b":{"path":"/b","ts":1,"open":true}}}"#;
        let mut out = parse_entries(raw).unwrap();
        out.sort_by(|x, y| x.path.cmp(&y.path));
        assert_eq!(out[0], Vault { path: "/a".into(), open: false, ts: 9 });
        assert_eq!(out[1], Vault { path: "/b".into(), open: true, ts: 1 });
    }

    #[test]
    fn a_registry_under_either_directory_casing_is_found() {
        for dir in ["Obsidian", "obsidian"] {
            let cfg = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(cfg.path().join(dir)).unwrap();
            std::fs::write(cfg.path().join(dir).join("obsidian.json"), r#"{"vaults":{"a":{"path":"/v"}}}"#).unwrap();
            let found = detect_entries_in(cfg.path()).unwrap();
            assert_eq!(found.len(), 1, "casing {dir}");
        }
        let empty = tempfile::tempdir().unwrap();
        assert!(detect_entries_in(empty.path()).unwrap().is_empty());
    }
}
