//! Renders the 32x32 tray icon as RGBA PNG bytes: the app's own icon, plus a
//! small red "in a meeting" dot (top-right), the existing blue update badge
//! (bottom-right), an amber "a session needs you" dot (top-left), and/or the
//! dev-build dot (bottom-left) stamped on top.

use image::{ImageEncoder, Rgba, RgbaImage};
use std::sync::OnceLock;

pub const SIZE: u32 = 32;

const APP_ICON_BYTES: &[u8] = include_bytes!("../../icons/32x32.png");

fn app_icon() -> &'static RgbaImage {
    static ICON: OnceLock<RgbaImage> = OnceLock::new();
    ICON.get_or_init(|| {
        image::load_from_memory(APP_ICON_BYTES)
            .expect("embedded tray icon is a valid image")
            .to_rgba8()
    })
}

pub struct IconCtx {
    pub updating: bool,
    pub in_meeting: bool,
    /// True for a debug (`cargo tauri dev`) build. Paints a small dot so a
    /// dev instance is visually distinguishable from the installed app when
    /// both run at once (2026-07-16 incident).
    pub dev: bool,
    /// True while any live session's registry `awaiting` is "question" - a
    /// chat is waiting on Joe. Paints the top-left dot.
    pub input_needed: bool,
}

/// Paints an alpha-blended filled circle centered at `(cx, cy)` with radius
/// `r`, source-over onto whatever is already in the buffer.
fn paint_dot(img: &mut RgbaImage, cx: f32, cy: f32, r: f32, color: [u8; 3]) {
    let x0 = (cx - r - 1.0).floor().max(0.0) as u32;
    let x1 = (cx + r + 1.0).ceil().min(SIZE as f32 - 1.0) as u32;
    let y0 = (cy - r - 1.0).floor().max(0.0) as u32;
    let y1 = (cy + r + 1.0).ceil().min(SIZE as f32 - 1.0) as u32;
    for y in y0..=y1 {
        for x in x0..=x1 {
            let dx = x as f32 - cx + 0.5;
            let dy = y as f32 - cy + 0.5;
            let d = (dx * dx + dy * dy).sqrt();
            if d > r + 0.5 { continue; }
            let src_a = if d <= r - 0.5 { 1.0 } else { (r + 0.5 - d).clamp(0.0, 1.0) };
            let cur = img.get_pixel(x, y).0;
            let dst_a = cur[3] as f32 / 255.0;
            let out_a = src_a + dst_a * (1.0 - src_a);
            if out_a < 0.004 { continue; }
            let blend = |dst: u8, src: u8| -> u8 {
                ((src as f32 * src_a + dst as f32 * dst_a * (1.0 - src_a)) / out_a).round() as u8
            };
            img.put_pixel(x, y, Rgba([
                blend(cur[0], color[0]),
                blend(cur[1], color[1]),
                blend(cur[2], color[2]),
                (out_a * 255.0).round() as u8,
            ]));
        }
    }
}

/// Bottom-right badge, unchanged position: shown while an app update is
/// downloading or staged for install.
fn paint_update_badge(img: &mut RgbaImage) {
    const BADGE_COLOR: [u8; 3] = [74, 144, 226];
    paint_dot(img, SIZE as f32 - 6.0, SIZE as f32 - 6.0, 4.0, BADGE_COLOR);
}

/// Top-right dot: shown only while the meeting watcher thinks a call is
/// active, so the icon stays perfectly plain otherwise.
fn paint_meeting_dot(img: &mut RgbaImage) {
    const MEETING_COLOR: [u8; 3] = [220, 60, 60];
    paint_dot(img, SIZE as f32 - 6.0, 6.0, 4.0, MEETING_COLOR);
}

/// Bottom-left dot: always shown on a debug (`cargo tauri dev`) build, so it
/// never gets confused with the installed app in the tray or taskbar preview.
fn paint_dev_dot(img: &mut RgbaImage) {
    const DEV_COLOR: [u8; 3] = [255, 140, 0];
    paint_dot(img, 6.0, SIZE as f32 - 6.0, 4.0, DEV_COLOR);
}

/// Top-left dot: a live session is awaiting input. Amber/yellow,
/// deliberately distinct from the orange dev dot (255,140,0) and the red
/// meeting dot (220,60,60) - Joe picked this over red specifically so it
/// doesn't clash with the meeting dot when both show at once.
fn paint_input_needed_dot(img: &mut RgbaImage) {
    const INPUT_NEEDED_COLOR: [u8; 3] = [250, 204, 21];
    paint_dot(img, 6.0, 6.0, 4.0, INPUT_NEEDED_COLOR);
}

pub fn render(ctx: &IconCtx) -> Vec<u8> {
    let mut img = app_icon().clone();
    if ctx.in_meeting { paint_meeting_dot(&mut img); }
    if ctx.updating { paint_update_badge(&mut img); }
    if ctx.dev { paint_dev_dot(&mut img); }
    if ctx.input_needed { paint_input_needed_dot(&mut img); }
    encode_png(&img)
}

fn encode_png(img: &RgbaImage) -> Vec<u8> {
    let mut buf = Vec::with_capacity(4096);
    image::codecs::png::PngEncoder::new(&mut buf)
        .write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgba8)
        .expect("png encode");
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(input_needed: bool) -> IconCtx {
        IconCtx { updating: false, in_meeting: false, dev: false, input_needed }
    }

    #[test]
    fn input_needed_paints_amber_top_left_dot() {
        let bytes = render(&ctx(true));
        let img = image::load_from_memory(&bytes).unwrap().to_rgba8();
        let px = img.get_pixel(6, 6).0;
        assert_eq!([px[0], px[1], px[2]], [250, 204, 21]);
    }

    #[test]
    fn no_input_needed_leaves_top_left_dot_unpainted() {
        let bytes = render(&ctx(false));
        let img = image::load_from_memory(&bytes).unwrap().to_rgba8();
        let px = img.get_pixel(6, 6).0;
        assert_ne!([px[0], px[1], px[2]], [250, 204, 21]);
    }

    /// Writes the rendered tray icon in both states to `TRAY_SHOT_DIR` for a
    /// visual check. Ignored by default so `--lib` never writes files; the
    /// caller picks the directory (the per-session screenshots folder):
    /// `$env:TRAY_SHOT_DIR=<dir>; cargo test --manifest-path src-tauri/Cargo.toml --lib
    /// write_tray_screenshots -- --ignored`.
    #[test]
    #[ignore]
    fn write_tray_screenshots() {
        let dir = std::env::var("TRAY_SHOT_DIR").expect("set TRAY_SHOT_DIR to the output folder");
        let dir = std::path::Path::new(&dir);
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("1009-tray-awaiting-on.png"), render(&ctx(true))).unwrap();
        std::fs::write(dir.join("1009-tray-awaiting-off.png"), render(&ctx(false))).unwrap();
    }
}
