# Compact Protocol Bootstrap

Send this protocol description once when binding a new ordinary Chat. Later rounds use `protocol: "compact-v1"` and omit repeated format instructions. Re-send the bootstrap only after Chat migration, a protocol-version change, or a contract failure that shows the protocol is no longer retained.

Every compact result repeats `schema_version`, `protocol`, `bridge_id`, `round`, `idempotency_key`, `profile`, and `summary`, then adds only its profile fields:

- `plan`: `decisions`, `questions`, `context_update`.
- `review`: `decisions`, `findings`, `questions`, `context_update`; `findings` is an array of strings.
- `diagnosis`: `decisions`, `hypotheses`, `questions`, `context_update`; `hypotheses` is an array of strings.
- `artifact`: `artifacts`, `instructions_for_codex`, `questions`, `context_update`.
- `checkpoint`: `questions`, `context_update`.

`questions` and `instructions_for_codex` are arrays of strings. Decision objects contain `decision`, `basis`, and `confidence`. Artifact objects use the manifest in `context-contracts.md`. `context_update` contains `proposed_entries`. Return one JSON object without a Markdown fence. Do not claim local access or execution; Codex reports observed outcomes in the next receipt.
