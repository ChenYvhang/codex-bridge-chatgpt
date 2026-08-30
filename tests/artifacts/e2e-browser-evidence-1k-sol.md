# Browser Evidence — architecture-2026-08-30-1k

source: Codex in-app browser DOM
origin: https://chatgpt.com
account_ui: Pro
requested_reasoner: GPT-5.6 Sol

## Preflight

- Captured before submitting the Packet in the authenticated ChatGPT tab.
- Account control exposed `一宿君 Pro`.
- The thinking-intensity menu exposed `menuitemradio "GPT-5.6 Sol" [checked]`.
- The Packet was then submitted in the same claimed browser tab without navigation to another browser surface.

## Postflight

- Captured after the response completed and before local acceptance.
- Conversation path was present under `https://chatgpt.com/c/[redacted-conversation-id]`.
- Account control still exposed `一宿君 Pro`.
- `menuitemradio "GPT-5.6 Sol"` count: `1`.
- `aria-checked`: `true`.
- `END_REASONING_RESULT` was visible in the completed response.

## Evidence Boundary

This proves that the authenticated ChatGPT UI visibly selected GPT-5.6 Sol before submission and after completion. It is UI-level evidence, not cryptographic proof of the backend model.
