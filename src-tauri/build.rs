fn main() {
    let date = build_date();
    println!("cargo:rustc-env=BUILD_DATE={date}");
    ensure_dist_dir();
    tauri_build::build();
}

/// Release builds embed `../dist` via rust_embed; debug builds read it from
/// disk at runtime instead (`remote_static.rs`), but both need the folder to
/// exist before this crate compiles, since `prebuild` runs before `vite build`.
/// Seed a placeholder here; the real `vite build` overwrites it either way.
fn ensure_dist_dir() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let dist = std::path::Path::new(&manifest).join("..").join("dist");
    if !dist.join("index.html").exists() {
        let _ = std::fs::create_dir_all(&dist);
        let _ = std::fs::write(
            dist.join("index.html"),
            "<!doctype html><meta charset=utf-8><title>Claude Companion</title>\n",
        );
    }
}

fn build_date() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, m, d) = epoch_secs_to_ymd(secs);
    format!("{y:04}-{m:02}-{d:02}")
}

fn epoch_secs_to_ymd(secs: u64) -> (u64, u64, u64) {
    let z = secs / 86400 + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
