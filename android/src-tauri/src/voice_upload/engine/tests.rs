use std::collections::VecDeque;

use super::*;

/// A throwaway folder under the OS temp dir, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("cc-voice-upload-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn audio(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 13 % 251) as u8).collect()
}

/// The index: the jobs still owed and every mark made, in order.
struct FakeSource {
    jobs: Mutex<Vec<Job>>,
    marks: Mutex<Vec<(String, Mark)>>,
    /// Uploaded rows the phone waits to hear about.
    uploaded: Mutex<Vec<Awaiting>>,
}

impl FakeSource {
    fn new(jobs: Vec<Job>) -> Arc<Self> {
        Arc::new(Self { jobs: Mutex::new(jobs), marks: Mutex::new(Vec::new()), uploaded: Mutex::new(Vec::new()) })
    }

    fn with_uploaded(ids: &[&str]) -> Arc<Self> {
        let source = Self::new(vec![]);
        *source.uploaded.lock().unwrap() =
            ids.iter().map(|id| Awaiting { id: id.to_string(), sha256: sha(id.as_bytes()) }).collect();
        source
    }

    fn marks_of(&self, id: &str) -> Vec<Mark> {
        self.marks.lock().unwrap().iter().filter(|(i, _)| i == id).map(|(_, m)| m.clone()).collect()
    }

    fn last(&self, id: &str) -> Option<Mark> {
        self.marks_of(id).pop()
    }
}

impl Source for FakeSource {
    fn claim(&self) -> BoxFut<'_, Result<Vec<Job>, String>> {
        Box::pin(async move {
            let marks = self.marks.lock().unwrap();
            // A recording leaves the queue once it is uploaded or failed.
            let owed = self
                .jobs
                .lock()
                .unwrap()
                .iter()
                .filter(|j| !matches!(marks.iter().rev().find(|(i, _)| *i == j.id).map(|(_, m)| m), Some(Mark::Uploaded | Mark::Transcribed | Mark::Failed(_))))
                .cloned()
                .collect();
            Ok(owed)
        })
    }

    fn awaiting(&self) -> BoxFut<'_, Result<Vec<Awaiting>, String>> {
        Box::pin(async move {
            let marks = self.marks.lock().unwrap();
            let rows = self.uploaded.lock().unwrap();
            Ok(rows
                .iter()
                .filter(|a| !marks.iter().any(|(i, m)| *i == a.id && *m == Mark::Transcribed))
                .cloned()
                .collect())
        })
    }

    fn mark(&self, id: &str, mark: Mark) -> BoxFut<'_, Result<(), String>> {
        let id = id.to_string();
        Box::pin(async move {
            self.marks.lock().unwrap().push((id, mark));
            Ok(())
        })
    }

    fn auth(&self) -> BoxFut<'_, Result<Option<Auth>, String>> {
        Box::pin(async { Ok(None) })
    }
}

/// A PC with the daemon's rules: appends only at its own length, verifies the
/// hash on the last byte, answers `complete` for what it already holds.
#[derive(Default)]
struct FakePc {
    held: Mutex<Vec<u8>>,
    complete: Mutex<bool>,
    declared: Mutex<Option<(String, u64)>>,
    chunk_calls: Mutex<Vec<(u64, usize)>>,
    begin_calls: Mutex<u32>,
    /// Scripted failures, consumed one per call before the PC answers.
    script: Mutex<VecDeque<Scripted>>,
    always_hash_mismatch: bool,
    /// Every chunk is answered as if the begun upload had vanished.
    always_no_upload: bool,
    /// What the PC says of each recording's transcription (`done`, `pending`...).
    transcription: Mutex<std::collections::HashMap<String, String>>,
    status_calls: Mutex<u32>,
}

enum Scripted {
    /// The call never reaches the PC (a lost answer is `LoseChunkAnswer`).
    DropBefore(RpcFailure),
}

impl FakePc {
    fn script(self: &Arc<Self>, s: Scripted) {
        self.script.lock().unwrap().push_back(s);
    }

