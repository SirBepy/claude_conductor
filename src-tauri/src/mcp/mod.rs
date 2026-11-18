mod dispatch;
mod dispatch_broker;
mod dispatch_browser;
mod dispatch_jarvis;
mod dispatch_subchat;
mod relay;
pub mod server;
mod tool_schemas;
mod tool_schemas_broker;
mod tool_schemas_core;
mod tool_schemas_coordination;
mod tool_schemas_jarvis;
mod tool_schemas_picks;
mod tool_schemas_retro;
mod tool_schemas_subchat;
pub(crate) mod tool_schemas_workflow;

/// Runs one tool call through the real `tools/call` routing with the HTTP transport swapped for
/// `post`, as the broker's end-to-end tests do (the model's view of a call, without a `claude`).
#[cfg(test)]
pub(crate) fn dispatch_for_test(
    name: &str,
    args: &serde_json::Value,
    session_id: &str,
    post: fn(&tokio::runtime::Runtime, &str, serde_json::Value) -> Result<serde_json::Value, String>,
) -> serde_json::Value {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    dispatch::dispatch_tool_with(&rt, &serde_json::json!(1), name, args, session_id, 0, post)
}
