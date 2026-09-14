# Changelog

## 1.0.0 - 2026-09-14

- Bound every bridge to an opaque HMAC-derived conversation scope covering the normalized Chat reference, bridge identity, and canonical workspace fingerprint; context pulls now require the same scope.
- Added schema-v3 state migration with exact source backups, SHA-256 verification, migration provenance, integrity checks, and idempotent re-entry from v0.8/v0.9 state.
- Added hash-bound Chat migration previews that reject expired previews and any intervening state, scope, workspace, bridge, or checkpoint change.
- Added per-request and per-response context manifests with source hashes, token estimates, reuse, skipped, redacted, and truncated states.
- Added revision-aware MCP status and health reads that return a minimal `unchanged` result when no observable state changed.
- Added transactional project setup and removal with a reviewable plan, base/target hashes, managed configuration blocks, conflict detection, and backups.
- Added a public-safe support bundle that omits prompts, responses, source, local paths, Chat references, account data, credentials, and private scope keys.
- Added Release Doctor, a machine-readable release policy, zero-dependency inventory, deterministic ZIP creation, SHA256SUMS, repeated-build comparison, and extracted-package Doctor tests.
- Expanded the v1.0 test and verification gates for scope tampering, v2 upgrades, migration transactions, setup conflicts, diagnostic privacy, quiet polling, reproducible packaging, and clean extracted installs.
- Final review blocked symbolic-link escapes in mediated search and artifact writes, bound applied artifacts to their reviewed content and metadata, and confined setup and release inputs to their intended project paths.
- Queue STDIO MCP input lines before asynchronous dispatch and wait for each response to flush, so short-lived clients receive complete JSON on macOS.
- Resolve executable and module paths before the CLI entry check, including macOS `/var` aliases and linked package directories; Doctor now verifies the shared entry helper.
- Hardened the same 1.0.0 source against nested protected paths, duplicate artifact ids/targets, non-UTF-8 inline artifacts, and partial application caused by a stale later file in the batch.
- Made mediated context pulls fail closed when ignore rules cannot be read and return fixed error codes instead of local filesystem paths; malformed Chat URLs can no longer fall back to a raw credential-bearing reference.
- Kept lease acquisition failures from deleting another writer's lock; cleanup now requires ownership of the newly created lock.

## 0.9.0 - 2026-09-14

- Added a dependency-free, project-scoped STDIO MCP server with five closed-schema, read-only tools for status, health, lease inspection, request dry runs, and bounded context pulls.
- Added Codex MCP configuration guidance aligned with the official STDIO `config.toml` contract; the server opens no port and requires no daemon, tunnel, OAuth flow, or credential.
- Added an exclusive write lease with ownership ids, process liveness, heartbeats, bounded waits, atomic quarantine, and dead-owner stale recovery.
- Added monotonic state revisions and compare-before-commit conflict detection so concurrent stale writers fail with `STATE_CONFLICT` instead of silently replacing newer state.
- Changed state persistence to a write-ahead journal followed by atomic state replacement, and protected journal recovery with the same lease.
- Added eight v0.9 tests covering lease ownership, stale recovery, concurrent writers, MCP schemas, read-only behavior, rejection boundaries, and real STDIO framing.

## 0.8.0 - 2026-09-14

- Audited Oracle and Codex with ChatGPT at pinned public source commits and documented reusable patterns, limitations, and attribution boundaries.
- Added `bridge dry-run` with full preflight, reuse detection, no state mutation, and per-context-source token attribution.
- Added `bridge provide-context` for hash-bound, Codex-mediated `read_file`, literal `search`, filtered `git_diff`, and latest-receipt requests.
- Added canonical workspace containment, absolute/traversal and sensitive-file denial, `.codexbridgeignore`, binary/size/line limits, sensitive diff filtering, likely-secret content denial, and a 2,500-token hard ceiling.
- Added eight focused v0.8 tests for privacy, containment, pagination, source filtering, strict schemas, integrity binding, and non-mutating dry runs.

## 0.7.0 - 2026-09-14

- Added `bridge health` with checkpoint/receipt integrity, context age, pending-work, capability, receipt, cost, and warning summaries that omit private Chat and workspace identifiers.
- Added deduplicated question batching that keeps authorized evidence and local checks in Codex and asks the user for related decisions once.
- Added `bridge recovery-export`, a hash-bound and secret-scanned migration packet with a 2,000-token default budget and 2,500-token hard ceiling.
- Recovery export now blocks stale checkpoints, altered receipt/checkpoint files, active rounds, likely secrets, oversized context, and output overwrites.
- Added seven v0.7 continuity, privacy, integrity, and fail-closed tests while preserving the schema-v2 runtime.

