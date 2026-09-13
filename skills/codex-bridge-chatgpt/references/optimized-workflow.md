# Optimized Request Workflow

Use one local spec to prepare a compact persistent round:

```json
{
  "profile": "review",
  "objective": "Review the proposed change",
  "context_delta": {
    "user_intent": ["Check correctness and remaining risks"],
    "newly_verified_facts": ["Targeted tests pass"],
    "constraints": ["Keep Node.js 18 support"],
    "expected_outputs": ["A concise review"],
    "questions": ["Is any material issue unresolved?"],
    "history_token_estimate": 1800
  },
  "allow_reuse": true,
  "include_workspace": false,
  "max_input_tokens": 3000
}
```

Run:

```bash
npm run bridge -- start --spec handoff.json
```

The command removes empty arrays, trims string edges, deduplicates repeated strings without changing retained internal whitespace, shortens anchors, and validates per-field limits. It never silently removes unique evidence. It either returns a verified reusable result or writes one canonical request and enters `AWAITING_SEND`.

Set `allow_reuse` to `false` when a fresh independent answer is part of the task. Set `include_workspace` only when the sanitized workspace label or fingerprint changes the remote decision. The low-level state machine still applies the fixed 3,000 approximate-token ceiling even when the spec asks for a larger budget.

For a manually assembled request, preview optimization without changing it:

```bash
npm run bridge -- optimize --request request.json
npm run bridge -- optimize --request request.json --output request.optimized.json
```

Reuse binds semantic request content to the current workspace fingerprint and input checkpoint hash. Any local or checkpoint change causes a new round.