    fn handle(&self, method: &str, p: &Value) -> Value {
        if method == "voice_transcription_status" {
            *self.status_calls.lock().unwrap() += 1;
            let known = self.transcription.lock().unwrap();
            let mut states = serde_json::Map::new();
            for r in p["recordings"].as_array().unwrap() {
                let id = r["recording_id"].as_str().unwrap();
                states.insert(id.into(), json!(known.get(id).map(String::as_str).unwrap_or("unknown")));
            }
            return json!({ "states": states });
        }
        let sha =p["sha256"].as_str().unwrap().to_string();
        let size = p["size_bytes"].as_u64();
        if *self.complete.lock().unwrap() {
            return json!({"status": "complete"});
        }
        match method {
            "voice_upload_begin" => {
                let mut declared = self.declared.lock().unwrap();
                if declared.as_ref().map(|d| d.1) != size {
                    self.held.lock().unwrap().clear();
                }
                *declared = Some((sha, size.unwrap()));
                *self.begin_calls.lock().unwrap() += 1;
                json!({"status": "partial", "offset": self.held.lock().unwrap().len()})
            }
            _ if self.always_no_upload => {
                self.chunk_calls.lock().unwrap().push((p["offset"].as_u64().unwrap(), 0));
                json!({"status": "no_upload"})
            }
            _ => {
                let offset = p["offset"].as_u64().unwrap();
                let data = base64::engine::general_purpose::STANDARD.decode(p["data_b64"].as_str().unwrap()).unwrap();
                self.chunk_calls.lock().unwrap().push((offset, data.len()));
                let mut held = self.held.lock().unwrap();
                if held.len() as u64 != offset {
                    return json!({"status": "offset_mismatch", "offset": held.len()});
                }
                held.extend_from_slice(&data);
                let (want, size) = self.declared.lock().unwrap().clone().unwrap();
                if held.len() as u64 == size {
                    if self.always_hash_mismatch || sha_of(&held) != want {
                        held.clear();
                        return json!({"status": "hash_mismatch"});
                    }
                    *self.complete.lock().unwrap() = true;
                    return json!({"status": "complete"});
                }
                json!({"status": "partial", "offset": held.len()})
            }
        }
    }
}

fn sha_of(b: &[u8]) -> String {
    sha(b)
}

impl Rpc for Arc<FakePc> {
    fn call(&self, method: &str, params: Value) -> BoxFut<'_, Result<Value, RpcFailure>> {
        let method = method.to_string();
        Box::pin(async move {
            let next = self.script.lock().unwrap().pop_front();
            match next {
                Some(Scripted::DropBefore(f)) => return Err(f),
                None => {}
            }
            Ok(self.handle(&method, &params))
        })
    }
}

fn job_for(dir: &std::path::Path, id: &str, bytes: &[u8], with_sha: bool) -> Job {
    let path = dir.join(format!("{id}.opus"));
    std::fs::write(&path, bytes).unwrap();
    Job {
        id: id.into(),
        path,
        size_bytes: bytes.len() as u64,
        sha256: with_sha.then(|| sha(bytes)),
        recorded_at_ms: 1,
        duration_ms: 2,
    }
}

fn uploader(source: &Arc<FakeSource>, pc: &Arc<FakePc>) -> Uploader<FakeSource, Arc<FakePc>> {
    Uploader::new(source.clone(), Arc::new(pc.clone()))
}

fn offline() -> RpcFailure {
    RpcFailure::Offline("tunnel down".into())
}

#[tokio::test]
async fn a_recording_is_sent_in_chunks_verified_and_marked_uploaded() {
    let dir = Scratch::new();
    let bytes = audio(600 * 1024);
    let source = FakeSource::new(vec![job_for(dir.path(), "r1", &bytes, true)]);
    let pc = Arc::new(FakePc::default());
    assert_eq!(uploader(&source, &pc).run_pass().await, PassEnd::Worked);
    assert_eq!(*pc.held.lock().unwrap(), bytes);
    assert!(*pc.complete.lock().unwrap());
    assert_eq!(source.last("r1"), Some(Mark::Uploaded));
    assert!(pc.chunk_calls.lock().unwrap().len() >= 3, "600 KiB needs more than one 256 KiB chunk");
    // The next pass has nothing to do.
    assert_eq!(uploader(&source, &pc).run_pass().await, PassEnd::Idle);
}

