# Live persistent-context validation / 持续上下文真实联调

Date: 2026-09-13 (Asia/Shanghai)
Surface: Codex desktop on Windows with one existing ordinary ChatGPT Chat
Release candidate: 0.9.0 (rounds 3-4 establish the v0.4 baseline; round 5 validates v0.5 transport and protocol behavior; v0.6-v0.9 local gates validate optimization, continuity, mediated context, MCP, and concurrency)

Rounds 3–5 are historical transport evidence for the 0.9.0 candidate. The v1.0 attempt below is recorded separately and did not pass the browser-copy gate.

This report omits account data and the private Chat identifier. It records observable transport and contract behavior; it does not attest the remote backend model.

本报告不包含账号数据和私有 Chat 标识。它记录可观察的传输与契约行为，不对远端实际模型作密码学证明。

## Successful rounds / 成功轮次

### Round 3: Chat-authored artifact / Chat 编写文件

- Codex sent one schema-v2 artifact request through the app Chat adapter.
- The send operation acknowledged immediately; the new turn became readable after asynchronous polling.
- The response recalled continuity token `ORCHID-27` from earlier Chat history, returned a contract-valid complete-file artifact, and did not claim local access.
- Codex validated identity, idempotency key, schema, UTF-8 byte size, safe path, and content hash before applying the file atomically.
- Applied artifact: `tests/live-bridge/round-3.md`.
- Applied SHA-256: `b59dd27bd7b122fb1af07071c96aae73b333166ece18e21335e3479f824735c7`.
- Codex sent the local execution receipt to the same Chat and observed `ACK-ROUND-3`.

### Round 4: receipt-anchored recall / 回执锚定的上下文召回

- Codex sent only a compact delta plus receipt and checkpoint anchors. The request intentionally omitted the prior artifact path and content hash.
- The same Chat returned the exact path and SHA-256 from the acknowledged round-3 receipt.
- The schema-v2 review result, adoption record, execution receipt, and updated checkpoint all validated.
- Codex sent the second receipt and observed `ACK-ROUND-4`.

### Round 5: compact protocol and recovery / 紧凑协议与恢复

- The same Chat acknowledged the one-time `compact-v1` bootstrap, then accepted a native object delta without repeated response-format prose.
- The request used about 336 locally estimated tokens, versus 622 for the preceding full-v2 review request. Protocol overhead fell from about 141 to 52 estimated tokens. The rounds had different objectives, so this is an observed comparison rather than a controlled benchmark.
- The Chat recalled `ORCHID-27` from earlier context even though the request did not state its value.
- The first response used object-shaped `findings`; deterministic validation rejected it. One bounded repair returned string findings and passed the request-result pair validator.
- The repair path added the invalid response turn to the delivery baseline, retrieved the replacement by the same idempotency key, and never resent the original request.
- The local cost report counts the invalid response separately as wasted response tokens, making repair overhead visible.

### Round 7: v1.0 scoped continuation, unverified copy / v1.0 作用域续接、复制未验证

- After migrating the historical schema-v2 runtime with an exact backup, Codex sent one bounded `compact-v1` review request to the same visible ordinary Chat. The request omitted the earlier continuity token and carried an opaque `conversation_scope_id`.
- The page visibly displayed a reply recalling `ORCHID-27` and echoing the scope. Its first review shape was invalid; one explicitly approved repair message visibly returned a review-shaped JSON answer with the same identity.
- The visible Copy action was activated once for the repaired answer. Neither the browser clipboard API nor a read-only page clipboard check yielded verifiable response bytes. Under the browser transport contract, visible page text is insufficient to import a Result; the observed answer must not be counted as a validated transfer.
- The provisional locally reconstructed result, adoption, and receipt were invalidated. A hash-verified prior checkpoint restored `last_completed_round` to 5. Round numbering stays at 7, the attempt remains in the private journal, and the bridge is `PAUSED` until deliberate reconciliation. No further message was sent.
- This is evidence of page-visible continuity and scope echo, **not** a completed v1.0 end-to-end Browser handoff or a validated remote-model identity.

## Transport findings / 传输结论