## 0.6.0 - 2026-09-14

- Added `bridge start` to compact, budget-check, validate, write, and prepare a persistent request in one command.
- Added deterministic context-delta trimming, normalized deduplication, fail-closed per-field limits, and hash-only receipt/checkpoint anchors.
- Added `bridge optimize` with before/after token estimates, optional optimized-file output, and a hard 3,000 approximate-token send ceiling in the low-level state machine.
- Added verified-result reuse for semantically identical requests only when the workspace fingerprint and checkpoint hash remain unchanged.
- Added a dedicated v0.6 verification gate and retained full v0.5 exchange compatibility.

## 0.5.0 - 2026-09-13

- Added a one-time `compact-v1` Chat bootstrap, object context deltas, and profile-specific result schemas to remove repeated format instructions and JSON-inside-JSON escaping.
- Added a deterministic app delivery adapter with pre-send baselines, idempotency matching, bounded polling, recoverable timeouts, and an explicit never-resend signal.
- Added local approximate-token accounting for requests, responses, protocol overhead, duplicate content, and avoided history; no usage data leaves the workspace.
- Added `status`, `resume`, `inspect`, and `cost` commands that hide the stored Chat reference by default and give one safe next action.
- Kept full schema-v2 exchanges readable and required a fresh compact-protocol acknowledgement after Chat migration.

## 0.4.0 - 2026-09-13

- Verified two consecutive live ordinary-Chat rounds on Windows: one Chat-authored artifact was locally adopted and its receipt was recalled in the next delta-only round.
- Documented the app adapter's asynchronous queue semantics: send once, poll `read_thread` by idempotency key, and keep unresolved delivery recoverable. `wait_threads` is not used for ordinary ChatGPT conversations.
- Added schema-v2 round identity with request-derived idempotency keys and explicit request, result, adoption, receipt, and checkpoint lifecycle records.
- Added workspace fingerprints, structured memory freshness, stale local-fact invalidation, receipt-anchored context deltas, and journal recovery.
- Added deterministic Chat/Codex/hybrid routing with privacy classes, user overrides, reason codes, and verification tiers.
- Added complete-file artifact manifests, protected-path checks, attachment pending states, base-hash conflict detection, race rechecks, atomic placement, and post-write hashes.
- Added question routing, transport capability negotiation, pause/resume/unbind, Chat migration history, v1 state migration, and compatible/incompatible steering behavior.
- Kept the upstream one-shot Packet/Result/browser workflow compatible while expanding persistent ordinary-Chat collaboration.

## 0.3.0 - 2026-09-12

- Added a persistent ordinary-ChatGPT-Chat mode with stable chat identity and monotonic handoff rounds.
- Added project-local state, append-only lifecycle journal, exchange hashes, durable checkpoints, and checkpoint-gated Chat migration.
- Added planning, file drafting, review, reasoning, and checkpoint request modes.
- Added structured file artifact and execution-receipt contracts with path traversal and protected-directory rejection.
- Preferred direct desktop app chat coordination when available; retained explicitly consented visible browser automation as a fallback.
- Added deterministic persistent-context validators and eight new behavioral tests.

## 0.2.0 - 2026-09-01

- Added versioned, persistent user consent before any automatic ChatGPT browser action.
- Marked automatic web handoff as Unofficial Experimental with explicit non-zero account and policy risk.
- Restricted each invocation to one Packet, one visible Send activation, and one visible copy-response action.
- Removed DOM response extraction, automatic repair retries, model fallback, and quota-exhaustion triggers.
- Added fail-closed blockers for login, CAPTCHA, rate limits, unusual activity, account restrictions, permissions, ambiguous controls, and selector drift.
- Kept receipts redacted by default and reinforced that imported ChatGPT output is untrusted.
- Added bilingual first-run, revocation, privacy, troubleshooting, and security guidance.

## 0.1.2 - 2026-08-30

- Forced canonical LF text checkouts so SHA-256 evidence remains stable on Windows.

## 0.1.1 - 2026-08-30

- Made the npm test command portable across POSIX shells and Windows PowerShell.

## 0.1.0 - 2026-08-30

- Added the `codex-bridge-chatgpt` Skill and Plugin-ready package.
- Added automatic local Doctor and guided desktop Browser preflight.
- Added bounded Context Packet and structured Reasoning Result contracts.
- Added local adoption gate, privacy checks, artifact hashes, and complete run receipts.
- Added Mac and Windows CI, installation guides, security policy, and architecture documentation.
- Added English-first and Simplified Chinese README documentation with localized architecture diagrams.
