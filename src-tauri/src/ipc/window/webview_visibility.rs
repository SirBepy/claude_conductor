//! Report a minimized or hidden-to-tray window to the page as
//! `document.visibilityState` "hidden".
//!
//! WebView2 only reports hidden once the host clears the controller's
//! `IsVisible`, and nothing below this app does that: wry's own `WM_SIZE`
//! subclass skips `SIZE_MINIMIZED` (wry 0.55 `webview2/mod.rs`), tao has no
//! minimize event (its `Resized` on minimize carries the iconic size, 144x19
//! measured on the rig, not 0x0), and a window-level `hide()` never touches the
//! controller. Without this every `visibilitychange`-driven pause in the
//! frontend (`visible-interval.ts`) is dead on the desktop (todo 1024).
//!
//! A window subclass rather than tauri window events because a `show()` has no
//! event at all, and a controller left invisible on a shown window paints
//! nothing. `WM_SHOWWINDOW` and `WM_SIZE` see every show, hide, minimize and
//! restore, whichever of the ~10 call sites caused it.

pub(super) fn attach(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    let _ = window.with_webview(|pw| unsafe {
        // The controller's type comes from tauri's own webview2-com, which this
        // crate doesn't depend on, so it is only ever named by inference.
        let controller = pw.controller();
        let mut container = Default::default();
        if controller.ParentWindow(&mut container).is_err() {
            return;
        }
        let container: *mut core::ffi::c_void = container.0;
        imp::subclass(
            container,
            Box::new(move |visible| {
                let _ = controller.SetIsVisible(visible);
            }),
        );
    });
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, IsIconic, IsWindowVisible, GA_ROOT, SIZE_MINIMIZED, WM_NCDESTROY,
        WM_SHOWWINDOW, WM_SIZE,
    };

    // Any value unique among this HWND's subclasses; wry's own ids are 1-3.
    const SUBCLASS_ID: usize = 0x1024;

    type SetVisible = Box<dyn Fn(bool)>;

    pub(super) unsafe fn subclass(container: *mut core::ffi::c_void, set_visible: SetVisible) {
        let root = GetAncestor(HWND(container), GA_ROOT);
        if root.0.is_null() {
            return;
        }
        let data = Box::into_raw(Box::new(set_visible)) as usize;
        if !SetWindowSubclass(root, Some(proc), SUBCLASS_ID, data).as_bool() {
            drop(Box::from_raw(data as *mut SetVisible));
        }
    }

    unsafe extern "system" fn proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        data: usize,
    ) -> LRESULT {
        // WM_SHOWWINDOW arrives before the visibility flips, so its wparam is
        // the truth there; a WM_SIZE on a hidden window must not un-hide it.
        let hidden = match msg {
            WM_SHOWWINDOW => Some(wparam.0 == 0 || IsIconic(hwnd).as_bool()),
            WM_SIZE => {
                Some(wparam.0 == SIZE_MINIMIZED as usize || !IsWindowVisible(hwnd).as_bool())
            }
            WM_NCDESTROY => {
                let _ = RemoveWindowSubclass(hwnd, Some(proc), id);
                drop(Box::from_raw(data as *mut SetVisible));
                return DefSubclassProc(hwnd, msg, wparam, lparam);
            }
            _ => None,
        };
        if let Some(hidden) = hidden {
            (*(data as *const SetVisible))(!hidden);
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }
}