- App send acknowledgement means queued, not immediately visible. Delivery lag was tens of seconds to about a minute in this run.
- Reliable retrieval uses bounded `read_thread` polling and matches the round idempotency key before accepting the completed agent message.
- `wait_threads` is a Codex-task primitive and rejected the ordinary ChatGPT conversation during this run.
- The visible browser fallback successfully sent a prior test request, but its single Copy action did not update the browser clipboard. The browser adapter therefore failed closed and did not retry or extract the response from the DOM.

## v0.6 optimized local workflow / v0.6 本地优化工作流

- `start` was verified to compact, validate, budget-check, write, and prepare a round in one operation.
- A repeated semantic request reused its completed local result without allocating a new round or sending another Chat message.
- Workspace fingerprint or checkpoint changes disabled reuse deterministically.
- Oversized or secret-bearing specs failed while state remained `READY` at the same round number.
- Unique evidence over a field limit was rejected rather than silently truncated; retained code and log strings preserved internal whitespace.

## Local gates / 本地闸门

- Three consecutive persistent rounds completed with request, result, adoption, receipt, and checkpoint records; round 5 used `compact-v1`.
- Full repository suite: 98 passed, 0 failed.

## v1.0 local release controls / v1.0 本地发布控制

- Schema-v3 state derives and validates one opaque scope for the bridge, normalized Chat, and canonical workspace. Requests, results, context pulls, manifests, and verified-result reuse are bound to it.
- State and Chat replacement use hash-bound preview/apply transactions. Old state bytes are backed up and verified before atomic schema migration.
- Project MCP setup is previewed before apply, preserves unrelated config, rejects stale plans and unmanaged collisions, and removes only its marked block.
- Public support bundles exclude prompts, responses, source, paths, Chat identity, account data, credentials, and the private scope key.
- The release builder inventories every included source file, excludes runtime state, produces byte-identical archives, and runs Doctor from an extracted package.
- These are local contract and packaging results. The separate round-7 attempt above does not add a completed Browser transport claim.

## v0.8 mediated context / v0.8 按需上下文

- `dry-run` prepared round 6 from the existing five-round runtime, attributed 50 approximate tokens across four context sources, stayed within budget, and left the persistent round and timestamps unchanged.
- A deliberately oversized context pull was rejected at 1,433 approximate tokens against a 1,200-token ceiling. No response file was created and nothing was sent.
- After narrowing the requested file range and search result limit, the same runtime prepared three integrity-bound context items in 712 approximate tokens against a 1,000-token ceiling.
- The successful response combined bounded file lines, literal workspace search, and the latest verified receipt summary. It contained no denied item, did not mutate bridge state, and remained pending for explicit review and a single send.

## v0.9 local MCP and concurrency / v0.9 本地 MCP 与并发

- The dependency-free STDIO server completed initialize, notification, tool-list, and tool-call JSON-RPC exchanges without non-protocol stdout.
- Five tools are exposed with closed input schemas and read-only annotations; unknown tools, extra arguments, arbitrary commands, and invalid token budgets fail closed.
- Against the existing five-round runtime, status, a 70-token dry run, and a two-item bounded context pull completed in one STDIO process. The state file remained byte-for-byte unchanged and no response file was created.
- A live write lease blocked a second writer, a dead stale lease was atomically reclaimed, and two writers that had read one revision could not both commit.

## v0.7 continuity and recovery / v0.7 上下文延续与恢复

- The private health view reports checkpoint and receipt integrity, context age, pending work, transport capabilities, latest verification, and local token estimates without the stored Chat reference or absolute workspace root.
- Question batching normalizes duplicates and separates user decisions from Codex answers and live local checks.
- Recovery export requires a current durable checkpoint, verifies its input hashes, removes volatile local facts and local identity, rejects likely secrets, and stays within a hard approximate-token ceiling. The existing five-round private runtime produced a 493-token recovery packet without sending it.
- Seven focused v0.7 tests pass. No additional message was sent to the live Chat because these features are local preparation and recovery controls.
- Doctor: `READY`; portable verifier: passed.
- The final ZIP is extracted and the same gates are rerun from the packaged copy before release.
- Doctor: `READY`.
- Portable verifier: passed.
- The final ZIP was extracted and the same test and verifier gates passed from the packaged copy.
