//! macOS activation policy: dock icon on while a real window is up.
//!
//! AppKit denies native fullscreen to an `Accessory` app (green button zooms
//! only), and `bootstrap::setup_app` starts Conductor as one. No-op elsewhere.

#[cfg(target_os = "macos")]
mod imp {
    use tauri::{AppHandle, Manager};

    /// The tray popup opens and closes on every tray click, so counting it
    /// would strobe the dock icon. Every other label is a real window.
    const TRANSIENT_LABELS: &[&str] = &["session-overlay"];

    fn is_real_window(label: &str) -> bool {
        !TRANSIENT_LABELS.contains(&label)
    }

    /// Go `Regular` before a window is built or re-shown, never after: the
    /// policy decides whether AppKit hands that window a fullscreen-capable
    /// zoom button, and flipping it under an already-key window is the path
    /// that risks dropping key status.
    pub fn before_show(app: &AppHandle, label: &str) {
        if is_real_window(label) {
            apply(app, true);
        }
    }

    /// Recompute from what is actually on screen - a hide-to-tray or a close
    /// is what returns the app to `Accessory`.
    pub fn sync(app: &AppHandle) {
        let any_visible = app
            .webview_windows()
            .iter()
            .any(|(label, w)| is_real_window(label) && w.is_visible().unwrap_or(false));
        apply(app, any_visible);
    }

    fn apply(app: &AppHandle, regular: bool) {
        use std::sync::atomic::{AtomicBool, Ordering};
        // Matches the `Accessory` that `bootstrap::setup_app` sets before any
        // window exists, so the first real switch is never skipped.
        static IS_REGULAR: AtomicBool = AtomicBool::new(false);
        if IS_REGULAR.swap(regular, Ordering::SeqCst) == regular {
            return;
        }
        let policy = if regular {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        if let Err(e) = app.set_activation_policy(policy) {
            log::warn!("activation policy switch to regular={regular} failed: {e}");
            IS_REGULAR.store(!regular, Ordering::SeqCst);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::AppHandle;

    pub fn before_show(_app: &AppHandle, _label: &str) {}

    pub fn sync(_app: &AppHandle) {}
}

pub use imp::{before_show, sync};
