use claude_conductor_lib::tray::icon_render::{render, IconCtx, SIZE};
use image::GenericImageView;

#[test]
fn png_header_correct() {
    let bytes = render(&IconCtx { updating: false, in_meeting: false, dev: false });
    assert_eq!(&bytes[0..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
}

#[test]
fn decoded_dimensions_are_32x32() {
    let bytes = render(&IconCtx { updating: false, in_meeting: false, dev: false });
    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!(decoded.width(), SIZE);
    assert_eq!(decoded.height(), SIZE);
}

#[test]
fn plain_icon_renders_without_panicking() {
    let _ = render(&IconCtx { updating: false, in_meeting: false, dev: false });
}

#[test]
fn meeting_dot_changes_top_right_pixels() {
    let plain = render(&IconCtx { updating: false, in_meeting: false, dev: false });
    let dotted = render(&IconCtx { updating: false, in_meeting: true, dev: false });
    assert_ne!(plain, dotted, "meeting dot should change the rendered bytes");

    let img = image::load_from_memory(&dotted).unwrap();
    let p = img.get_pixel(SIZE - 6, 6);
    assert!(p[0] > 150 && p[1] < 120 && p[2] < 120, "expected a red pixel at the meeting dot center, got {p:?}");
}

#[test]
fn update_badge_changes_bottom_right_pixels() {
    let plain = render(&IconCtx { updating: false, in_meeting: false, dev: false });
    let badged = render(&IconCtx { updating: true, in_meeting: false, dev: false });
    assert_ne!(plain, badged, "update badge should change the rendered bytes");

    let img = image::load_from_memory(&badged).unwrap();
    let p = img.get_pixel(SIZE - 6, SIZE - 6);
    assert!(p[2] > 150, "expected a blue pixel at the update badge center, got {p:?}");
}

#[test]
fn meeting_dot_and_update_badge_coexist() {
    let both = render(&IconCtx { updating: true, in_meeting: true, dev: false });
    let img = image::load_from_memory(&both).unwrap();
    let meeting = img.get_pixel(SIZE - 6, 6);
    let update = img.get_pixel(SIZE - 6, SIZE - 6);
    assert!(meeting[0] > 150 && meeting[2] < 120, "meeting dot should still be red, got {meeting:?}");
    assert!(update[2] > 150, "update badge should still be blue, got {update:?}");
}
