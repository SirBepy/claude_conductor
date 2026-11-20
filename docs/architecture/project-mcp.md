# Project MCP servers

Read before touching `ProjectConfig.mcp_servers`, the `project_mcp` tool, `hooks_server/project_mcp.rs` or `permission-modal/gating.ts`.

A project's MCP servers (`ProjectConfig.mcp_servers`) can be an HTTP `url` or a local stdio `command` plus `args`, and a stdio one runs on Joe's PC every turn.

- Only Joe's Settings and the `project_mcp` tool write the list: never read it from a repo file, never add a remote method that writes it.
- The tool's `add` must stay behind the approval card `hooks_server/project_mcp.rs` raises: the exact entry is shown, nothing is saved until Joe allows it, and `needsHumanApproval` in `permission-modal/gating.ts` keeps auto-accept from answering it.
- `list` and `remove` skip the card.
- **A signed-in HTTP server's bearer never goes into the generated config** (pc-1784). The child reads `--mcp-config` once, so a header there died with its access token (1 h for rodge) in any chat that outlived it. `project_mcp::servers_for` writes the entry's URL as the daemon's own proxy (`project_mcp_proxy.rs`, route `/mcp-proxy/:id` in `hooks_server/mcp_proxy.rs`), which adds `mcp_oauth::access_token`'s fresh token to each request, so the existing single-flight refresh keeps it alive. Rules: the id is a random per-run value per URL and is the only guard the route has (the hook server has no per-run secret), so never log it with its URL or let a request choose the upstream; request headers are an allowlist and a caller's `authorization` is dropped; `www-authenticate` is not passed back (the CLI must not start its own sign-in against 127.0.0.1); a lapsed sign-in answers 401 and sends nothing upstream. Ids live in memory only, so a daemon restart makes new ones: a child that somehow outlives the daemon keeps its old id (404) until its next turn writes a new config; every turn writes a fresh config (the per-turn `turn_id`). A redirect is followed only within the same scheme, host and port, so the bearer never leaves the origin. stdio servers and open (no sign-in) HTTP servers are written as before.
- A stored list reaches settings.json through the `project_mcp_servers_set` notification, like `project_main_chat_set`.