#[tokio::test]
async fn a_dropped_tunnel_leaves_the_row_queued_and_the_next_pass_resumes_without_duplicates() {
    let dir = Scratch::new();
    let bytes = audio(700 * 1024);
    let source = FakeSource::new(vec![job_for(dir.path(), "r1", &bytes, true)]);
    let pc = Arc::new(FakePc::default());
    // begin and two chunks get through, then the tunnel drops.
    let flaky = Arc::new(FlakyAfter { inner: pc.clone(), pass_calls: Mutex::new(3) });
    assert_eq!(Uploader::new(source.clone(), flaky).run_pass().await, PassEnd::Offline);
    let held_after_drop = pc.held.lock().unwrap().len();
    assert!(held_after_drop > 0 && held_after_drop < bytes.len(), "a partial copy is on the PC");
    assert_eq!(source.last("r1"), Some(Mark::Queued), "the row waits for the PC, it is not failed");

    // The tunnel is back: the engine asks, resumes at the PC's offset, finishes.
    assert_eq!(uploader(&source, &pc).run_pass().await, PassEnd::Worked);
    assert_eq!(*pc.held.lock().unwrap(), bytes, "byte for byte, nothing twice");
    let chunks = pc.chunk_calls.lock().unwrap().clone();
    assert_eq!(chunks.iter().filter(|(o, _)| *o == 0).count(), 1, "only the first chunk starts at 0");
    assert_eq!(chunks.iter().map(|(_, n)| *n).sum::<usize>(), bytes.len(), "every byte sent exactly once");
    assert_eq!(source.last("r1"), Some(Mark::Uploaded));
}

/// Lets `pass_calls` calls through, then goes offline for good.
struct FlakyAfter {
    inner: Arc<FakePc>,
    pass_calls: Mutex<u32>,
}

impl Rpc for FlakyAfter {
    fn call(&self, method: &str, params: Value) -> BoxFut<'_, Result<Value, RpcFailure>> {
        let allowed = {
            let mut n = self.pass_calls.lock().unwrap();
            if *n == 0 {
                false
            } else {
                *n -= 1;
                true
            }
        };
        if !allowed {
            return Box::pin(async { Err(offline()) });
        }
        let method = method.to_string();
        Box::pin(async move { Ok(self.inner.handle(&method, &params)) })
    }
}

#[tokio::test]
async fn a_chunk_the_pc_took_but_never_answered_is_not_sent_twice() {
    let dir = Scratch::new();
    let bytes = audio(300 * 1024);
    let source = FakeSource::new(vec![job_for(dir.path(), "r1", &bytes, true)]);
    let pc = Arc::new(FakePc::default());
    // The first chunk lands on the PC and its answer is lost.
    let lost = Arc::new(LoseChunkAnswer { inner: pc.clone(), armed: Mutex::new(true) });
    assert_eq!(Uploader::new(source.clone(), lost).run_pass().await, PassEnd::Offline);
    assert!(!pc.held.lock().unwrap().is_empty(), "the PC applied the chunk");
    assert_eq!(uploader(&source, &pc).run_pass().await, PassEnd::Worked);
    assert_eq!(*pc.held.lock().unwrap(), bytes);
    let sent: usize = pc.chunk_calls.lock().unwrap().iter().map(|(_, n)| *n).sum();
    assert_eq!(sent, bytes.len(), "the resumed pass began after the applied chunk, so every byte was sent once");
}

struct LoseChunkAnswer {
    inner: Arc<FakePc>,
    armed: Mutex<bool>,
}

impl Rpc for LoseChunkAnswer {
    fn call(&self, method: &str, params: Value) -> BoxFut<'_, Result<Value, RpcFailure>> {
        let method = method.to_string();
        Box::pin(async move {
            let reply = self.inner.handle(&method, &params);
            if method == "voice_upload_chunk" && std::mem::replace(&mut *self.armed.lock().unwrap(), false) {
                return Err(offline());
            }
            Ok(reply)
        })
    }
}

#[tokio::test]
async fn a_recording_the_pc_already_holds_is_marked_uploaded_without_sending_a_byte() {
    let dir = Scratch::new();
    let bytes = audio(50_000);
    let source = FakeSource::new(vec![job_for(dir.path(), "r1", &bytes, true)]);
    let pc = Arc::new(FakePc::default());
    *pc.complete.lock().unwrap() = true;
    assert_eq!(uploader(&source, &pc).run_pass().await, PassEnd::Worked);
    assert!(pc.chunk_calls.lock().unwrap().is_empty());
    assert_eq!(source.marks_of("r1"), vec![Mark::Uploaded]);
}

#[tokio::test]
async fn an_offset_the_pc_corrects_is_followed() {
    let dir = Scratch::new();
    let bytes = audio(300 * 1024);
    let source = FakeSource::new(vec![job_for(dir.path(), "r1", &bytes, true)]);
    let pc = Arc::new(FakePc::default());
    // The PC already holds the first 100 KiB from an earlier pass.
    *pc.declared.lock().unwrap() = Some((sha(&bytes), bytes.len() as u64));
    pc.held.lock().unwrap().extend_from_slice(&bytes[..100 * 1024]);
    assert_eq!(uploader(&source, &pc).run_pass().await, PassEnd::Worked);
    assert_eq!(*pc.held.lock().unwrap(), bytes);
    assert_eq!(pc.chunk_calls.lock().unwrap()[0].0, 100 * 1024, "resumes where the PC's copy ends");
}

