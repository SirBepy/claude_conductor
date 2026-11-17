//! Character voice packs and icons on every machine that syncs settings (todo
//! pc-1455, last step). `<app-data>/characters/<game>/<character>/...` is filled
//! offline and never lives in the repo, so a second machine has none of it.
//!
//! Decided: the same per-peer "Sync settings" switch covers it (one switch says
//! "this machine is mine"), it only ever FILLS GAPS (a file this machine already has
//! is never replaced and nothing is deleted, so there is no conflict to resolve and
//! a pull can be repeated at any time), and it is a pull: a machine fetches what a
//! syncing peer has and it lacks. Transport is the peer link's own RPC in chunks
//! (`character_asset_chunk`), no new channel. A pull runs when a link connects and
//! when the switch is turned on, one at a time per peer, in a background task: the
//! whole set is about 200 MB over a few thousand small files, and a pull that is
//! cut off resumes at the file level the next time.
//!
//! The peer chooses nothing on this machine's disk: the puller names every path it
//! writes, and each one is checked by [`safe_rel`] (`<game>/<character>/<file>`, plain
//! names, a short list of media extensions) before it is joined to the characters
//! dir. The serving side applies the same check to what it is asked for.

use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::daemon::rpc::{ConnectionContext, Router, RpcError, Transport};
use crate::daemon::state::DaemonState;

use super::{peer_client, PeerMachine};

/// Extensions a character folder holds. Anything else is neither listed nor served
/// nor accepted, so a peer cannot move an executable or a script this way.
const ALLOWED_EXT: &[&str] = &["json", "png", "jpg", "jpeg", "gif", "webp", "wav", "mp3", "ogg", "flac"];
/// Raw bytes per chunk call (base64 on the wire is a third larger), well under the
/// RPC body limits and the peer client's per-call timeout.
const CHUNK: usize = 512 * 1024;
/// A single file this large or larger is skipped. A voice line is a few hundred KB.
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// Most files one manifest lists.
const MAX_ENTRIES: usize = 20_000;
/// Folder levels under a character's own folder that are walked (`sounds/` and its
/// subfolders).
const MAX_DEPTH: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetEntry {
    /// `<game>/<character>/<file...>`, `/`-separated.
    pub path: String,
    pub size: u64,
}

/// The characters dir of the daemon whose registry sits in `app_data`: the same
/// folder `settings::paths::characters_dir` names in production.
fn root_of(state: &DaemonState) -> Option<PathBuf> {
    Some(state.machines.get()?.app_data().join("characters"))
}

/// Checks a path a peer sent (or one this machine is about to write) and returns it
/// as a relative path: at least `<game>/<character>/<file>`, every part a plain name
/// (no empty, `.`, `..`, hidden, drive, backslash or reserved characters), and the
/// file's extension on [`ALLOWED_EXT`].
pub fn safe_rel(path: &str) -> Option<PathBuf> {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 3 || parts.len() > 3 + MAX_DEPTH {
        return None;
    }
    let plain = |p: &str| {
        !p.is_empty()
            && p.len() <= 120
            && !p.starts_with('.')
            && !p.ends_with(' ')
            && !p.chars().any(|c| c.is_control() || matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    };
    if !parts.iter().all(|p| plain(p)) {
        return None;
    }
    // A Windows device name (`nul.wav`) names the device, not a file.
    let stem = parts[parts.len() - 1].split('.').next().unwrap_or("").to_ascii_lowercase();
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        return None;
    }
    let ext = Path::new(parts[parts.len() - 1]).extension()?.to_str()?.to_ascii_lowercase();
    if !ALLOWED_EXT.contains(&ext.as_str()) {
        return None;
    }
    Some(parts.iter().collect())
}

fn rel_string(rel: &Path) -> String {
    rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")
}

