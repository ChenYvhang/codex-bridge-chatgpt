# Source Audit: Oracle and Codex with ChatGPT

Audited snapshots:

- `steipete/oracle` at `e93c8a4c835af9288d992460f87c3cfb0aea84d1`
- `XiaoDuoYa/codex-with-chatgpt` at `9663b88753e35c76796c5bce000293e0bd22cd9e`

This is a source-level audit of the cloned repositories, not only their READMEs.

## Oracle

Strong implementation patterns:

- `src/oracle/files.ts` resolves literals/globs, respects `.gitignore`, avoids following glob symlinks, limits individual files, and produces deterministic file sections.
- `src/oracle/tokenStats.ts` attributes tokens per file; `src/cli/dryRun.ts` resolves the exact engine/browser plan without sending.
- `src/sessionStore.ts`, `src/sessionManager.ts`, and `src/cli/sessionLineage.ts` preserve durable session metadata and follow-up lineage.
- `src/browser/promptFingerprint.ts`, reattach helpers, and harvest-integrity checks bind recovery to the intended prompt/conversation.
- `src/browser/tabLeaseRegistry.ts` is an unusually careful cross-process lease implementation: exclusive directory locks, process-start identity, heartbeat, stale-owner recovery, atomic registry replacement, and fail-closed shared-browser cleanup.
- MCP inputs use strict schemas and durable detached sessions instead of forcing callers to poll or retain long output in agent context.

Gaps we can improve on:

- Oracle is optimized for explicit file bundling, not a workspace security boundary. Explicit absolute inputs may be outside the current project by design.
- Its file-selection path has size/ignore controls but no general pre-send secret-content gate comparable to this bridge's request validator.
- Browser operation is a large CDP automation surface with many DOM compatibility paths and a private automation profile; it is powerful but operationally heavier than direct Codex app coordination.
- Session and provider breadth does not provide our structured adoption, base-hash conflict, receipt, and durable-memory authority model.

## Codex with ChatGPT

Strong implementation patterns:

- `src/workspace/manager.ts` canonicalizes the deepest existing ancestor, blocks symlink/path escapes, denies binary input, and enforces line/byte pagination.
- `src/workspace/ignore.ts` separates irreversible sensitive denies, custom `.c2cignore`, and high-noise hiding.
- `src/workspace/git.ts` filters sensitive rename provenance as well as ordinary diff paths.
- `src/mcp/server.ts` exposes small read-only tools with separate scopes and explicit untrusted-workspace warnings.
- `src/execution/sanitize.ts` hard-rejects private keys, redacts common tokens and home paths, and caps lines/bytes before recorded output becomes readable.
- `src/auth/store.ts` hashes opaque tokens, rotates refresh tokens, binds them to a workspace, and keeps authorization codes one-time and in memory.
- `src/pairing/manager.ts` uses unbiased CSPRNG codes, constant-time hashes, TTL, attempt limits, IP throttling, and one-time destruction.
- `src/session/state.ts` stores explicit protocol checkpoints and caps each HANDOFF field.

Gaps we can improve on:

- The advanced path requires a daemon, ChatGPT connector configuration, OAuth state, and either a quick or named Cloudflare tunnel. That is substantial setup and creates a public authenticated surface.
- The control plane depends on browser UI automation even though the data plane is robust.
- Execution records are appended JSONL without the request/result/adoption/receipt hash chain used by this bridge.
- Test claims and execution summaries originate from Codex records; they are independently readable but not cryptographically bound to the exact request and adopted result.
- The default scope filter grants every supported scope when no recognized scope is requested. A stricter least-privilege negotiation can fail closed instead.
- Recovery checkpoints cap text by truncation; this bridge can reject oversized unique durable context and require an explicit refresh.

## v0.8 direction

The first v0.8 increment implements a transport-neutral, Codex-mediated pull path:

1. Chat requests exact local evidence through a bounded JSON request.
2. Codex resolves the request under the canonical workspace, deny rules, pagination, and secret-content checks.
3. Codex returns a hash-bound context response under a fixed token ceiling.
4. The existing app transport sends it once; no daemon, connector, OAuth token, or public endpoint is required.
5. A dry-run report attributes cost to each context source before a round is allocated.

This creates a lightweight pull mode now and a stable provider contract for an optional authenticated MCP adapter later.
