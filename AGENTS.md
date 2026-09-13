# AGENTS.md

## Purpose

This repository contains one Plugin-ready Codex Skill for persistent planning, writing, review, and reasoning handoffs to an ordinary ChatGPT Chat while Codex retains local execution authority.

## Boundaries

- Treat local repository contents as private by default. Send only the minimum sanitized packet required for the task.
- Never include credentials, tokens, private keys, personal data, raw environment files, or unrelated source code in a browser prompt.
- Reuse one verified ordinary ChatGPT Chat across rounds; persist only locally accepted context in the migration checkpoint.
- ChatGPT plans and authors; Codex verifies against the live repository, applies artifacts, edits, and tests.
- Do not claim a ChatGPT account tier or model unless the visible page proves it for the current run.
- Do not install global dependencies. Validation must use the bundled Node.js runtime or the system `node` command.

## Structure

- `.codex-plugin/plugin.json`: Plugin distribution metadata.
- `skills/codex-bridge-chatgpt/SKILL.md`: concise routing and workflow.
- `skills/codex-bridge-chatgpt/references/`: Doctor, browser, packet, result, and receipt contracts.
- `skills/codex-bridge-chatgpt/scripts/`: deterministic local Doctor and validators.
- `.codex/codex-bridge-chatgpt/`: project-local runtime state created when the Skill is used; keep it untracked by default.
- `tests/`: Node built-in tests and sanitized fixtures.
- `assets/`: README and Plugin presentation assets.
- `docs/`: installation, first-run, privacy, troubleshooting, design, and plans.
- `docs/superpowers/specs/`: approved design record.

## Verification

Run:

```bash
node --test tests/*.test.mjs
npm run doctor
npm run validate
```

Before any commit, scan the diff for secrets. Never push or publish without explicit user approval.