/// Every syncable file under `root`, sorted by path. Symlinks are skipped (a link
/// could point outside the characters dir), as is anything [`safe_rel`] refuses or
/// that is too large.
pub fn manifest(root: &Path) -> Vec<AssetEntry> {
    fn walk(dir: &Path, rel: &Path, depth: usize, out: &mut Vec<AssetEntry>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            if out.len() >= MAX_ENTRIES {
                return;
            }
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
            let rel = rel.join(entry.file_name());
            if meta.is_dir() {
                if depth < 2 + MAX_DEPTH {
                    walk(&entry.path(), &rel, depth + 1, out);
                }
            } else if meta.is_file() && meta.len() < MAX_FILE_BYTES {
                let path = rel_string(&rel);
                if safe_rel(&path).is_some() {
                    out.push(AssetEntry { path, size: meta.len() });
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(root, Path::new(""), 0, &mut out);
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// What `remote` has that `local` lacks, in the order to fetch: a character's
/// `character.json` last, so the character only shows up in the catalogue once its
/// sounds and icon are in place. A path that exists locally with another size is NOT
/// listed: this machine's file stays.
pub fn missing(local: &[AssetEntry], remote: &[AssetEntry]) -> Vec<AssetEntry> {
    let have: HashSet<String> = local.iter().map(|e| e.path.to_ascii_lowercase()).collect();
    let mut out: Vec<AssetEntry> = remote
        .iter()
        .filter(|e| safe_rel(&e.path).is_some() && e.size < MAX_FILE_BYTES && !have.contains(&e.path.to_ascii_lowercase()))
        .cloned()
        .collect();
    let is_manifest = |p: &str| p.rsplit('/').next().is_some_and(|f| f.eq_ignore_ascii_case("character.json"));
    out.sort_by(|a, b| (is_manifest(&a.path), &a.path).cmp(&(is_manifest(&b.path), &b.path)));
    out
}

/// One chunk of a file at `offset`, with the file's total size. Refuses a path
/// [`safe_rel`] does not accept, a symlink, and anything that is not a plain file.
pub fn read_chunk(root: &Path, path: &str, offset: u64) -> Result<(Vec<u8>, u64), String> {
    let rel = safe_rel(path).ok_or("not a character asset path")?;
    let full = root.join(rel);
    let meta = std::fs::symlink_metadata(&full).map_err(|_| "no such file")?;
    if !meta.is_file() || meta.len() >= MAX_FILE_BYTES {
        return Err("not a syncable file".into());
    }
    // A symlinked game or character folder is not caught by the leaf check above.
    let (real, real_root) = (std::fs::canonicalize(&full).map_err(|e| e.to_string())?, std::fs::canonicalize(root).map_err(|e| e.to_string())?);
    if !real.starts_with(&real_root) {
        return Err("not inside the characters dir".into());
    }
    let mut file = std::fs::File::open(&full).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; CHUNK];
    let n = file.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(n);
    Ok((buf, meta.len()))
}

pub fn register(router: &mut Router, state: Arc<DaemonState>) {
    // Machine-only (M in the transport table).
    router.register("character_assets_manifest", {
        let state = state.clone();
        move |_params, ctx| {
            let state = state.clone();
            async move {
                require_syncing_peer(&state, &ctx)?;
                let root = root_of(&state).ok_or_else(|| RpcError::internal("machine registry not initialised"))?;
                let entries = tokio::task::spawn_blocking(move || manifest(&root))
                    .await
                    .map_err(|e| RpcError::internal(e.to_string()))?;
                Ok(json!({ "entries": entries }))
            }
        }
    });
    router.register("character_asset_chunk", move |params, ctx| {
        let state = state.clone();
        async move {
            require_syncing_peer(&state, &ctx)?;
            #[derive(Deserialize)]
            struct P {
                path: String,
                #[serde(default)]
                offset: u64,
            }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null)).map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let root = root_of(&state).ok_or_else(|| RpcError::internal("machine registry not initialised"))?;
            let (bytes, size) = tokio::task::spawn_blocking(move || read_chunk(&root, &p.path, p.offset))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::invalid_params)?;
            Ok(json!({ "size": size, "data": base64::engine::general_purpose::STANDARD.encode(bytes) }))
        }
    });
}

/// The caller must be a paired peer machine this daemon's owner switched "Sync
/// settings" on for; the machine is `ctx.transport`'s, never a param.
fn require_syncing_peer(state: &DaemonState, ctx: &ConnectionContext) -> Result<(), RpcError> {
    let Transport::PeerMachine(from) = &ctx.transport else {
        return Err(RpcError::invalid_params("only callable by a peer machine"));
    };
    let registry = state.machines.get().ok_or_else(|| RpcError::internal("machine registry not initialised"))?;
    if !registry.sync_settings(from) {
        return Err(RpcError::invalid_params("settings sync is off for this machine"));
    }
    Ok(())
}

