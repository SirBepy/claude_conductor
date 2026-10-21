//! Per-session ChatEvent fan-out helper. Each Session owns a broadcast
//! channel; this module centralizes the publish/subscribe pattern.

use crate::daemon::session::Session;
use crate::types::chat::ChatEvent;
use std::sync::Arc;
use tokio::sync::broadcast;

/// Publish an event to all subscribers of this session. Silently no-ops if
/// there are no subscribers (broadcast::send returns Err when receiver
/// count is 0 - that's expected, not an error).
#[track_caller]
pub fn publish(session: &Session, event: ChatEvent) {
    // A user bubble that re-renders after the reply is a re-published echo
    // whose source is unknown; the caller location and timestamp name it the
    // next time it happens.
    if let ChatEvent::UserMessage { remote_echo: true, timestamp, content, .. } = &event {
        log::info!(
            "broadcast: user_message echo session={} ts={timestamp} blocks={} from {}",
            session.session_id,
            content.len(),
            std::panic::Location::caller(),
        );
    }
    let _ = session.events.send(event);
}

/// Subscribe a new receiver to this session's events. Receivers see all
/// events sent AFTER subscription (standard broadcast::Receiver semantics).
pub fn subscribe(session: &Arc<Session>) -> broadcast::Receiver<ChatEvent> {
    session.events.subscribe()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::chat::ChatEvent;

    fn fake_event() -> ChatEvent {
        ChatEvent::Notification {
            kind: "test".into(),
            body: "hello".into(),
        }
    }

    #[tokio::test]
    async fn publish_with_no_subscribers_is_noop() {
        let (tx, rx_dropped) = broadcast::channel::<ChatEvent>(16);
        drop(rx_dropped);
        let r = tx.send(fake_event());
        assert!(r.is_err(), "send returns Err when no active receivers");
    }

    #[tokio::test]
    async fn subscribe_then_publish_roundtrips() {
        let (tx, _) = broadcast::channel::<ChatEvent>(16);
        let mut rx = tx.subscribe();
        tx.send(fake_event()).expect("send with subscriber");
        let got = rx.recv().await.expect("recv");
        match got {
            ChatEvent::Notification { kind, .. } => assert_eq!(kind, "test"),
            _ => panic!("wrong variant"),
        }
    }
}
