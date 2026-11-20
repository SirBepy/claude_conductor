//! Hubstaff's access token: exchanged from the rotating refresh token, cached in memory and
//! mirrored for the masker.

use super::*;

pub(super) struct CachedAccess {
    access: String,
    refresh: String,
    /// Whether `refresh` is what the store now holds (a failed write-back keeps
    /// the rotated token here instead, so the next refresh still works).
    persisted: bool,
    expires_at: Instant,
}

impl Engine {
    /// Exchanges the refresh token for an access token, reusing a live one. The
    /// refresh token rotates: the new one is written back, and kept in memory if
    /// that write fails so the next refresh does not spend a dead token.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn oauth_access(
        &self,
        service: Service,
        token_url: &str,
        user_agent: &str,
        refresh_name: &str,
        stored_refresh: &str,
        mask_values: &mut Vec<String>,
        ctx: &mut Ctx,
    ) -> Result<String, (&'static str, String)> {
        let mut cache = self.tokens.lock().await;
        let mut refresh = stored_refresh.to_string();
        if let Some(c) = cache.get(&service) {
            mask_values.push(c.access.clone());
            mask_values.push(c.refresh.clone());
            if c.expires_at > Instant::now() {
                return Ok(c.access.clone());
            }
            if !c.persisted {
                refresh = c.refresh.clone();
            }
        }
        // Same text the masker will be rebuilt from after this returns, so an
        // error built here is already covered.
        ctx.masker = Some(Arc::new(Masker::new(mask_values)));
        let resp = self
            .client
            .post(token_url)
            .header(reqwest::header::USER_AGENT, user_agent)
            .form(&[("grant_type", "refresh_token"), ("refresh_token", refresh.as_str())])
            .send()
            .await
            .map_err(|e| ("oauth_refresh_failed", format!("{} token refresh failed: {}", service.name(), e.without_url())))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err((
                "oauth_refresh_failed",
                format!("{} token refresh returned {status}; the refresh token may be revoked or already rotated elsewhere", service.name()),
            ));
        }
        let v: Value = serde_json::from_str(&text).map_err(|_| ("oauth_refresh_failed", "token refresh returned a body that is not JSON".to_string()))?;
        let access = v["access_token"].as_str().filter(|s| !s.is_empty()).ok_or(("oauth_refresh_failed", "token refresh returned no access token".to_string()))?.to_string();
        mask_values.push(access.clone());
        let mut persisted = true;
        let new_refresh = v["refresh_token"].as_str().filter(|s| !s.is_empty()).unwrap_or(&refresh).to_string();
        mask_values.push(new_refresh.clone());
        if new_refresh != refresh || new_refresh != stored_refresh {
            let stored_now = self.secrets.put(refresh_name, &new_refresh);
            self.invalidate_stored();
            if let Err(e) = stored_now {
                log::error!("[broker] {refresh_name} rotated but could not be stored: {e}");
                persisted = false;
                ctx.notes.push("rotated refresh token was not stored; held in memory".into());
            }
        }
        let ttl = v["expires_in"].as_u64().unwrap_or(3600).saturating_sub(60).max(30);
        self.memory_secrets.lock().unwrap().insert(service, vec![access.clone(), new_refresh.clone()]);
        cache.insert(
            service,
            CachedAccess { access: access.clone(), refresh: new_refresh, persisted, expires_at: Instant::now() + Duration::from_secs(ttl) },
        );
        Ok(access)
    }
}
