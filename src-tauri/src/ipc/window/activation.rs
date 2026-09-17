//! macOS activation policy: dock icon on while a real window is up.
//!
//! AppKit denies native fullscreen to an `Accessory` app (green button zooms
//! only), and `bootstrap::setup_app` starts Conductor as one. No-op elsewhere.

#[cfg(target_os = "macos")]
mod imp {
    use tauri::{AppHandle, Manager};

    use crate::ipc::overlay_window::OVERLAY_LABEL;

    /// The tray popup opens and closes on every tray click, so counting it
    /// would strobe the dock icon. Every other label is a real window.
    const TRANSIENT_LABELS: &[&str] = &[OVERLAY_LABEL];

    fn is_real_window(label: &str) -> bool {
        !TRANSIENT_LABELS.contains(&label)
    }

    /// Go `Regular` before a window is built or re-shown, never after: the
    /// policy decides whether AppKit hands that window a fullscreen-capable
    /// zoom button, and flipping it under an already-key window is the path
    /// that risks dropping key status.
    pub fn before_show(app: &AppHandle, label: &str) {
        if is_real_window(label) {
            apply(app, Some(true));
        }
    }

    /// Recompute from what is actually on screen - a hide-to-tray or a close
    /// is what returns the app to `Accessory`.
    pub fn sync(app: &AppHandle) {
        apply(app, None);
    }

    /// `regular: None` means "read what is on screen", which has to happen on
    /// the main thread next to the swap: an off-thread caller only QUEUES the
    /// native call, so bookkeeping anywhere else lets two policy switches land
    /// in the opposite order from their swaps and pins the dedup on a lie.
    fn apply(app: &AppHandle, regular: Option<bool>) {
        let handle = app.clone();
        let dispatch = app.run_on_main_thread(move || {
            use std::sync::atomic::{AtomicBool, Ordering};
            // Matches the `Accessory` that `bootstrap::setup_app` sets before
            // any window exists, so the first real switch is never skipped.
            static IS_REGULAR: AtomicBool = AtomicBool::new(false);
            let regular = regular.unwrap_or_else(|| {
                handle
                    .webview_windows()
                    .iter()
                    .any(|(label, w)| is_real_window(label) && w.is_visible().unwrap_or(false))
            });
            if IS_REGULAR.swap(regular, Ordering::SeqCst) == regular {
                return;
            }
            let policy = if regular {
                tauri::ActivationPolicy::Regular
            } else {
                tauri::ActivationPolicy::Accessory
            };
            if let Err(e) = handle.set_activation_policy(policy) {
                log::warn!("activation policy switch to regular={regular} failed: {e}");
                IS_REGULAR.store(!regular, Ordering::SeqCst);
            }
        });
        if let Err(e) = dispatch {
            log::warn!("activation policy dispatch to the main thread failed: {e}");
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
