//! Screenshots a chat reads come back at most [`MAX_WIDTH`] pixels wide. An image part is
//! re-sent with every later call of the chat, and a 1440 px screenshot costs about 1.3K
//! tokens each time (3,673 of them re-sent 122K times in a week, plan 2026-11-25 step 11).
//! The model reads a page at 1024 px as well as at 1440, and the file Playwright writes
//! beside the inline part keeps the full size for Joe.

use base64::Engine;
use serde_json::Value;

/// The widest inline screenshot a chat gets.
pub(super) const MAX_WIDTH: u32 = 1024;

/// Shrinks every PNG image part of an MCP result wider than [`MAX_WIDTH`], keeping the
/// aspect ratio. Anything it cannot read (another mime type, bad base64, a PNG the
/// decoder refuses) is left exactly as it came: a screenshot that arrives large is better
/// than one that does not arrive.
pub(super) fn shrink_screenshots(result: &mut Value) {
    let Some(parts) = result.get_mut("content").and_then(Value::as_array_mut) else { return };
    for part in parts {
        if part.get("type").and_then(Value::as_str) != Some("image") {
            continue;
        }
        if part.get("mimeType").and_then(Value::as_str).is_some_and(|m| m != "image/png") {
            continue;
        }
        let Some(data) = part.get("data").and_then(Value::as_str) else { continue };
        if let Some(smaller) = shrunk_png_base64(data, MAX_WIDTH) {
            part["data"] = Value::String(smaller);
        }
    }
}

/// The base64 of `data`'s PNG scaled to `max_width`, or `None` when it is already that
/// narrow or cannot be read.
fn shrunk_png_base64(data: &str, max_width: u32) -> Option<String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    let img = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).ok()?;
    if img.width() <= max_width {
        return None;
    }
    let height = ((u64::from(img.height()) * u64::from(max_width)) / u64::from(img.width())).max(1) as u32;
    let scaled = img.resize_exact(max_width, height, image::imageops::FilterType::Triangle);
    let mut out = std::io::Cursor::new(Vec::new());
    scaled.write_to(&mut out, image::ImageFormat::Png).ok()?;
    let smaller = base64::engine::general_purpose::STANDARD.encode(out.into_inner());
    // A re-encode that came out bigger (a flat page that compressed well) is no gain.
    (smaller.len() < data.len()).then_some(smaller)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn png(w: u32, h: u32) -> String {
        // A noisy gradient: it does not compress to nothing, so the smaller copy is smaller.
        let img = image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x * 7 % 251) as u8, (y * 13 % 241) as u8, ((x ^ y) % 256) as u8]));
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img).write_to(&mut out, image::ImageFormat::Png).unwrap();
        base64::engine::general_purpose::STANDARD.encode(out.into_inner())
    }

    fn size_of(data: &str) -> (u32, u32) {
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).unwrap();
        let img = image::load_from_memory(&bytes).unwrap();
        (img.width(), img.height())
    }

    #[test]
    fn a_wide_screenshot_is_scaled_to_1024_keeping_its_shape_and_the_text_part_stays() {
        let mut result = json!({"content": [
            {"type": "text", "text": "### Result"},
            {"type": "image", "data": png(1440, 860), "mimeType": "image/png"},
        ]});
        let before = result["content"][1]["data"].as_str().unwrap().len();
        shrink_screenshots(&mut result);
        let after = result["content"][1]["data"].as_str().unwrap();
        assert_eq!(size_of(after), (1024, 611));
        assert!(after.len() < before);
        assert_eq!(result["content"][0]["text"], "### Result");
        assert_eq!(result["content"][1]["mimeType"], "image/png");
    }

    #[test]
    fn a_narrow_screenshot_and_anything_unreadable_are_left_as_they_came() {
        let narrow = png(800, 600);
        let mut result = json!({"content": [
            {"type": "image", "data": narrow.clone(), "mimeType": "image/png"},
            {"type": "image", "data": "not base64 !!", "mimeType": "image/png"},
            {"type": "image", "data": png(1440, 400), "mimeType": "image/jpeg"},
            {"type": "text", "text": "x"},
        ]});
        let jpeg_labelled = result["content"][2]["data"].clone();
        shrink_screenshots(&mut result);
        assert_eq!(result["content"][0]["data"], narrow.as_str());
        assert_eq!(result["content"][1]["data"], "not base64 !!");
        assert_eq!(result["content"][2]["data"], jpeg_labelled, "only PNG parts are touched");
        shrink_screenshots(&mut json!({"isError": true}));
    }
}
