use super::super::{ClientError, PersistentClient};
use serde_json::{json, Value};

impl PersistentClient {
    /// `{ [account_id]: ApiCreditStatus }` for every API-credit account the
    /// daemon has polled.
    pub async fn get_api_credit_status(&self) -> Result<Value, ClientError> {
        self.call("get_api_credit_status", json!({})).await
    }

    /// Forces a Console read for one account; answers with its new status.
    pub async fn refresh_api_credit_status(&self, account_id: &str) -> Result<Value, ClientError> {
        self.call("refresh_api_credit_status", json!({"account_id": account_id})).await
    }

    /// Validates and stores a Console `sessionKey` for one account; answers
    /// with the refreshed status.
    pub async fn set_console_session(&self, account_id: &str, session_key: &str) -> Result<Value, ClientError> {
        self.call("set_console_session", json!({"account_id": account_id, "session_key": session_key})).await
    }
}
