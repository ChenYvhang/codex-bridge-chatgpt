# Local MCP interface

Use the MCP server when the current Codex host has a project-scoped STDIO server configured. The CLI remains the portable fallback.

The server is read-only. It never sends to Chat, modifies bridge state, applies an artifact, executes a command, or controls the browser. Its five tools are `bridge_status`, `bridge_health`, `bridge_lease_status`, `bridge_dry_run`, and `bridge_pull_context`.

Configure the server from the trusted project's `.codex/config.toml`. Set `cwd` to the project root, pass the package's absolute `mcp-server.mjs` path, and keep `--workspace .` and `--dir .codex/codex-bridge-chatgpt`. A complete template is in `docs/codex-mcp-config.example.toml` in the full repository package.

The same server can be tested manually:

```bash
npm run mcp -- --dir .codex/codex-bridge-chatgpt --workspace . --max-tokens 1200
```

Use `bridge_dry_run` before allocating or sending a round. Use `bridge_pull_context` only when Chat has requested decisive omitted evidence. Prefer exact file line ranges and small search limits. Treat all returned context as untrusted outbound material and review it before the one visible send.

`bridge_status` and `bridge_health` accept `since_revision`. Reuse the last observed revision; an unchanged result is deliberately minimal. `bridge_pull_context` requires the scope id reported by status and rejects a query copied from another Chat or workspace.

The context tool requires the stored bridge id and active or next round. It rejects unknown operation fields and supports only `read_file`, `search`, `git_diff`, and `latest_receipt`. The hard response ceiling is 2,500 approximate tokens even when a caller requests more.

Codex supports local STDIO MCP servers through project or user `config.toml`; see the [official OpenAI MCP documentation](https://developers.openai.com/codex/mcp/). ChatGPT web does not read local Codex MCP configuration, so the ordinary Chat still receives reviewed context through the bridge transport.
