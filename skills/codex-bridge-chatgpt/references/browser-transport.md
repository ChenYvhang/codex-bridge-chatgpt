# Browser Transport

Use only the Codex in-app Browser in the Mac or Windows ChatGPT desktop app. Keep the same claimed ChatGPT tab through submission and extraction.

Automatic preflight returns exactly one status:

- `NEEDS_DESKTOP_APP`: the runtime explicitly identifies CLI, IDE, cloud, Linux, or another unsupported surface.
- `NEEDS_BROWSER`: a supported Mac or Windows desktop surface lacks the required Browser Skill or capability.
- `NEEDS_CHATGPT_LOGIN`: the ChatGPT page visibly shows a logged-out state.
- `NEEDS_MODEL_SELECTION`: the requested model is not visibly selected or available.
- `NEEDS_SITE_PERMISSION`: browser access to ChatGPT is blocked pending user action.
- `READY`: authentication, requested model, and transport capability are visibly available.

When human takeover is needed, keep the original repository task and current Packet draft local. Ask the user to finish the visible login, model, or permission step without sending credentials in chat. On their next message, recheck only the volatile browser state and continue the original task.

Before sending, record a local DOM summary showing the ChatGPT origin, authenticated account UI, and requested model selected. After completion, capture the same facts again with the completed result marker. These are UI-level observations, not cryptographic backend-model proof.

Prefer ChatGPT's copy-response action. If the browser clipboard is empty, extract only the text between the final result markers and restore Markdown `##` from visible heading semantics. Fail explicitly when markers or headings are incomplete; never silently label a partial DOM extraction as transport success.

If authentication, the requested model, or the result contract is unavailable, stop. A fallback model requires explicit user approval.
