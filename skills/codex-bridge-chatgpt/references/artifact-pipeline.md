# Artifact Pipeline

1. Validate the Result contract.
2. Run `artifact-manager.mjs plan <result.json> <workspace-root>`.
3. Acquire and inspect any pending attachment.
4. Review content and adoption status locally.
5. Apply reviewed inline artifacts with the guarded `apply` command.
6. Record final paths and hashes in the execution receipt.

Paths must remain inside the authorized workspace and cannot target `.git`, `.codex`, dependency caches, `.env`, SSH, or common credential files. Create refuses an existing target. Replace and merge compare the live target with `base_sha256`. The apply phase rechecks that the target did not change after planning, writes a sibling temporary file, renames it, and verifies the resulting hash.

`suggest` artifacts are never applied automatically. Missing attachments and stale bases remain pending or conflicted; the bridge does not claim they were written.
