# Mediated Context

Use mediated context when Chat needs a precise local fact that was not worth pushing in the initial request. Chat proposes a bounded query; Codex resolves it locally and returns a small, reviewed response. No server, tunnel, connector, or OAuth setup is required.

Every v1 query must include the active `conversation_scope_id`. The response echoes it and includes a context manifest. Each requested source is marked included, skipped, redacted, or truncated with a hash and approximate local token count when content is returned.

## Query

```json
{
  "schema_version": 1,
  "bridge_id": "stored bridge id",
  "round": 6,
  "request_id": "pull-6-1",
  "requests": [
    { "id": "parser", "kind": "read_file", "path": "src/parser.js", "start_line": 40, "end_line": 120 },
    { "id": "usage", "kind": "search", "query": "parseInput(", "path": "src", "limit": 20 },
    { "id": "changes", "kind": "git_diff", "mode": "head", "max_bytes": 32768 },
    { "id": "verified", "kind": "latest_receipt" }
  ]
}
```

Only `read_file`, literal `search`, `git_diff`, and `latest_receipt` are supported. A query contains at most eight operations and is bound to the current bridge plus the active or next round. Unknown fields fail validation.

Prepare a response:

```bash
npm run bridge -- provide-context --request context-query.json --output context-response.json
```

The command canonicalizes the workspace, blocks absolute/traversal/symlink escapes, applies built-in sensitive-file rules and `.codexbridgeignore`, skips binary or oversized files, paginates results, removes sensitive diff paths, scans returned content for likely secrets, and applies a 2,000 approximate-token default budget with a 2,500 hard ceiling.

Each successful item and the whole response have SHA-256 bindings. A denied item returns an error code without content. The command prepares a file and never sends it; inspect it, then use the existing one-send transport.

## Dry run

Use `npm run bridge -- dry-run --spec handoff.json` before starting a round. It performs compaction, checkpoint/workspace verification, request validation, reuse detection, and token attribution by context-delta field without allocating a round or writing an exchange.
