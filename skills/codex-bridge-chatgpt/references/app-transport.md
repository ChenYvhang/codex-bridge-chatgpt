# App Chat Transport

Use the Codex desktop app's task coordination tools when they can address an existing ordinary ChatGPT Chat. Bind the stable Chat id once and keep the same id across rounds.

## Send and retrieval protocol

1. Read the Chat before sending and save the response as a baseline snapshot.
2. Mark the prepared round sent with `context-state.mjs sent --baseline <snapshot.json>`, then call the app send operation exactly once.
3. Treat the send acknowledgement as queue acceptance. It is not proof that the message is already visible or complete.
4. Poll the app read operation at bounded intervals. Match the new user message by the round's `idempotency_key`, then wait for the agent message in that same turn to reach `completed`.
5. Persist the exact agent message as `result.json` and validate the request/result pair before adoption.

Save each normalized `read_thread` response and pass it through `context-state.mjs app-observe --snapshot <snapshot.json>`. The deterministic driver returns `poll_read`, `persist_result`, `resume_read_later`, or `inspect_failure`; every return includes `should_resend: false`. Use `app-resume` after a timed-out delivery becomes readable later.

Observed desktop delivery can lag the send acknowledgement by about a minute. An empty first read is normal. Do not send the request again while delivery is pending. If the bounded polling window expires, preserve the round as recoverable `AWAITING_RESULT`; resume reads later or abort explicitly after establishing that the delivery state cannot be resolved.

`wait_threads` is for Codex tasks and may reject ordinary ChatGPT conversations. Use `read_thread` polling for Chat conversations unless the runtime explicitly demonstrates a Chat-compatible wait capability.

App transport may send one repair message after a completed but contract-invalid response. After sending it once, run `context-state.mjs app-repair --round <n>` so the original response turn becomes part of the baseline, then resume `app-observe`. The repair contains only the validator errors, the same round identity, and a request for a complete replacement result. Stop after the second invalid response. Never use repair to resend a response whose delivery status is merely unknown.

Record `read`, `send`, `read_after_write`, and `structured_result_retrieval` only after observing them on the bound Chat. Capabilities remain unavailable by default.
