use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use sha2::{Digest, Sha256};

use super::job::*;
use super::sidecar::{batch_args, parse_result};
use super::vault::*;
use crate::daemon::voice_upload::store::{receipt_of, Declared, Outcome, Received, UploadKey, UploadStore};

// ---- vault notes ----

fn note<'a>(audio: &'a Path, text: &'a str) -> Note<'a> {
    Note {
        source: "phone voice note",
        created: local_time(1_700_000_000_000),
        language: Some("en"),
        audio,
        device_id: "dev1",
        recording_id: "rec1",
        text,
    }
}

#[test]
fn a_note_has_handys_frontmatter_status_unprocessed_and_the_audio_link() {
    let audio = Path::new(r"C:\Users\x y\app\rec1-abc.opus");
    let md = build_markdown(&note(audio, "  hello there\n"));
    let (front, body) = md.strip_prefix("---\n").unwrap().split_once("\n---\n").unwrap();
    let keys: Vec<&str> = front.lines().map(|l| l.split(':').next().unwrap()).collect();
    assert_eq!(keys, ["type", "source", "created", "language", "status", "audio", "device", "recording"]);
    assert!(front.contains("type: voice-transcript"));
    assert!(front.contains("source: \"phone voice note\""));
    assert!(front.contains("status: unprocessed"));
    assert!(front.contains(r"audio: 'C:\Users\x y\app\rec1-abc.opus'"));
    assert!(body.contains("[rec1-abc.opus](file:///C:/Users/x%20y/app/rec1-abc.opus)"));
    assert!(body.trim_end().ends_with("hello there"));
}

#[test]
fn a_note_without_a_language_has_no_language_key() {
    let mut n = note(Path::new("/a/b.opus"), "x");
    n.language = None;
    assert!(!build_markdown(&n).contains("language:"));
}

#[test]
fn an_export_lands_in_inbox_voice_and_never_overwrites_an_existing_note() {
    let vault = tempfile::tempdir().unwrap();
    let audio = Path::new("/a/b.opus");
    let first = export(vault.path(), &note(audio, "first")).unwrap();
    assert_eq!(first.parent().unwrap(), vault.path().join("Inbox").join("Voice"));
    // Claude has processed and edited the first note.
    std::fs::write(&first, "edited by the later pass").unwrap();
    let second = export(vault.path(), &note(audio, "second")).unwrap();
    let third = export(vault.path(), &note(audio, "third")).unwrap();
    assert_ne!(first, second);
    assert!(second.file_name().unwrap().to_str().unwrap().ends_with("(2).md"));
    assert!(third.file_name().unwrap().to_str().unwrap().ends_with("(3).md"));
    assert_eq!(std::fs::read_to_string(&first).unwrap(), "edited by the later pass");
    assert!(std::fs::read_to_string(&third).unwrap().contains("third"));
}

#[test]
fn the_glossary_keeps_the_term_before_the_first_spaced_hyphen_and_skips_duplicates() {
    let md = "# Glossary\n\nintro line\n- Goobers - a client nickname\n  - Tauri\n- Goobers\n- well-known - note\n-nospace\n* star\n";
    assert_eq!(parse_glossary(md), vec!["Goobers", "Tauri", "well-known"]);
}

#[test]
fn a_missing_glossary_is_empty() {
    let vault = tempfile::tempdir().unwrap();
    assert!(read_glossary(vault.path()).is_empty());
    std::fs::write(vault.path().join("Glossary.md"), "- Zirtue - client\n").unwrap();
    assert_eq!(read_glossary(vault.path()), vec!["Zirtue"]);
}

#[test]
fn a_source_name_becomes_a_windows_safe_stem() {
    assert_eq!(sanitize_stem("a<b>:c|d?e*f\"g.opus"), "a b c d e f g");
    assert_eq!(sanitize_stem("..."), "voice note");
}

// ---- batch.py arguments ----

fn args_with(env: &[(&str, &str)]) -> Vec<String> {
    let env: Vec<(String, String)> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    batch_args(
        Path::new("batch.py"),
        Path::new("appdata"),
        Path::new("a.opus"),
        Path::new("out.json"),
        Path::new("terms.json"),
        |k| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()),
    )
    .into_iter()
    .map(|a| a.to_string_lossy().into_owned())
    .collect()
}

