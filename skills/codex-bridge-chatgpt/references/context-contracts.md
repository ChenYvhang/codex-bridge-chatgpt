# Context Contracts

Schema v2 binds every active-round object with `bridge_id`, `round`, and `idempotency_key`. Request and Result share one response `profile`. New rounds use `protocol: "compact-v1"`; the earlier full-v2 shape remains valid for existing exchanges.

## Compact request

Send the full format rules once from [protocol-bootstrap.md](protocol-bootstrap.md). Later requests contain an object delta without JSON-in-JSON escaping:

```json
{
  "schema_version": 2,
  "protocol": "compact-v1",
  "bridge_id": "uuid",
  "round": 6,
  "idempotency_key": "pending",
  "profile": "review",
  "objective": "Review the parser change",
  "context_delta": {
    "user_intent": ["Check correctness"],
    "newly_verified_facts": ["Targeted tests pass"],
    "invalidated_facts": [],
    "evidence": ["parser.ts changed"],
    "constraints": ["Keep Node 18 support"],
    "previous_receipt": {"round":5,"idempotency_key":"key","sha256":"64 hex","accepted":[],"rejected":[],"deferred":[]},
    "checkpoint": {"through_round":5,"sha256":"64 hex"},
    "expected_outputs": ["Concise review"],
    "questions": [],
    "history_token_estimate": 2400
  }
}
```

`routing` and the sanitized `workspace` fingerprint are optional when they change the remote decision. Set `idempotency_key` to `pending`; `context-state.mjs prepare` replaces it atomically with the request-derived key. The compact protocol must be acknowledged for the bound Chat before preparation.

## Profile-specific compact results

Every result repeats the identity fields, `protocol`, `profile`, and `summary`, then returns only the fields required by that profile:

| Profile | Required profile fields |
|---|---|
| `plan` | `decisions`, `questions`, `context_update` |
| `review` | `decisions`, `findings`, `questions`, `context_update` |
| `diagnosis` | `decisions`, `hypotheses`, `questions`, `context_update` |
| `artifact` | `artifacts`, `instructions_for_codex`, `questions`, `context_update` |
| `checkpoint` | `questions`, `context_update` |

Example review result:

```json
{"schema_version":2,"protocol":"compact-v1","bridge_id":"uuid","round":6,"idempotency_key":"key","profile":"review","summary":"No blocker","decisions":[{"decision":"Accept","basis":"Evidence","confidence":"high"}],"findings":[],"questions":[],"context_update":{"proposed_entries":[]}}
```

## Artifact manifest

Artifact results contain complete-file manifests:

```json
{"artifact_id":"artifact-1","path":"docs/design.md","media_type":"text/markdown","encoding":"utf8","operation":"create","delivery":"inline","content":"Complete file","base_sha256":null,"declared_sha256":null,"size":13}
```

Operations are `create`, `replace`, `merge`, or `suggest`. Existing-target `replace` and `merge` require the current base hash. Attachments remain pending until acquired and inspected locally.

## Adoption, receipt, and checkpoint

These local authority records retain their full schema-v2 shapes:

```json
{"schema_version":2,"bridge_id":"uuid","round":6,"idempotency_key":"key","status":"accepted","accepted_artifact_ids":[],"rejected_artifact_ids":[],"notes":[],"verification_tier":"targeted"}
```

```json
{"schema_version":2,"bridge_id":"uuid","round":6,"idempotency_key":"key","accepted":[],"rejected":[],"deferred":[],"artifacts":[],"checks":[],"implementation_summary":"Observed local result","new_facts":[],"open_questions":[]}
```

```json
{"schema_version":2,"bridge_id":"uuid","through_round":6,"objective":"Durable objective","workspace":{"fingerprint_id":"sha256","canonical_root":"/workspace"},"entries":[]}
```

Validate with `validate-context.mjs request|result|pair|adoption|receipt|checkpoint`. Schema v1 and full schema-v2 exchanges remain compatible.
