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
//! nothing. `WM_WINDOWPOSCHANGED` is the one message every show, hide, minimize
//! and restore produces, whichever of the ~10 call sites caused it. Measured on
//! a bare top-level window: `SetWindowPos(SWP_SHOWWINDOW | SWP_NOSIZE)` sends
//! neither `WM_SHOWWINDOW` nor `WM_SIZE`, so a subclass keyed on those two
//! left the controller invisible on a window that was on screen and painted
//! white.

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
    use std::cell::Cell;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, IsIconic, IsWindowVisible, GA_ROOT, WM_NCDESTROY, WM_WINDOWPOSCHANGED,
    };

    // Any value unique among this HWND's subclasses; wry's own ids are 1-3.
    const SUBCLASS_ID: usize = 0x1024;

    /// The controller is visible exactly when the window is on screen and not
    /// minimized.
    fn controller_visible(shown: bool, iconic: bool) -> bool {
        shown && !iconic
    }

    /// The subclass proc's per-window state. `WM_WINDOWPOSCHANGED` also fires
    /// on every move and resize, so the controller is only touched on a
    /// change: each `SetIsVisible` is a synchronous call into the browser
    /// process.
    struct Tracker<F: Fn(bool)> {
        last: Cell<Option<bool>>,
        set_visible: F,
    }

    impl<F: Fn(bool)> Tracker<F> {
        fn apply(&self, shown: bool, iconic: bool) {
            let visible = controller_visible(shown, iconic);
            if self.last.get() == Some(visible) {
                return;
            }
            // Recorded before the call: the call can re-enter this proc.
            self.last.set(Some(visible));
            (self.set_visible)(visible);
        }
    }

    type State = Tracker<Box<dyn Fn(bool)>>;

    pub(super) unsafe fn subclass(
        container: *mut core::ffi::c_void,
        set_visible: Box<dyn Fn(bool)>,
    ) {
        let root = GetAncestor(HWND(container), GA_ROOT);
        if root.0.is_null() {
            return;
        }
        let data = Box::into_raw(Box::new(Tracker {
            last: Cell::new(None),
            set_visible,
        })) as usize;
        if !SetWindowSubclass(root, Some(proc), SUBCLASS_ID, data).as_bool() {
            drop(Box::from_raw(data as *mut State));
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
        match msg {
            // The window's style bits already hold the new state here, unlike
            // WM_SHOWWINDOW, which arrives before the flip.
            WM_WINDOWPOSCHANGED => {
                (*(data as *const State))
                    .apply(IsWindowVisible(hwnd).as_bool(), IsIconic(hwnd).as_bool());
            }
            WM_NCDESTROY => {
                let _ = RemoveWindowSubclass(hwnd, Some(proc), id);
                drop(Box::from_raw(data as *mut State));
            }
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::cell::RefCell;
        use std::rc::Rc;
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, SetWindowPos, ShowWindow, HWND_TOP,
            SET_WINDOW_POS_FLAGS, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
            SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, SW_SHOW,
            SW_SHOWNOACTIVATE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_OVERLAPPEDWINDOW,
        };

        /// A real top-level window, parked far off-screen so showing it never
        /// flashes, carrying the production subclass whose controller is a
        /// recorder.
        struct Rig {
            hwnd: HWND,
            calls: Rc<RefCell<Vec<bool>>>,
        }

        impl Rig {
            fn new() -> Self {
                let calls = Rc::new(RefCell::new(Vec::new()));
                let hwnd = unsafe {
                    CreateWindowExW(
                        WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                        w!("STATIC"),
                        w!("webview_visibility test"),
                        WS_OVERLAPPEDWINDOW,
                        -32000,
                        -32000,
                        200,
                        150,
                        None,
                        None,
                        None,
                        None,
                    )
                    .expect("create test window")
                };
                let sink = calls.clone();
                unsafe { subclass(hwnd.0, Box::new(move |v| sink.borrow_mut().push(v))) };
                Self { hwnd, calls }
            }

            fn last(&self) -> Option<bool> {
                self.calls.borrow().last().copied()
            }
        }

        impl Drop for Rig {
            fn drop(&mut self) {
                unsafe {
                    let _ = DestroyWindow(self.hwnd);
                }
            }
        }

        fn quiet() -> SET_WINDOW_POS_FLAGS {
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
        }

        #[test]
        fn set_window_pos_show_makes_the_controller_visible() {
            let rig = Rig::new();
            unsafe {
                let _ = SetWindowPos(rig.hwnd, HWND_TOP, 0, 0, 0, 0, quiet() | SWP_SHOWWINDOW);
            }
            assert_eq!(rig.last(), Some(true));
        }

        #[test]
        fn set_window_pos_show_after_a_hide_makes_the_controller_visible_again() {
            let rig = Rig::new();
            unsafe {
                let _ = ShowWindow(rig.hwnd, SW_SHOWNOACTIVATE);
                let _ = ShowWindow(rig.hwnd, SW_MAXIMIZE);
                let _ = ShowWindow(rig.hwnd, SW_HIDE);
            }
            assert_eq!(rig.last(), Some(false));
            unsafe {
                let _ = SetWindowPos(rig.hwnd, HWND_TOP, 0, 0, 0, 0, quiet() | SWP_SHOWWINDOW);
            }
            assert_eq!(rig.last(), Some(true));
        }

        #[test]
        fn set_window_pos_hide_makes_the_controller_invisible() {
            let rig = Rig::new();
            unsafe {
                let _ = ShowWindow(rig.hwnd, SW_SHOWNOACTIVATE);
                let _ = SetWindowPos(rig.hwnd, HWND_TOP, 0, 0, 0, 0, quiet() | SWP_HIDEWINDOW);
            }
            assert_eq!(rig.last(), Some(false));
        }

        #[test]
        fn minimize_hides_and_restore_shows_the_controller() {
            let rig = Rig::new();
            unsafe {
                let _ = ShowWindow(rig.hwnd, SW_SHOWNOACTIVATE);
                let _ = ShowWindow(rig.hwnd, SW_MINIMIZE);
            }
            assert_eq!(rig.last(), Some(false));
            unsafe {
                let _ = ShowWindow(rig.hwnd, SW_RESTORE);
            }
            assert_eq!(rig.last(), Some(true));
        }

        #[test]
        fn restoring_a_window_hidden_while_minimized_shows_the_controller() {
            let rig = Rig::new();
            unsafe {
                let _ = ShowWindow(rig.hwnd, SW_SHOWNOACTIVATE);
                let _ = ShowWindow(rig.hwnd, SW_MINIMIZE);
                let _ = ShowWindow(rig.hwnd, SW_HIDE);
                let _ = ShowWindow(rig.hwnd, SW_RESTORE);
            }
            assert_eq!(rig.last(), Some(true));
        }

        #[test]
        fn showing_a_hidden_minimized_window_keeps_the_controller_invisible() {
            let rig = Rig::new();
            unsafe {
                let _ = ShowWindow(rig.hwnd, SW_SHOWNOACTIVATE);
                let _ = ShowWindow(rig.hwnd, SW_MINIMIZE);
                let _ = ShowWindow(rig.hwnd, SW_HIDE);
                // SW_SHOW keeps the iconic state; SW_SHOWNOACTIVATE would restore.
                let _ = ShowWindow(rig.hwnd, SW_SHOW);
            }
            // Still iconic: it is on the taskbar, not painting.
            assert_eq!(rig.last(), Some(false));
        }

        #[test]
        fn destroying_the_window_drops_the_subclass_state() {
            let rig = Rig::new();
            let calls = rig.calls.clone();
            assert_eq!(Rc::strong_count(&calls), 3); // rig, local clone, closure
            drop(rig);
            assert_eq!(Rc::strong_count(&calls), 1);
        }

        #[test]
        fn controller_is_visible_only_when_shown_and_not_minimized() {
            assert!(controller_visible(true, false));
            assert!(!controller_visible(true, true));
            assert!(!controller_visible(false, false));
            assert!(!controller_visible(false, true));
        }

        #[test]
        fn tracker_touches_the_controller_only_on_a_change() {
            let calls = Rc::new(RefCell::new(Vec::new()));
            let sink = calls.clone();
            let t = Tracker {
                last: Cell::new(None),
                set_visible: move |v| sink.borrow_mut().push(v),
            };
            t.apply(true, false);
            t.apply(true, false);
            t.apply(true, true);
            t.apply(true, true);
            t.apply(false, false);
            t.apply(true, false);
            assert_eq!(*calls.borrow(), vec![true, false, true]);
        }
    }
}
