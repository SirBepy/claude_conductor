//! Shared extractor: `Json<T>`'s default rejection is plain text, which the
//! MCP relay client can't parse, surfacing as an opaque decode error with no
//! indication of which field was wrong (recurred 5x, todo 581). Delegates to
//! `Json<T>`, converting a rejection into `{"ok": false, "error": ...}`.

use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, Request};
use axum::http::StatusCode;
use axum::Json;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

#[derive(Debug)]
pub(super) struct ValidatedJson<T>(pub T);

#[axum::async_trait]
impl<T, S> FromRequest<S> for ValidatedJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = (StatusCode, Json<Value>);

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(ValidatedJson(value)),
            Err(rejection) => Err(json_error(rejection)),
        }
    }
}

fn json_error(rejection: JsonRejection) -> (StatusCode, Json<Value>) {
    (StatusCode::OK, Json(json!({"ok": false, "error": rejection.to_string()})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::header;
    use serde::Deserialize;

    #[derive(Deserialize, Debug)]
    struct Payload {
        text: String,
    }

    async fn body_json(resp: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn missing_field_rejects_as_clean_json_naming_the_field() {
        let req = Request::builder()
            .method("POST")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"other": "x"}"#))
            .unwrap();
        let err = ValidatedJson::<Payload>::from_request(req, &()).await.unwrap_err();
        let resp = err.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("text"));
    }

    #[tokio::test]
    async fn valid_body_extracts_normally() {
        let req = Request::builder()
            .method("POST")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"text": "hi"}"#))
            .unwrap();
        let ValidatedJson(payload) = ValidatedJson::<Payload>::from_request(req, &()).await.unwrap();
        assert_eq!(payload.text, "hi");
    }
}
