# Persistent Chat Context Bridge Design

> Implementation baseline for v0.3. The expanded v0.4 target is defined in [2026-09-12-v0.4-functional-design.md](2026-09-12-v0.4-functional-design.md).

## Problem

The upstream workflow performs a safe, bounded reasoning handoff, but each invocation is effectively isolated. Repacking stable goals and decisions wastes context, limits ChatGPT to proposals, and makes long efforts depend on the user manually carrying state between ChatGPT and Codex.

## Resulting behavior

One ordinary ChatGPT Chat becomes the continuing semantic workspace for planning, writing, review, reasoning, and file authorship. Codex sends incremental, locally verified state, applies returned artifacts, performs computer actions, and returns execution receipts to the same Chat.

The workflow keeps the upstream safety boundary: ChatGPT output is untrusted until Codex validates it against the live workspace. Direct desktop app Chat coordination is preferred. The explicitly consented visible browser workflow remains a fallback and keeps its one-send, one-copy, fail-closed behavior.

## Memory model

The bridge uses three layers:

1. Chat history for rich semantic continuity.
2. A local checkpoint containing only accepted decisions and verified facts.
3. Immutable per-round request and result artifacts plus an append-only event journal.

Later requests carry deltas from the previous execution receipt. The checkpoint is updated after five rounds, major scope changes, or before migration. If the original Chat is lost, Codex corrects the checkpoint against current files and bootstraps a user-selected replacement Chat without replaying the full transcript.

## State machine

```text
UNINITIALIZED -> READY -> ROUND_IN_FLIGHT -> ROUND_COMPLETE -> READY
                                |                 |
                                v                 v
                          ROUND_ABORTED       CHECKPOINTED
                                                    |
                                                    v
                                                MIGRATED
```

Only one round may be in flight. Round numbers never repeat. Completion requires a valid request/result pair whose bridge ID and round match the stored state. Chat migration requires a valid completed checkpoint.

## Artifact model

ChatGPT may return complete inline file content or a named attachment. Each artifact declares a workspace-relative path and `create`, `replace`, or `suggest` intent. Validation rejects absolute paths, traversal, drive-relative Windows paths, `.git`, and `.codex`. Codex acquires and inspects attachments and decides whether each proposal is accepted, rejected, or deferred.

Returned command strings never authorize execution. Codex reconstructs commands from current local evidence and the user's existing authorization.

## Persistent files

The default runtime directory is `.codex/codex-bridge-chatgpt/` in the active project:

```text
state.json
checkpoint.json
journal.jsonl
exchanges/0001/request.json
exchanges/0001/result.json
```

State contains Chat routing metadata, monotonic counters, lifecycle timestamps, and artifact hashes. The checkpoint and exchanges may contain project information and remain untracked by default.

## Compatibility

The original Markdown Context Packet, Reasoning Result, browser consent, adoption gate, and final run receipt remain available for one-shot reasoning. Persistent mode adds JSON contracts and state management without changing the old validators.

## Attribution

This extension is based on the MIT-licensed `anightmonarch/codex-bridge-chatgpt` project and preserves its local-authority, minimized-context, fail-closed transport, and deterministic-validation principles.
