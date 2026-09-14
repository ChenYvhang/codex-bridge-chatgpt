# Artifact Pipeline

1. Validate the Result contract.
2. Run `artifact-manager.mjs plan <result.json> <workspace-root>`.
3. Acquire and inspect any pending attachment.
4. Review content and adoption status locally.
5. Apply reviewed inline artifacts with the guarded `apply` command.
6. Record final paths and hashes in the execution receipt.

Paths must remain inside the authorized workspace and cannot target nested `.git`, `.codex`, dependency caches, `.env` variants, SSH, or common credential files. Inline artifacts use UTF-8; other encodings are rejected because their written bytes would not match the reviewed content hash. Duplicate artifact ids and target paths are rejected. Create refuses an existing target. Replace and merge compare the live target with `base_sha256`. Before writing any ready file, the apply phase checks every ready artifact against the reviewed plan and current files. It then rechecks each target, writes a sibling temporary file, renames it, and verifies the resulting hash. Multiple files are not one filesystem transaction; if the filesystem changes during application, inspect any files already applied before retrying.

`suggest` artifacts are never applied automatically. Missing attachments and stale bases remain pending or conflicted; the bridge does not claim they were written.
