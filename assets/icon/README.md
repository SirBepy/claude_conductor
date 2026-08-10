# App icon provenance

Source of every icon in the repo (desktop, tray, Windows Store, iOS, Android, PWA/favicon).
Established 2026-08-07, commit `3013f168`.

## Files

- `icon-master-1024.png` - THE master. 1024x1024 transparent PNG, the only input `cargo tauri icon`
  needs.
- `master-transparent-source.png` - Joe's original transparent artwork the master was built from.
- `claude-spark-source.png` - the real Claude spark asset, white background keyed out.
- `build-master.py` - normalises artwork into the square 1024 transparent master.
- `size-ladder.py` - contact sheet of candidates rendered at 192/96/48/32px, the only honest icon
  test.
- `bg-check.py` - composites a transparent icon over white tab / light taskbar / dark taskbar / navy
  backgrounds.

All three scripts need Pillow: `python -m pip install pillow` (Python 3.14 + Pillow 12.2.0 verified
working 2026-08-07).

## Regenerating the icon set

1. `cargo tauri icon assets/icon/icon-master-1024.png`
   Writes the full desktop/iOS/Android set into `src-tauri/icons/`.
2. `cargo tauri icon assets/icon/icon-master-1024.png -o android/src-tauri/icons`
   Same full set, dumped into the Android crate's icon dir. `android/src-tauri/tauri.conf.json` only
   references `icons/icon.png`, and `icons/android/**` (the mipmap tree) is the real Android output -
   everything else in this run is a byproduct. Delete the 33 leftover files: `128x128.png`,
   `128x128@2x.png`, `32x32.png`, `64x64.png`, the 9 `Square*Logo.png` files, `StoreLogo.png`,
   `icon.icns`, and the 18 files under `ios/`. Keep `icon.png`, `icon.ico`, and everything under
   `icons/android/`.
3. Copy the refreshed mipmaps into the tracked Android resource dir, since `tauri icon` does not
   touch it:
   `android/src-tauri/icons/android/mipmap-*` -> `android/src-tauri/gen/android/app/src/main/res/mipmap-*`
   (copy `ic_launcher.png`, `ic_launcher_round.png`, `ic_launcher_foreground.png` per density).

The tray icon is not a separate asset - `src-tauri/src/tray/icon_render.rs` embeds
`src-tauri/icons/32x32.png` via `include_bytes!` and stamps status dots on top at runtime, so step 1
alone updates it (after a rebuild).

**Trap hit 2026-08-10:** step 2's command silently no-ops the `android/` mipmap subfolder when run
directly against this repo's real `android/src-tauri/icons` path - it logs
`Android Creating mipmap-xhdpi/ic_launcher.png` etc. as if it wrote them, but nothing lands on
disk (likely picks up the wrong `tauri.conf.json`, the desktop one at repo root). The rest of the
output set (icon.png, icon.ico, Windows/Appx/ICNS) generates fine in the same run. Workaround:
run step 2 against a scratch path outside the repo (e.g. `C:/tmp/icontest/android/src-tauri/icons`),
confirm the `android/mipmap-*` output looks correct there, then copy that verified output into the
real `android/src-tauri/icons/android/` tree before doing step 3.