#[test]
fn the_batch_arguments_name_the_files_and_pass_only_valid_tuning() {
    let plain = args_with(&[]);
    assert_eq!(plain, ["batch.py", "--app-data", "appdata", "--audio", "a.opus", "--out", "out.json", "--terms-file", "terms.json"]);
    let tuned = args_with(&[("CC_VOICE_NOTE_DEVICE", "cpu"), ("CC_VOICE_NOTE_PAUSE_RATIO", "2.5"), ("CC_VOICE_NOTE_LANG", "hr")]);
    assert!(tuned.windows(2).any(|w| w == ["--device", "cpu"]));
    assert!(tuned.windows(2).any(|w| w == ["--pause-ratio", "2.5"]));
    assert!(tuned.windows(2).any(|w| w == ["--language", "hr"]));
    // A value that is not what the flag takes is dropped, never passed as another flag.
    let bad = args_with(&[("CC_VOICE_NOTE_DEVICE", "--out"), ("CC_VOICE_NOTE_PAUSE_RATIO", "-1"), ("CC_VOICE_NOTE_LANG", "--x")]);
    assert_eq!(bad, plain);
}

#[test]
fn the_result_json_becomes_a_transcript() {
    let t = parse_result(br#"{"text":"hi there","language":"en"}"#).unwrap();
    assert_eq!((t.text.as_str(), t.language.as_deref()), ("hi there", Some("en")));
    assert_eq!(parse_result(br#"{"text":"x","language":null}"#).unwrap().language, None);
    assert!(parse_result(b"not json").is_err());
    assert!(parse_result(br#"{"chunks":1}"#).is_err());
}

// ---- the job ----

type Outcome1 = Result<Transcript, TranscribeError>;

struct FakeTranscriber {
    results: Mutex<Vec<Outcome1>>,
    calls: AtomicUsize,
    seen_terms: Mutex<Vec<Vec<String>>>,
}

impl FakeTranscriber {
    fn new(results: Vec<Outcome1>) -> Arc<Self> {
        Arc::new(Self { results: Mutex::new(results), calls: AtomicUsize::new(0), seen_terms: Mutex::new(Vec::new()) })
    }
}

impl Transcriber for FakeTranscriber {
    fn transcribe<'a>(&'a self, _audio: &'a Path, terms: &'a [String]) -> BoxFut<'a, Outcome1> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.seen_terms.lock().unwrap().push(terms.to_vec());
        let next = self.results.lock().unwrap().remove(0);
        Box::pin(async move { next })
    }
}

/// Panics on its first call, then answers.
struct PanicsOnce {
    calls: AtomicUsize,
}

impl Transcriber for PanicsOnce {
    fn transcribe<'a>(&'a self, _audio: &'a Path, _terms: &'a [String]) -> BoxFut<'a, Outcome1> {
        let first = self.calls.fetch_add(1, Ordering::SeqCst) == 0;
        Box::pin(async move {
            if first {
                panic!("engine blew up");
            }
            spoken("after the panic")
        })
    }
}

fn spoken(text: &str) -> Outcome1 {
    Ok(Transcript { text: text.into(), language: Some("en".into()) })
}

struct Fixture {
    /// Held so the audio folder outlives the test body.
    _root: tempfile::TempDir,
    vault: tempfile::TempDir,
    store: UploadStore,
    received: Received,
}

fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    let store = UploadStore::new(root.path().to_path_buf());
    let bytes: Vec<u8> = (0..900).map(|i| (i % 251) as u8).collect();
    let sha: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    let key = UploadKey::parse("dev1", "rec1", &sha).unwrap();
    let declared = Declared { size_bytes: 900, recorded_at_ms: 1_700_000_000_000, duration_ms: 60_000 };
    assert_eq!(store.begin(&key, &declared).unwrap(), Outcome::Partial { offset: 0 });
    assert_eq!(store.chunk(&key, 0, &bytes).unwrap(), Outcome::Complete);
    let received = store.pending_transcriptions().remove(0);
    Fixture { _root: root, vault, store, received }
}

