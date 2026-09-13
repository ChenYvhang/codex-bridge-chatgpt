# Persistent Context

Bind one ordinary ChatGPT Chat to one named goal and workspace. The binding authorizes routine minimized planning, drafting, review, and receipt messages for that goal until the user pauses or unbinds it. Sensitive data and external side effects still require current authorization.

## Three memory layers

1. The Chat keeps semantic history, drafts, style, and discussion.
2. `checkpoint.json` keeps structured entries that Codex accepted or verified.
3. `exchanges/<round>/` keeps immutable request, result, adoption, and receipt evidence.

Chat history is useful context; it is not authority for the live computer. A `local_fact` checkpoint entry needs freshness metadata and becomes `stale` when its file hash or workspace state changes.

## Bind and run

```bash
node scripts/context-state.mjs init --chat-ref <stable-id-or-url> --chat-title <title> --transport <app-thread|in-app-browser> --goal <goal> --workspace <root>
node scripts/context-state.mjs begin --profile <plan|artifact|review|diagnosis|checkpoint> --workspace <root>
```

For a newly bound or migrated Chat, send [protocol-bootstrap.md](protocol-bootstrap.md) once and record its acknowledgement before the first compact round:

```bash
node scripts/context-state.mjs protocol-ready --protocol compact-v1 --evidence <acknowledgement>
```

Build an object delta with `build-context-delta.mjs`; do not replay the transcript or serialize the delta into a JSON string. Estimate the round with `token-budget.mjs`. Prepare the request, mark the send, record the paired result, adoption decision, and execution receipt, then complete:

```bash
node scripts/context-state.mjs prepare --round <n> --request <request.json>
node scripts/context-state.mjs sent --round <n> [--baseline <pre-send-read.json>]
node scripts/context-state.mjs app-observe --round <n> --snapshot <read-thread.json>
node scripts/context-state.mjs result --round <n> --result <result.json>
node scripts/context-state.mjs adopt --round <n> --adoption <adoption.json>
node scripts/context-state.mjs receipt --round <n> --receipt <receipt.json>
node scripts/context-state.mjs complete --round <n> [--checkpoint <checkpoint.json>]
```

Round numbers and idempotency keys are never reused. An ambiguous send is aborted. An incompatible user correction supersedes the active round; a compatible correction is queued for the next delta:

```bash
node scripts/context-state.mjs steer --compatibility <compatible|incompatible> --instruction <text>
```

## Checkpoints

Checkpoint after five rounds, a scope or acceptance change, material workspace change, detected contradiction, ledger growth, or before Chat migration. Chat may propose entries; Codex admits only accepted decisions and verified facts.

Use `memory-ledger.mjs` to refresh freshness. Prefer [optimized-workflow.md](optimized-workflow.md) and `npm run bridge -- start` for new rounds. Use [continuity-workflow.md](continuity-workflow.md) for health, batched questions, and bounded Chat recovery. Lower-level lifecycle commands remain available through `context-state.mjs`. See [session-lifecycle.md](session-lifecycle.md) and [context-recovery.md](context-recovery.md).
