use claude_conductor_lib::tray::icon_render::{render, IconCtx, SIZE};
use image::GenericImageView;

fn ctx() -> IconCtx {
    IconCtx { updating: false, in_meeting: false, dev: false, input_needed: false }
}

#[test]
fn png_header_correct() {
    let bytes = render(&ctx());
    assert_eq!(&bytes[0..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
}

#[test]
fn decoded_dimensions_are_32x32() {
    let bytes = render(&ctx());
    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!(decoded.width(), SIZE);
    assert_eq!(decoded.height(), SIZE);
}

#[test]
fn plain_icon_renders_without_panicking() {
    let _ = render(&ctx());
}

#[test]
fn meeting_dot_changes_top_right_pixels() {
    let plain = render(&ctx());
    let dotted = render(&IconCtx { in_meeting: true, ..ctx() });
    assert_ne!(plain, dotted, "meeting dot should change the rendered bytes");

    let img = image::load_from_memory(&dotted).unwrap();
    let p = img.get_pixel(SIZE - 6, 6);
    assert!(p[0] > 150 && p[1] < 120 && p[2] < 120, "expected a red pixel at the meeting dot center, got {p:?}");
}

#[test]
fn update_badge_changes_bottom_right_pixels() {
    let plain = render(&ctx());
    let badged = render(&IconCtx { updating: true, ..ctx() });
    assert_ne!(plain, badged, "update badge should change the rendered bytes");

    let img = image::load_from_memory(&badged).unwrap();
    let p = img.get_pixel(SIZE - 6, SIZE - 6);
    assert!(p[2] > 150, "expected a blue pixel at the update badge center, got {p:?}");
}

#[test]
fn meeting_dot_and_update_badge_coexist() {
    let both = render(&IconCtx { updating: true, in_meeting: true, ..ctx() });
    let img = image::load_from_memory(&both).unwrap();
    let meeting = img.get_pixel(SIZE - 6, 6);
    let update = img.get_pixel(SIZE - 6, SIZE - 6);
    assert!(meeting[0] > 150 && meeting[2] < 120, "meeting dot should still be red, got {meeting:?}");
    assert!(update[2] > 150, "update badge should still be blue, got {update:?}");
}

#[test]
fn input_needed_dot_coexists_with_the_other_three() {
    // Four corners, four independent dots: the new top-left amber dot
    // must not clobber the meeting (top-right), update (bottom-
    // right), or dev (bottom-left) dots, or vice versa.
    let all = render(&IconCtx { updating: true, in_meeting: true, dev: true, input_needed: true });
    let img = image::load_from_memory(&all).unwrap();
    let input_needed = img.get_pixel(6, 6);
    let meeting = img.get_pixel(SIZE - 6, 6);
    let update = img.get_pixel(SIZE - 6, SIZE - 6);
    let dev = img.get_pixel(6, SIZE - 6);
    assert_eq!([input_needed[0], input_needed[1], input_needed[2]], [250, 204, 21]);
    assert!(meeting[0] > 150 && meeting[2] < 120, "meeting dot should still be red, got {meeting:?}");
    assert!(update[2] > 150, "update badge should still be blue, got {update:?}");
    assert!(dev[0] > 150 && dev[1] > 80 && dev[2] < 60, "dev dot should still be orange, got {dev:?}");
}
