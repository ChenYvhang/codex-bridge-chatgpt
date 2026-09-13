# Peer Project Analysis: Oracle and Codex with ChatGPT

Reviewed 2026-09-14 from the public `main` branches.

Sources:

- https://github.com/steipete/oracle
- https://github.com/steipete/oracle/blob/main/docs/browser-mode.md
- https://github.com/steipete/oracle/blob/main/docs/configuration.md
- https://github.com/XiaoDuoYa/codex-with-chatgpt
- https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/main/docs/architecture.md
- https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/main/docs/protocol.md
- https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/main/docs/security.md

## Executive finding

The current bridge remains stronger than its original upstream base in persistent state, adoption gates, artifact integrity, compact requests, local cost reporting, question batching, and bounded recovery. It does not yet dominate these two newer peers.

Oracle is a broader and more mature consultation product. Codex with ChatGPT is the closest architectural peer and currently has the strongest answer to context transfer: a tiny control plane plus an authenticated, read-only MCP data plane through which ChatGPT fetches only the files, searches, diffs, execution records, and sanitized test output it needs.

## Comparison

| Area | This bridge v0.7 | Oracle | Codex with ChatGPT |
|---|---|---|---|
| Primary purpose | Persistent Chat planner/writer with Codex execution | General second-model consultation | Persistent Chat planner/reviewer with Codex execution |
| Chat continuity | Bound Chat, numbered rounds, checkpoint, recovery bundle | Stored sessions and verified follow-ups | Long-chat or ChatGPT Project mode, local checkpoint and HANDOFF |
| Context delivery | Sanitized push deltas and artifacts | Selected file bundle, inline/upload | ChatGPT pulls through read-only MCP |
| Control messages | Compact JSON, hard 3,000-token send ceiling | Prompt plus bundle | Structured messages under 1 KB |
| Local inspection by Chat | Only evidence Codex sends | Only bundled files | Workspace, search, files, git status/diff, tests and execution records |
| Local writes | Chat drafts; Codex validates and applies | Model answers; caller applies | No write tools; Codex applies |
| Adoption integrity | Structured adoption, base hashes, protected paths, atomic placement | Session artifacts and caller workflow | Independent review through current diff; Codex owns writes |
| Security posture | No service or tunnel; secret scan; app-first transport | Browser/API credentials and local sessions | OAuth 2.1, PKCE, workspace-bound tokens, sensitive-file deny list, public tunnel |
| Operating burden | Node only; no background service | Node 24, browser/API setup | Node 20, daemon, OAuth pairing, ChatGPT connector and Cloudflare tunnel |
| Cost visibility | Request/response/protocol/duplicate/avoided-history estimates | Per-file tokens, provider usage/cost, dry run | Very small control messages; data-plane pagination |
| Multi-provider support | ChatGPT only | OpenAI, Azure, Anthropic, Gemini, OpenRouter and browser engines | ChatGPT connector workflow |

## What to adopt

### From Codex with ChatGPT

1. Add an optional `mcp-pull` context adapter. Keep the existing packet adapter as the zero-service default.
2. Split the protocol into a sub-1-KB control message and a read-only data plane.
3. Expose current git diff, test status, execution receipts, and explicitly nominated sanitized logs so ChatGPT can independently review Codex's claims.
4. Bind every data-plane authorization to one canonical workspace and deny secrets, absolute escapes, symlink escapes, and custom ignore patterns before content leaves the machine.
5. Add Project mode as an optional continuity strategy while retaining the local checkpoint as the authority.
6. Add an iteration ceiling and pause instead of allowing an unbounded planning/review loop.

### From Oracle

1. Add `dry-run summary|json|full` and per-file token reporting before a send.
2. Add exact session lineage, verified reattachment, and explicit challenge/revision follow-ups.
3. Add a queue/lock for concurrent browser requests to the same account or profile.
4. Add layered user/project configuration for transport, budgets, ignores, checkpoint cadence, and notification preferences.
5. Keep provider panels and image generation outside the core bridge until the persistent coding workflow is complete.

## What to preserve

- Direct Codex app coordination remains the preferred transport when available.
- No tunnel, OAuth server, or daemon is required for the default mode.
- Chat-authored files continue through the local adoption, base-hash, protected-path, and atomic-write pipeline.
- The local checkpoint and receipt ledger remain the durable authority; Chat memory is a convenience layer.
- No browser resend occurs after uncertain delivery.

## Proposed v0.8 sequence

1. Define a transport-neutral `ContextProvider` contract with `packet-push` and `mcp-pull` capability profiles.
2. Implement a local read-only provider and security tests first: canonical containment, ignore policy, pagination, output sanitization, and workspace binding.
3. Add a local execution-evidence registry backed by existing receipts and test records.
4. Reduce control messages to task id, state, iteration, goal, changed-file count, check summary, and requested next state.
5. Add dry-run and per-source token reports to both adapters.
6. Add an optional remote connector only after the local security contract passes. Keep installation and network exposure opt-in.
7. Validate one full INIT → PLAN → EXECUTED → REVIEW → DONE cycle and one lost-Chat HANDOFF cycle against the same ordinary ChatGPT account.

## Attribution and implementation boundary

Both peer repositories are MIT licensed. Design ideas can inform the bridge, but copied implementation must retain the relevant license and attribution. The preferred path is an independently implemented adapter contract or an explicit interoperability layer, not silent code copying.
