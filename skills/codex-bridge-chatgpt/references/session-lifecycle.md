# Session Lifecycle

The workspace-local state machine is:

```text
READY -> PREPARING -> AWAITING_SEND -> AWAITING_RESULT -> VALIDATING
      -> ADOPTING -> EXECUTING -> REPORTING -> CHECKPOINTING -> READY
```

`PAUSED`, `RECOVERY_REQUIRED`, and `BLOCKED_BY_USER_ACTION` are side states. App delivery has its own `QUEUED`, `DELIVERED`, `GENERATING`, `RETRIEVED`, and `RECOVERY_REQUIRED` substates. Failed and invalidated rounds end as `ABORTED` or `SUPERSEDED`; their number and idempotency key are retained in the journal and never reused.

Use `block` when login or another human-only step is required, then `resume` after the user reports completion. `switch-transport` changes the adapter for the same stored Chat and retains the previous adapter record; it does not migrate Chat identity.

Only one mutation round may be active. Every mutation writes `state.json` atomically and appends a journal record with a state snapshot. A completed round requires exact request, result, adoption, and receipt records.

Run `transport-capabilities.mjs` before depending on send, read-after-write, wait, structured retrieval, or attachments. Capabilities default to unavailable until observed, except a stable app Chat identity. Record runtime evidence with `context-state.mjs observe-transport`. A missing required capability blocks that transport. App coordination is preferred; browser fallback retains its separate risk-consent gate.

For app coordination, capture turn IDs before sending. A send acknowledgement advances the round to `AWAITING_RESULT`; it does not prove immediate delivery. Poll `read_thread` for a new turn containing the matching idempotency key and a completed response. Keep the round recoverable while delivery is pending. `wait_threads` is not a ChatGPT-conversation wait primitive unless the runtime explicitly proves otherwise. `resume` continues reading and never resends.

Use `status` for the short state and one next action. Use `health` for transport capabilities, checkpoint age and integrity, pending work, the latest receipt, token estimates, and warnings without exposing the stored Chat reference.

The stable user surface is:

```bash
npm run bridge -- status
npm run bridge -- health
npm run bridge -- dry-run --spec <handoff.json>
npm run bridge -- start --spec <handoff.json>
npm run bridge -- optimize --request <request.json>
npm run bridge -- questions
npm run bridge -- recovery-export --output <recovery.json>
npm run bridge -- provide-context --request <query.json> --output <response.json>
npm run bridge -- resume
npm run bridge -- inspect --round <current|last|n>
npm run bridge -- cost
```

`dry-run` performs round preflight and source-level token accounting without mutation. `start` performs safe one-command preparation or verified-result reuse. `provide-context` resolves a strict, bounded on-demand evidence query without sending it. `optimize` previews request compaction and its budget. `status` returns one next action, `health` explains continuity and integrity, `questions` creates one deduplicated interruption, `recovery-export` prepares a bounded migration packet, `resume` safely continues the active state, `inspect` summarizes one exchange, and `cost` estimates request, response, protocol, duplicate, and avoided-history tokens. Add `--json true` for automation and `--full true` to an explicit inspect request when the complete stored exchange is needed.

Use `bridge questions` or `question-router.mjs batch` for Chat questions. Repeated questions are normalized and removed. Codex answers from authorized local evidence or performs a local check. Product intent, preferences, credentials, policy choices, external side effects, and unknown authority go to the user in one combined prompt.
