# Project MCP servers

Read before touching `ProjectConfig.mcp_servers`, the `project_mcp` tool, `hooks_server/project_mcp.rs` or `permission-modal/gating.ts`.

A project's MCP servers (`ProjectConfig.mcp_servers`) can be an HTTP `url` or a local stdio `command` plus `args`, and a stdio one runs on Joe's PC every turn.

- Only Joe's Settings and the `project_mcp` tool write the list: never read it from a repo file, never add a remote method that writes it.
- The tool's `add` must stay behind the approval card `hooks_server/project_mcp.rs` raises: the exact entry is shown, nothing is saved until Joe allows it, and `needsHumanApproval` in `permission-modal/gating.ts` keeps auto-accept from answering it.
- `list` and `remove` skip the card.
- A stored list reaches settings.json through the `project_mcp_servers_set` notification, like `project_main_chat_set`.