/// Starts a pull from `peer` in the background, unless one is already running for
/// it or sync is off for it. Returns at once.
pub(super) fn spawn_pull(state: &Arc<DaemonState>, peer: &PeerMachine) {
    let Some(registry) = state.machines.get() else { return };
    if !registry.sync_settings(&peer.machine_id) {
        return;
    }
    let Some(mut slot) = state.hub.settings_sync.begin_pull(&peer.machine_id) else { return };
    let (state, peer) = (state.clone(), peer.clone());
    tokio::spawn(async move {
        if let Some(root) = root_of(&state) {
            let mut stored = 0;
            let result = pull_counted(&state, &peer, &root, &mut stored).await;
            match &result {
                Ok(()) if stored == 0 => slot.succeeded(),
                Ok(()) => {
                    slot.succeeded();
                    log::info!("[asset-sync] took {stored} character file(s) from {}", peer.machine_id);
                }
                Err(e) => log::debug!("[asset-sync] pull from {} stopped after {stored} file(s): {e}", peer.machine_id),
            }
            // A pull that stopped part way still left files on disk, so the caches
            // are refreshed on the failure path too.
            if stored > 0 {
                announce_new_files(&state);
            }
        }
    });
}

/// This daemon's own character list and every client's icon cache learn of new files.
fn announce_new_files(state: &DaemonState) {
    crate::characters::cache::invalidate();
    state.notifier.publish("characters_changed", json!({}));
}

/// Whether the owner still has "Sync settings" on for `peer_id`. A pull checks it before
/// every file and every chunk, so switching it off stops one that is already running.
fn still_syncing(state: &DaemonState, peer_id: &str) -> Result<(), String> {
    match state.machines.get() {
        Some(registry) if registry.sync_settings(peer_id) => Ok(()),
        _ => Err("sync switched off".into()),
    }
}

/// Fetches every file `peer` has under its characters dir and `root` lacks. Stops at
/// the first call that fails, or when the switch for `peer` goes off (the next pull
/// starts from what landed). Returns how many files were stored.
pub(crate) async fn pull_into(state: &Arc<DaemonState>, peer: &PeerMachine, root: &Path) -> Result<usize, String> {
    let mut stored = 0;
    pull_counted(state, peer, root, &mut stored).await.map(|()| stored)
}

