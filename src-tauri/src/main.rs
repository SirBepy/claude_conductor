#![windows_subsystem = "windows"]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--mcp-permission") {
        claude_conductor_lib::mcp::server::run_stdio();
        return;
    }
    // Started by a browser as the bridge extension's native messaging host.
    if claude_conductor_lib::daemon::browser::bridge::native_host::is_host_invocation(&args) {
        claude_conductor_lib::daemon::browser::bridge::native_host::run_stdio();
        return;
    }
    claude_conductor_lib::run();
}
