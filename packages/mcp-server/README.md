# @fastowl/mcp-server

MCP (Model Context Protocol) server exposing FastOwl task + backlog
operations as first-class tools to Claude. Think of it as the typed,
documented-schema version of `@fastowl/cli` — Claude sees it as tools
rather than a shell binary to invoke.

## Tools exposed

- `fastowl_create_task` — spawn a new task in the current workspace
- `fastowl_list_tasks` — list tasks filtered by status/type
- `fastowl_mark_ready_for_review` — stop current task and move it to
  `awaiting_review`
- `fastowl_list_backlog_items` — show backlog items and their state
- `fastowl_list_backlog_sources` — show configured backlog sources
- `fastowl_sync_backlog_source` — re-read a source file to pick up edits
- `fastowl_schedule` — kick the Continuous Build scheduler

Tool inputs default to `$FASTOWL_WORKSPACE_ID` / `$FASTOWL_TASK_ID` from
the MCP server's process environment, so most commands work argument-free
when FastOwl spawned the Claude session.

## Install

From the monorepo:

```bash
npm run build -w @fastowl/mcp-server
```

The binary lands at `packages/mcp-server/dist/index.js`. Register it in
Claude's MCP config (macOS path shown; see Anthropic docs for other OSes):

```jsonc
// ~/.claude/mcp_servers.json
{
  "mcpServers": {
    "fastowl": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp-server/dist/index.js"],
      "env": {
        "FASTOWL_API_URL": "http://localhost:4747"
      }
    }
  }
}
```

For agents FastOwl spawns, the parent backend injects
`FASTOWL_API_URL`, `FASTOWL_WORKSPACE_ID`, and `FASTOWL_TASK_ID` as inline
env vars on the command, so the MCP tools pick them up automatically —
Claude can just call `fastowl_create_task({ prompt: "..." })` with no
workspace id.

## Dev

```bash
npm run dev -w @fastowl/mcp-server     # tsx watch via stdio
npm test -w @fastowl/mcp-server        # 7 vitest tests
```