#[tokio::test]
async fn a_refused_login_requeues_and_never_fails_the_recording() {
    let dir = Scratch::new();
    let bytes = audio(10_000);
    let source = FakeSource::new(vec![job_for(dir.path(), "r1", &bytes, true)]);
    let pc = Arc::new(FakePc::default());
    pc.script(Scripted::DropBefore(RpcFailure::Unauthorized));
    assert_eq!(uploader(&source, &pc).run_pass().await, PassEnd::Unauthorized);
    assert_eq!(source.last("r1"), Some(Mark::Queued));
}

#[tokio::test]
async fn a_recording_the_pc_rejects_for_good_is_failed_and_the_next_one_still_goes() {
    let dir = Scratch::new();
    let a = audio(10_000);
    let b = audio(20_000);
    let source = FakeSource::new(vec![job_for(dir.path(), "a", &a, true), job_for(dir.path(), "b", &b, true)]);
    let pc = Arc::new(FakePc::default());
    pc.script(Scripted::DropBefore(RpcFailure::Rejected("size_bytes must be 1..=x".into())));
    assert_eq!(uploader(&source, &pc).run_pass().await, PassEnd::Worked);
    assert!(matches!(source.last("a"), Some(Mark::Failed(_))));
    assert_eq!(source.last("b"), Some(Mark::Uploaded));
}

#[tokio::test]
async fn a_pc_that_keeps_failing_the_hash_ends_in_failed_not_a_loop() {
    let dir = Scratch::new();
    let bytes = audio(40_000);
    let source = FakeSource::new(vec![job_for(dir.path(), "r1", &bytes, true)]);
    let pc = Arc::new(FakePc { always_hash_mismatch: true, ..Default::default() });
    assert_eq!(uploader(&source, &pc).run_pass().await, PassEnd::Worked);
    assert!(matches!(source.last("r1"), Some(Mark::Failed(_))));
    assert_eq!(pc.chunk_calls.lock().unwrap().len() as u32, 1 + MAX_HASH_RESTARTS);
}

#[tokio::test]
async fn a_pc_that_keeps_losing_the_begun_upload_ends_in_failed_not_a_loop() {
    let dir = Scratch::new();
    let bytes = audio(40_000);
    let source = FakeSource::new(vec![job_for(dir.path(), "r1", &bytes, true)]);
    let pc = Arc::new(FakePc { always_no_upload: true, ..Default::default() });
    assert_eq!(uploader(&source, &pc).run_pass().await, PassEnd::Worked);
    assert!(matches!(source.last("r1"), Some(Mark::Failed(_))));
    assert_eq!(pc.chunk_calls.lock().unwrap().len() as u32, 1 + MAX_HASH_RESTARTS);
}

#[tokio::test]
async fn a_missing_or_changed_file_is_failed_without_calling_the_pc() {
    let dir = Scratch::new();
    let bytes = audio(1_000);
    let mut missing = job_for(dir.path(), "gone", &bytes, true);
    std::fs::remove_file(&missing.path).unwrap();
    let mut changed = job_for(dir.path(), "grew", &bytes, true);
    changed.size_bytes += 1;
    missing.sha256 = None;
    let source = FakeSource::new(vec![missing, changed]);
    let pc = Arc::new(FakePc::default());
    assert_eq!(uploader(&source, &pc).run_pass().await, PassEnd::Worked);
    assert!(matches!(source.last("gone"), Some(Mark::Failed(_))));
    assert!(matches!(source.last("grew"), Some(Mark::Failed(_))));
    assert_eq!(*pc.begin_calls.lock().unwrap(), 0);
}

#[tokio::test]
async fn a_recording_without_a_hash_is_hashed_before_it_is_sent() {
    let dir = Scratch::new();
    let bytes = audio(5_000);
    let source = FakeSource::new(vec![job_for(dir.path(), "r1", &bytes, false)]);
    let pc = Arc::new(FakePc::default());
    assert_eq!(uploader(&source, &pc).run_pass().await, PassEnd::Worked);
    assert_eq!(pc.declared.lock().unwrap().clone().unwrap().0, sha(&bytes));
    assert_eq!(source.last("r1"), Some(Mark::Uploaded));
}