/// [`pull_into`] with the count kept in `stored` as files land, so a pull that stops
/// on an error still says how many it stored before that.
async fn pull_counted(state: &Arc<DaemonState>, peer: &PeerMachine, root: &Path, stored: &mut usize) -> Result<(), String> {
    still_syncing(state, &peer.machine_id)?;
    let client = peer_client::client_for(state, peer).await.map_err(|e| e.to_string())?;
    let reply = client.call("character_assets_manifest", Value::Null).await.map_err(|e| e.to_string())?;
    let remote: Vec<AssetEntry> =
        serde_json::from_value(reply.get("entries").cloned().unwrap_or(Value::Null)).map_err(|e| e.to_string())?;
    let local_root = root.to_path_buf();
    let local = tokio::task::spawn_blocking(move || manifest(&local_root)).await.map_err(|e| e.to_string())?;
    // A peer cannot make this machine fetch without end: at most as many files as a
    // manifest may list.
    for entry in missing(&local, &remote).into_iter().take(MAX_ENTRIES) {
        still_syncing(state, &peer.machine_id)?;
        let rel = safe_rel(&entry.path).ok_or("unsafe path")?;
        let target = root.join(&rel);
        // Per peer, so two pulls that both lack a file never write the same temp file.
        let tag: String = peer.machine_id.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
        let part = target.with_file_name(format!("{}.{tag}.part", entry.path.rsplit('/').next().unwrap_or("x")));
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let mut bytes: Vec<u8> = Vec::with_capacity(entry.size as usize);
        loop {
            still_syncing(state, &peer.machine_id)?;
            let chunk = client
                .call("character_asset_chunk", json!({ "path": entry.path, "offset": bytes.len() }))
                .await
                .map_err(|e| e.to_string())?;
            let data = chunk["data"].as_str().ok_or("chunk without data")?;
            let part_bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
            if part_bytes.is_empty() {
                break;
            }
            bytes.extend_from_slice(&part_bytes);
            if bytes.len() as u64 > MAX_FILE_BYTES {
                return Err(format!("{} is larger than allowed", entry.path));
            }
            if bytes.len() as u64 >= entry.size {
                break;
            }
        }
        if bytes.len() as u64 != entry.size {
            return Err(format!("{} arrived as {} of {} bytes", entry.path, bytes.len(), entry.size));
        }
        // Never replaces a file that appeared meanwhile (a case-insensitive disk
        // also counts a differently-cased name as present).
        if target.exists() {
            continue;
        }
        std::fs::write(&part, &bytes).map_err(|e| e.to_string())?;
        if std::fs::rename(&part, &target).is_err() {
            let _ = std::fs::remove_file(&part);
            continue;
        }
        *stored += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::device_registry::DeviceRegistry;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use tempfile::tempdir;

    fn put(root: &Path, rel: &str, bytes: &[u8]) {
        let full = root.join(rel);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, bytes).unwrap();
    }

    #[test]
    fn only_plain_game_character_file_paths_with_a_media_extension_pass() {
        for ok in ["hots/jaina/character.json", "hots/jaina/sounds/a-1.wav", "g/c/sounds/deep/x.mp3", "g/c/icon.PNG"] {
            assert!(safe_rel(ok).is_some(), "{ok}");
        }
        for bad in [
            "",
            "icon.png",
            "g/icon.png",
            "../settings.json",
            "g/../x.json",
            "/g/c/a.wav",
            "g//a.wav",
            "g/c/./a.wav",
            "C:/g/c/a.wav",
            "g\\c\\a.wav",
            "g/c/a.exe",
            "g/c/a",
            "g/c/.hidden.wav",
            "g/c/a.wav:stream",
            "g/c/ends.wav ",
            "g/c/a/b/c/d/e/f.wav",
            "g/c/nul.wav",
            "g/c/CON.png",
            "g/c/com1.mp3",
            "g/c/lpt9.json",
        ] {
            assert!(safe_rel(bad).is_none(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn the_manifest_lists_only_syncable_files_in_order() {
        let dir = tempdir().unwrap();
        put(dir.path(), "g/c/character.json", b"{}");
        put(dir.path(), "g/c/sounds/b.wav", b"bb");
        put(dir.path(), "g/c/sounds/a.wav", b"a");
        put(dir.path(), "g/c/run.exe", b"MZ");
        put(dir.path(), "g/c/.secret.json", b"x");
        put(dir.path(), "loose.json", b"x");
        let got = manifest(dir.path());
        let paths: Vec<&str> = got.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["g/c/character.json", "g/c/sounds/a.wav", "g/c/sounds/b.wav"]);
        assert_eq!(got[2].size, 2);
    }

    #[test]
    fn missing_lists_what_the_peer_has_and_this_machine_lacks_with_the_character_file_last() {
        let e = |p: &str, size| AssetEntry { path: p.into(), size };
        let local = vec![e("g/c/sounds/a.wav", 1), e("g/c/icon.png", 7)];
        let remote = vec![
            e("g/c/character.json", 2),
            e("g/c/sounds/a.wav", 999),
            e("g/c/sounds/b.wav", 3),
            e("G/C/ICON.PNG", 7),
            e("g/c/evil.exe", 1),
            e("../x.json", 1),
        ];
        let got: Vec<String> = missing(&local, &remote).into_iter().map(|e| e.path).collect();
        assert_eq!(got, vec!["g/c/sounds/b.wav", "g/c/character.json"], "an existing path stays, bad paths are dropped");
    }

    #[test]
    fn a_chunk_read_is_bounded_and_refuses_paths_outside_the_asset_layout() {
        let dir = tempdir().unwrap();
        let big = vec![7u8; CHUNK + 10];
        put(dir.path(), "g/c/sounds/big.wav", &big);
        put(dir.path(), "settings.json", b"secret");
        let (first, size) = read_chunk(dir.path(), "g/c/sounds/big.wav", 0).unwrap();
        assert_eq!((first.len(), size), (CHUNK, (CHUNK + 10) as u64));
        let (rest, _) = read_chunk(dir.path(), "g/c/sounds/big.wav", CHUNK as u64).unwrap();
        assert_eq!(rest.len(), 10);
        for bad in ["../settings.json", "settings.json", "g/c/../../settings.json", "g/c/sounds", "g/c/nothing.wav"] {
            assert!(read_chunk(dir.path(), bad, 0).is_err(), "{bad}");
        }
    }

    fn daemon(dir: &Path) -> Arc<DaemonState> {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.init_machines(dir.to_path_buf());
        state
    }

    /// Two daemons over loopback, each paired with the other (a peer row and a device
    /// token each way), every sync switch still off.
    struct Linked {
        a_state: Arc<DaemonState>,
        b_state: Arc<DaemonState>,
        a_id: String,
        b_id: String,
        /// B as A's peer row.
        b_as_peer: PeerMachine,
        a_serve: crate::daemon::remote_server::TestServerHandle,
        b_serve: crate::daemon::remote_server::TestServerHandle,
        /// Held so the servers' background state outlives the test body.
        _stt: (Arc<crate::daemon::stt::SttSupervisor>, Arc<crate::daemon::stt::SttSupervisor>),
    }

    fn linked(a_dir: &Path, b_dir: &Path) -> Linked {
        let a_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let mut a_router = Router::new();
        crate::daemon::methods::register_machines(&mut a_router, a_state.clone());
        let mut b_router = Router::new();
        crate::daemon::methods::register_machines(&mut b_router, b_state.clone());
        let (a_stt, a_port, a_serve) =
            crate::daemon::remote_server::spawn_on(a_state.clone(), a_dir.to_path_buf(), a_router, 0);
        let (b_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state.clone(), b_dir.to_path_buf(), b_router, 0);
        let a_id = a_state.machines.get().unwrap().self_machine().unwrap().machine_id;
        let b_id = b_state.machines.get().unwrap().self_machine().unwrap().machine_id;
        let (token_for_a, _) = DeviceRegistry::add_machine_device("A", &a_id, b_dir).unwrap();
        let b_as_peer = PeerMachine {
            machine_id: b_id.clone(),
            label: "B".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: Some(format!("http://127.0.0.1:{b_port}")),
            token: token_for_a,
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        };
        a_state.machines.get().unwrap().upsert_peer(b_as_peer.clone());
        let (token_for_b, _) = DeviceRegistry::add_machine_device("B", &b_id, a_dir).unwrap();
        b_state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: a_id.clone(),
            label: "A".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: Some(format!("http://127.0.0.1:{a_port}")),
            token: token_for_b,
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        });

        Linked { a_state, b_state, a_id, b_id, b_as_peer, a_serve, b_serve, _stt: (a_stt, b_stt) }
    }

    /// B holds a voice pack, A holds one different file under the same path: A pulls,
    /// ends with B's missing files byte for byte and its own file untouched.
    #[tokio::test]
    async fn a_pull_fills_the_gaps_over_a_real_link_and_never_replaces_or_takes_other_files() {
        let (a_dir, b_dir) = (tempdir().unwrap(), tempdir().unwrap());
        let b_chars = b_dir.path().join("characters");
        let big: Vec<u8> = (0..(CHUNK * 2 + 123)).map(|i| (i % 251) as u8).collect();
        put(&b_chars, "g/c/character.json", b"{\"id\":\"c\"}");
        put(&b_chars, "g/c/sounds/long.wav", &big);
        put(&b_chars, "g/c/sounds/clash.wav", b"from-b");
        put(&b_chars, "g/c/run.exe", b"MZ");
        let a_chars = a_dir.path().join("characters");
        put(&a_chars, "g/c/sounds/clash.wav", b"from-a");

        let Linked { a_state, b_state, a_id, b_id, b_as_peer, a_serve, b_serve, _stt } = linked(a_dir.path(), b_dir.path());

        // B's switch for A is off: B serves nothing.
        let refused = pull_into(&a_state, &b_as_peer, &a_chars).await;
        assert!(refused.is_err(), "a peer that has not switched sync on serves no files");
        assert!(!a_chars.join("g/c/character.json").exists());

        b_state.machines.get().unwrap().set_sync_settings(&a_id, true);
        // B serves, but this machine's own switch for B is still off: it fetches nothing.
        assert!(pull_into(&a_state, &b_as_peer, &a_chars).await.is_err());
        assert!(!a_chars.join("g/c/character.json").exists());

        a_state.machines.get().unwrap().set_sync_settings(&b_id, true);
        let stored = pull_into(&a_state, &b_as_peer, &a_chars).await.unwrap();
        assert_eq!(stored, 2, "character.json and long.wav; clash.wav and run.exe stay out");
        assert_eq!(std::fs::read(a_chars.join("g/c/sounds/long.wav")).unwrap(), big, "a multi-chunk file arrives intact");
        assert_eq!(std::fs::read(a_chars.join("g/c/character.json")).unwrap(), b"{\"id\":\"c\"}");
        assert_eq!(std::fs::read(a_chars.join("g/c/sounds/clash.wav")).unwrap(), b"from-a", "a file already here is never replaced");
        assert!(!a_chars.join("g/c/run.exe").exists());
        assert_eq!(pull_into(&a_state, &b_as_peer, &a_chars).await.unwrap(), 0, "a repeat pull has nothing to do");
        let leftovers: Vec<_> = std::fs::read_dir(a_chars.join("g/c/sounds"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
            .collect();
        assert!(leftovers.is_empty());

        a_serve.kill();
        b_serve.kill();
    }

    /// Turning "Sync settings" off for a peer while a pull from it is running stops that
    /// pull at the next file or chunk, instead of letting it finish copying 200 MB.
    #[tokio::test]
    async fn switching_sync_off_stops_a_pull_that_is_already_running() {
        let (a_dir, b_dir) = (tempdir().unwrap(), tempdir().unwrap());
        let (a_chars, b_chars) = (a_dir.path().join("characters"), b_dir.path().join("characters"));
        let two_chunks = vec![9u8; CHUNK + 10];
        for i in 0..40 {
            put(&b_chars, &format!("g/c/sounds/f{i:02}.wav"), &two_chunks);
        }
        let Linked { a_state, b_state, a_id, b_id, b_as_peer, a_serve, b_serve, _stt } = linked(a_dir.path(), b_dir.path());
        b_state.machines.get().unwrap().set_sync_settings(&a_id, true);

        // Off from the start: nothing is fetched, not even the manifest.
        assert_eq!(pull_into(&a_state, &b_as_peer, &a_chars).await, Err("sync switched off".to_string()));
        assert!(!a_chars.join("g/c/sounds/f00.wav").exists());

        // On, then switched off once the first file has landed.
        a_state.machines.get().unwrap().set_sync_settings(&b_id, true);
        let watcher = {
            let (state, first, b_id) = (a_state.clone(), a_chars.join("g/c/sounds/f00.wav"), b_id.clone());
            tokio::spawn(async move {
                while !first.exists() {
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                }
                state.machines.get().unwrap().set_sync_settings(&b_id, false);
            })
        };
        let mut stored = 0;
        let result = pull_counted(&a_state, &b_as_peer, &a_chars, &mut stored).await;
        watcher.await.unwrap();
        assert_eq!(result, Err("sync switched off".to_string()));
        assert!(stored >= 1, "a pull that stopped on an error still reports the files it stored, so the caches refresh");
        let landed = std::fs::read_dir(a_chars.join("g/c/sounds")).unwrap().flatten().count();
        assert!((1..40).contains(&landed), "the pull stopped part way, {landed} of 40 landed");

        a_serve.kill();
        b_serve.kill();
    }

    #[tokio::test]
    async fn the_asset_calls_are_refused_for_a_non_peer_and_for_a_peer_with_the_switch_off() {
        let dir = tempdir().unwrap();
        let state = daemon(dir.path());
        state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: "mac".into(),
            label: "Mac".into(),
            os: "macos".into(),
            iroh_id: None,
            direct_url: None,
            token: "tok".into(),
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        });
        let mut router = Router::new();
        register(&mut router, state.clone());
        for (method, params) in [
            ("character_assets_manifest", json!({})),
            ("character_asset_chunk", json!({"path": "g/c/a.wav"})),
        ] {
            for transport in [None, Some(Transport::Phone), Some(Transport::PeerMachine("mac".into()))] {
                let (tx, _rx) = tokio::sync::mpsc::channel(4);
                let ctx = match transport {
                    Some(t) => crate::daemon::rpc::TRANSPORT.scope(t, async { ConnectionContext::new(tx) }).await,
                    None => ConnectionContext::new(tx),
                };
                let resp = router
                    .dispatch(
                        crate::daemon::rpc::Request { jsonrpc: "2.0".into(), id: json!(1), method: method.into(), params: Some(params.clone()) },
                        ctx,
                    )
                    .await;
                assert!(resp.error.is_some(), "{method} must be refused");
            }
        }
    }
}
