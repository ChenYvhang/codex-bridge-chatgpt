BEGIN_REASONING_RESULT
packet_id: smoke-2026-08-30

## Verdict

Use a minimal deterministic handoff contract consisting of a versioned packet format, explicit evidence/inference separation, proposed changes, and verification requirements. Avoid building a platform; keep the handoff as a standalone artifact that Codex can validate before applying edits.

## Assumptions

The standalone skill directory is the only intended integration point.

The handoff output is consumed by Codex as a review artifact rather than an autonomous change mechanism.

## Evidence Used

The repository state specifies a new standalone skill directory.

No production deployment or remote write is authorized.

The acceptance criteria require a small safe design and Codex verification before editing.

The evidence indicates the browser can exchange text but the selected model is unverified.

The constraints require preserving dirty worktrees, following repository instructions, and keeping credentials/private sources local.

## Proposed Changes

Define a small handoff schema containing packet_id, verdict, assumptions, evidence used, proposed changes, tests, risks, and unknowns.

Add a local validation step that checks required fields, packet_id preservation, and that proposed changes are concrete before Codex applies edits.

Require Codex to inspect repository instructions, current worktree state, and affected files locally before accepting any proposed change.

Keep the skill implementation standalone with no remote writes, credential handling, or deployment hooks.

## Tests

Submit a sample packet and verify the returned result preserves the same packet_id.

Validate that missing required sections cause rejection.

Confirm Codex can compare proposed changes against local repository state before editing.

Confirm no credentials or unrelated private source content are included in generated handoffs.

## Risks

A vague proposal may cause incorrect edits; mitigate by requiring file/component-specific proposed changes and local verification.

An unverified model/session may create false confidence; mitigate by treating model identity as unknown unless locally verified.

Future expansion into a larger platform may increase risk and complexity; mitigate by keeping the contract intentionally small.

## Unknowns

The actual repository instructions and affected files Codex will encounter locally.

Whether the current browser session or selected model can be verified by available local checks.
END_REASONING_RESULT