fn say(pc: &Arc<FakePc>, id: &str, state: &str) {
    pc.transcription.lock().unwrap().insert(id.into(), state.into());
}

#[tokio::test]
async fn an_uploaded_recording_becomes_transcribed_once_the_pc_says_done() {
    let source = FakeSource::with_uploaded(&["a", "b", "c"]);
    let pc = Arc::new(FakePc::default());
    say(&pc, "a", "done");
    say(&pc, "b", "pending");
    // "c" is unknown to the PC (it holds no copy).
    let up = uploader(&source, &pc);
    assert_eq!(up.run_pass().await, PassEnd::Worked);
    assert_eq!(source.marks_of("a"), vec![Mark::Transcribed]);
    assert!(source.marks_of("b").is_empty() && source.marks_of("c").is_empty(), "only a finished transcript moves a row");
    // b finishes later: the next pass moves it, and a is not asked about again.
    say(&pc, "b", "done");
    assert_eq!(up.run_pass().await, PassEnd::Worked);
    assert_eq!(source.marks_of("b"), vec![Mark::Transcribed]);
    assert_eq!(source.marks_of("a").len(), 1);
    // c is still waiting, so there is always one to ask about but nothing moves.
    assert_eq!(up.run_pass().await, PassEnd::Idle);
}

#[tokio::test]
async fn one_status_call_carries_every_waiting_recording() {
    let source = FakeSource::with_uploaded(&["a", "b", "c"]);
    let pc = Arc::new(FakePc::default());
    assert_eq!(uploader(&source, &pc).run_pass().await, PassEnd::Idle);
    assert_eq!(*pc.status_calls.lock().unwrap(), 1);
}

#[tokio::test]
async fn a_recording_the_pc_gave_up_on_is_not_asked_about_again() {
    let source = FakeSource::with_uploaded(&["a"]);
    let pc = Arc::new(FakePc::default());
    say(&pc, "a", "failed");
    let up = uploader(&source, &pc);
    assert_eq!(up.run_pass().await, PassEnd::Idle);
    assert_eq!(up.run_pass().await, PassEnd::Idle);
    assert_eq!(*pc.status_calls.lock().unwrap(), 1);
    assert!(source.marks_of("a").is_empty(), "a failed transcript leaves the row uploaded");
}

#[tokio::test]
async fn an_unreachable_or_older_pc_changes_no_row_and_backs_off() {
    for failure in [offline(), RpcFailure::Server("method not found".into())] {
        let source = FakeSource::with_uploaded(&["a"]);
        let pc = Arc::new(FakePc::default());
        pc.script(Scripted::DropBefore(failure));
        assert_eq!(uploader(&source, &pc).run_pass().await, PassEnd::Offline);
        assert!(source.marks.lock().unwrap().is_empty());
    }
    let source = FakeSource::with_uploaded(&["a"]);
    let pc = Arc::new(FakePc::default());
    pc.script(Scripted::DropBefore(RpcFailure::Unauthorized));
    assert_eq!(uploader(&source, &pc).run_pass().await, PassEnd::Unauthorized);
}

#[tokio::test]
async fn a_pass_with_nothing_uploaded_never_calls_the_status_method() {
    let source = FakeSource::new(vec![]);
    let pc = Arc::new(FakePc::default());
    uploader(&source, &pc).run_pass().await;
    assert_eq!(*pc.status_calls.lock().unwrap(), 0);
}

#[tokio::test]
async fn an_empty_queue_is_idle() {
    let source = FakeSource::new(vec![]);
    let pc = Arc::new(FakePc::default());
    assert_eq!(uploader(&source, &pc).run_pass().await, PassEnd::Idle);
}

#[test]
fn the_chunk_size_follows_the_link() {
    let p = Pacer::default();
    assert_eq!(p.0, CHUNK_MAX);
    let slow = p.after(Duration::from_secs(12));
    assert_eq!(slow.0, CHUNK_MAX / 2);
    let mut floor = p;
    for _ in 0..10 {
        floor = floor.after(Duration::from_secs(30));
    }
    assert_eq!(floor.0, CHUNK_MIN, "never below the floor");
    assert_eq!(slow.after(Duration::from_millis(300)).0, CHUNK_MAX, "doubles back on a fast call, capped");
    assert_eq!(slow.after(Duration::from_secs(5)).0, slow.0, "a middling call changes nothing");
}
