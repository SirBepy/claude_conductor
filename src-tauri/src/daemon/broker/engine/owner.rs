//! The ownership check of an owner-only write: who the token belongs to, and whether the
//! target object is theirs.

use super::*;

impl Engine {
    /// A fixed, engine-built GET or POST used by the ownership check. It passes
    /// the same URL guard as any call but never the policy.
    async fn fetch_json(&self, spec: &ServiceSpec, auth: &Auth, method: Method, path: &str, body: Option<Value>) -> Result<Value, String> {
        let checked = CheckedRequest { method, path: path.to_string(), query: None };
        let bytes = body.as_ref().map(|b| serde_json::to_vec(b).unwrap_or_default());
        let up = self
            .send(spec, auth, &checked, bytes.as_deref(), None)
            .await
            .map_err(|e| match e {
                SendError::TooLarge => "ownership lookup response is too large".to_string(),
                SendError::Net { message, .. } => format!("ownership lookup failed: {message}"),
            })?;
        if !(200..300).contains(&up.status) {
            return Err(format!("ownership lookup returned {}", up.status));
        }
        serde_json::from_slice(&up.body).map_err(|_| "ownership lookup returned a body that is not JSON".to_string())
    }

    async fn linear_query(&self, spec: &ServiceSpec, auth: &Auth, query: &str, variables: Value) -> Result<Value, String> {
        let v = self.fetch_json(spec, auth, Method::Post, "/graphql", Some(json!({ "query": query, "variables": variables }))).await?;
        if v.get("errors").is_some_and(|e| !e.is_null()) {
            return Err("ownership lookup was refused by Linear".into());
        }
        Ok(v["data"].clone())
    }

    async fn my_id(&self, spec: &ServiceSpec, service: Service, auth: &Auth) -> Result<String, String> {
        if let Some(id) = self.me.lock().unwrap().get(&service) {
            return Ok(id.clone());
        }
        let id = match service {
            Service::Shortcut => self.fetch_json(spec, auth, Method::Get, "/api/v3/member", None).await?["id"].as_str().map(str::to_string),
            Service::Linear => {
                self.linear_query(spec, auth, ownership::LINEAR_VIEWER_QUERY, json!({})).await?["viewer"]["id"].as_str().map(str::to_string)
            }
            _ => None,
        }
        .ok_or("could not learn who the token belongs to")?;
        self.me.lock().unwrap().insert(service, id.clone());
        Ok(id)
    }

    /// `Err((code, message))` unless the call's target object is Joe's.
    pub(super) async fn check_owner(
        &self,
        spec: &ServiceSpec,
        service: Service,
        auth: &Auth,
        checked: &CheckedRequest,
        gql: Option<&GqlRequest>,
    ) -> Result<(), (&'static str, String)> {
        let lookup = |m: String| ("owner_lookup_failed", format!("ownership could not be checked, so the write is refused: {m}"));
        match service {
            Service::Shortcut => {
                let (kind, id) = ownership::shortcut_target(&checked.path).ok_or((
                    "no_target",
                    "this path names no story or epic, so its owner cannot be checked".to_string(),
                ))?;
                let me = self.my_id(spec, service, auth).await.map_err(lookup)?;
                let path = format!("/api/v3/{}/{id}", kind.collection());
                let obj = self.fetch_json(spec, auth, Method::Get, &path, None).await.map_err(lookup)?;
                if ownership::shortcut_owned(&obj, &me) {
                    Ok(())
                } else {
                    Err(("not_owner", format!("{}/{id} is not yours (you are neither an owner nor the requester); an owner-only row cannot change it", kind.collection())))
                }
            }
            Service::Linear => {
                let g = gql.ok_or(("no_target", "no GraphQL document to read a target from".to_string()))?;
                let issue_id = ownership::linear_target(g).ok_or((
                    "no_target",
                    "this operation names no issue in its variables, so its owner cannot be checked (commentCreate needs input.issueId, issueUpdate needs id)".to_string(),
                ))?;
                let me = self.my_id(spec, service, auth).await.map_err(lookup)?;
                let data = self.linear_query(spec, auth, ownership::LINEAR_ISSUE_QUERY, json!({ "id": issue_id })).await.map_err(lookup)?;
                if ownership::linear_owned(&data["issue"], &me) {
                    Ok(())
                } else {
                    Err(("not_owner", format!("issue {issue_id} is not yours (you are neither its creator nor its assignee); an owner-only row cannot change it")))
                }
            }
            other => Err(("no_owner_rule", format!("ownership is only defined for Shortcut and Linear, not {}", other.name()))),
        }
    }
}
