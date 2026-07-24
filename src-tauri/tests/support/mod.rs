//! Shared test-only helpers. Included both as an integration-test module
//! (`mod support;` from files under `tests/`) and, via `#[path]`, from the
//! `#[cfg(test)]` unit-test module inside the lib crate - see
//! `src/daemon_client/methods.rs`'s `tests` module. Keeping one physical copy
//! avoids the drift that let `KillOnDrop` and `ChildGuard` grow into
//! near-identical hand-copies of the same guard (ai_todo 268).

/// Kills the spawned child process on drop (including on a mid-test panic
/// from a failed assertion), so a failing test never leaves an orphan
/// `cc-conductor-daemon.exe` running.
pub struct ChildGuard(std::process::Child);

impl ChildGuard {
    pub fn new(child: std::process::Child) -> Self {
        Self(child)
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