fn ctx(t: Arc<FakeTranscriber>, vault: Option<PathBuf>) -> JobCtx {
    ctx_with(t, vault)
}

fn ctx_with(t: Arc<dyn Transcriber>, vault: Option<PathBuf>) -> JobCtx {
    JobCtx {
        transcriber: t,
        vault: Arc::new(move || vault.clone()),
        busy: Arc::new(|| false),
        busy_poll: Duration::from_millis(5),
    }
}

fn state_of(f: &Fixture) -> String {
    receipt_of(&f.received.audio).unwrap()["transcription"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn an_uploaded_recording_is_transcribed_exported_and_marked_done() {
    let f = fixture();
    std::fs::write(f.vault.path().join("Glossary.md"), "- Goobers - client\n").unwrap();
    let t = FakeTranscriber::new(vec![spoken("remember the milk")]);
    let step = process(&ctx(t.clone(), Some(f.vault.path().to_path_buf())), &f.received).await;
    let Step::Exported(path) = step else { panic!("expected an export, got {step:?}") };
    assert_eq!(path.parent().unwrap(), f.vault.path().join("Inbox").join("Voice"));
    let md = std::fs::read_to_string(&path).unwrap();
    assert!(md.contains("status: unprocessed") && md.contains("remember the milk"));
    assert!(md.contains(&f.received.audio.to_string_lossy().to_string()), "the note names the audio");
    assert_eq!(state_of(&f), "done");
    assert_eq!(receipt_of(&f.received.audio).unwrap()["vault_note"], json!(path.to_string_lossy()));
    // The glossary reached the engine as extra vocabulary.
    assert_eq!(t.seen_terms.lock().unwrap()[0], vec!["Goobers"]);
    // Done is final: a second queue entry repeats nothing.
    assert_eq!(process(&ctx(t.clone(), Some(f.vault.path().to_path_buf())), &f.received).await, Step::Skipped);
    assert_eq!(t.calls.load(Ordering::SeqCst), 1);
    assert!(f.store.unfinished_transcriptions().is_empty());
}

#[tokio::test]
async fn without_a_vault_the_text_is_kept_and_exported_once_one_exists() {
    let f = fixture();
    let t = FakeTranscriber::new(vec![spoken("kept safe")]);
    assert_eq!(process(&ctx(t.clone(), None), &f.received).await, Step::NoVault);
    assert_eq!(state_of(&f), "transcribed");
    assert_eq!(std::fs::read_to_string(f.received.audio.with_extension("txt")).unwrap(), "kept safe");
    assert_eq!(f.store.unfinished_transcriptions().len(), 1, "a restart finds it again");
    // The vault shows up: no second transcription, the saved text is exported.
    let step = process(&ctx(t.clone(), Some(f.vault.path().to_path_buf())), &f.received).await;
    assert!(matches!(step, Step::Exported(_)));
    assert_eq!(t.calls.load(Ordering::SeqCst), 1);
    assert_eq!(state_of(&f), "done");
}

#[tokio::test]
async fn errors_retry_and_after_three_the_recording_is_failed_and_left_alone() {
    let f = fixture();
    let t = FakeTranscriber::new(vec![Err("gpu".into()), Err("gpu".into()), Err("gpu".into())]);
    let c = ctx(t.clone(), Some(f.vault.path().to_path_buf()));
    assert_eq!(process(&c, &f.received).await, Step::Retry);
    assert_eq!(process(&c, &f.received).await, Step::Retry);
    assert_eq!(state_of(&f), "pending");
    assert_eq!(process(&c, &f.received).await, Step::Failed);
    assert_eq!(state_of(&f), "failed");
    assert_eq!(receipt_of(&f.received.audio).unwrap()["error"], "gpu");
    assert_eq!(process(&c, &f.received).await, Step::Skipped);
    assert_eq!(t.calls.load(Ordering::SeqCst), 3);
    assert!(f.store.unfinished_transcriptions().is_empty());
    assert!(!f.vault.path().join("Inbox").exists(), "a failure writes no note");
}

#[tokio::test]
async fn an_engine_that_cannot_start_never_fails_the_recording() {
    let f = fixture();
    let unavailable = || Err(TranscribeError::Unavailable("no python".into()));
    let t = FakeTranscriber::new(vec![unavailable(), unavailable(), unavailable(), unavailable(), spoken("at last")]);
    let c = ctx(t.clone(), Some(f.vault.path().to_path_buf()));
    for _ in 0..4 {
        assert_eq!(process(&c, &f.received).await, Step::Retry);
    }
    // Four install-level errors are more than MAX_ATTEMPTS, and it is still pending.
    assert_eq!(state_of(&f), "pending");
    assert_eq!(receipt_of(&f.received.audio).unwrap()["error"], "no python");
    assert!(matches!(process(&c, &f.received).await, Step::Exported(_)));
    assert_eq!(state_of(&f), "done");
}

#[tokio::test]
async fn a_panicking_job_does_not_stop_the_worker() {
    let a = fixture();
    let t = Arc::new(PanicsOnce { calls: AtomicUsize::new(0) });
    let c = Arc::new(ctx_with(t, Some(a.vault.path().to_path_buf())));
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let worker = spawn_worker(c, rx, tx.clone(), Duration::from_millis(20));
    tx.send(a.received.clone()).unwrap();
    for _ in 0..100 {
        if state_of(&a) == "done" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(state_of(&a), "done", "the retry after the panic ran in the same worker");
    worker.abort();
}

#[tokio::test]
async fn a_clip_with_no_speech_is_done_without_a_note() {
    let f = fixture();
    let t = FakeTranscriber::new(vec![spoken("  \n ")]);
    assert_eq!(process(&ctx(t, Some(f.vault.path().to_path_buf())), &f.received).await, Step::Empty);
    assert_eq!(state_of(&f), "done");
    assert!(!f.vault.path().join("Inbox").exists());
}

#[tokio::test]
async fn a_recording_without_a_receipt_is_skipped() {
    let f = fixture();
    std::fs::remove_file(f.received.audio.with_extension("json")).unwrap();
    let t = FakeTranscriber::new(vec![]);
    assert_eq!(process(&ctx(t.clone(), None), &f.received).await, Step::Skipped);
    assert_eq!(t.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn the_job_waits_while_a_dictation_is_live() {
    let f = fixture();
    let live = Arc::new(AtomicBool::new(true));
    let t = FakeTranscriber::new(vec![spoken("later")]);
    let flag = live.clone();
    let c = JobCtx {
        transcriber: t.clone(),
        vault: { let v = f.vault.path().to_path_buf(); Arc::new(move || Some(v.clone())) },
        busy: Arc::new(move || flag.load(Ordering::SeqCst)),
        busy_poll: Duration::from_millis(5),
    };
    let received = f.received.clone();
    let task = tokio::spawn(async move { process(&c, &received).await });
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(t.calls.load(Ordering::SeqCst), 0, "no transcription while dictation is live");
    live.store(false, Ordering::SeqCst);
    assert!(matches!(task.await.unwrap(), Step::Exported(_)));
}

#[tokio::test]
async fn the_worker_runs_one_job_at_a_time_and_retries_a_failed_one() {
    let a = fixture();
    let b = fixture();
    // Two jobs in one worker: the first fails once, then everything succeeds.
    let t = FakeTranscriber::new(vec![Err("hiccup".into()), spoken("second"), spoken("first again")]);
    let c = Arc::new(ctx(t.clone(), Some(a.vault.path().to_path_buf())));
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let worker = spawn_worker(c, rx, tx.clone(), Duration::from_millis(20));
    tx.send(a.received.clone()).unwrap();
    tx.send(b.received.clone()).unwrap();
    for _ in 0..100 {
        if state_of(&a) == "done" && state_of(&b) == "done" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(state_of(&a), "done");
    assert_eq!(state_of(&b), "done");
    assert_eq!(t.calls.load(Ordering::SeqCst), 3);
    worker.abort();
}
