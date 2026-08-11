use super::super::{ClientError, PersistentClient};
use serde_json::{json, Value};

impl PersistentClient {
    /// Create a scheduled item (message or new-chat). `kind`/`recurrence` are
    /// pre-serialized JSON (the caller builds them from the typed
    /// `ScheduledKind`/`Recurrence` enums) so this client stays daemon-schema
    /// agnostic like the rest of the file. Returns the daemon-built
    /// `ScheduledItem` (id/created_at/status assigned there).
    pub async fn schedule_create(
        &self,
        kind: Value,
        prompt: &str,
        fire_at: &str,
        recurrence: Option<Value>,
    ) -> Result<Value, ClientError> {
        self.call("schedule_create", json!({
            "kind": kind,
            "prompt": prompt,
            "fire_at": fire_at,
            "recurrence": recurrence,
        })).await
    }

    /// Overwrite an existing scheduled item. `item` is the full, already-typed
    /// `ScheduledItem` JSON (round-tripped from `schedule_list`, edited, and
    /// sent back) - the daemon rejects an unknown id.
    pub async fn schedule_update(&self, item: Value) -> Result<(), ClientError> {
        self.call("schedule_update", item).await?;
        Ok(())
    }

    pub async fn schedule_delete(&self, id: &str) -> Result<(), ClientError> {
        self.call("schedule_delete", json!({"id": id})).await?;
        Ok(())
    }

    /// Fire a scheduled item immediately instead of waiting for the next
    /// ~30s scheduler tick.
    pub async fn schedule_fire_now(&self, id: &str) -> Result<(), ClientError> {
        self.call("schedule_fire_now", json!({"id": id})).await?;
        Ok(())
    }
}
