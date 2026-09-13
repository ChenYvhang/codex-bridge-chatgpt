# Codex Bridge to ChatGPT

**English** | [简体中文](README.zh-CN.md)

[![CI](https://github.com/ChenYvhang/codex-bridge-chatgpt/actions/workflows/ci.yml/badge.svg)](https://github.com/ChenYvhang/codex-bridge-chatgpt/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-1.0.0-10a37f)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-43853d)](package.json)

**Keep one ordinary ChatGPT Chat in the loop while Codex works in your repository.** ChatGPT retains the conversation, plans, reasons, reviews, and drafts complete files. Codex gathers current evidence, checks proposed changes against the working tree, applies accepted files, operates the computer, and runs tests. The bridge sends short updates and verified outcomes between them so each round builds on the last without replaying the repository or transcript.

This open-source Codex Skill has an optional local MCP interface. It needs no OpenAI API key, hosted service, or npm dependencies. It builds directly on upstream commit `56e36c2feeb6705376c1d1dc50dbec52ea43d4f4`; see [UPSTREAM.md](UPSTREAM.md) for the retained work and additions.

> **Unofficial Experimental:** Automatic ChatGPT web control carries non-zero account risk and may trigger safeguards, temporary restrictions, or account action. This project is not affiliated with or endorsed by OpenAI. It cannot guarantee policy compliance, account safety, model availability, or permanent separation between ChatGPT and Codex allowances. Browser automation remains disabled until the user explicitly accepts this disclosure.

## Start here

1. Install Node.js 18 or newer and open a repository in a supported Codex desktop environment.
2. If `$skill-installer` is available, send this to Codex:

   ```text
   $skill-installer Install codex-bridge-chatgpt from https://github.com/ChenYvhang/codex-bridge-chatgpt/tree/main/skills/codex-bridge-chatgpt
   ```

3. Open a new Codex task so the Skill list reloads. Give it a real task:

   ```text
   $codex-bridge-chatgpt Find the root cause of this intermittent failure, implement the smallest safe fix, and run the relevant tests.
   ```

The Skill runs its own preflight. If login, model selection, site permission, or a browser-risk decision is needed, it pauses and resumes the original task afterward. The natural-language workflow does **not** require MCP setup. See [installation and upgrades](docs/installation.md) and the [first-run guide](docs/first-run.md) for manual installation and recovery.

## What you can use it for

| Your task | ChatGPT Chat contributes | Codex completes locally |
|---|---|---|
| Investigate a difficult bug | Hypotheses and review of evidence | Reads current code and logs, implements the fix, runs tests |
| Compare designs | Trade-offs and a proposed decision | Checks repository constraints and implements the chosen design |
| Create a document or source file | Drafts a complete-file artifact | Verifies its path, base version, and hash before applying it |
| Continue a long task | Retains prior discussion in the bound Chat | Sends relevant changes and returns a verified receipt |

The bridge is useful when diagnosis or design requires substantial reasoning. Local estimates show request, response, protocol, duplicate, and avoided-history tokens; actual savings depend on the task and account limits. It does not bypass plan limits or grant access to an unavailable model.

## Current validation status

**Version 1.0 source is public; there is no tagged 1.0 release yet.** Deterministic tests, local packaging checks, and the Linux/macOS/Windows CI matrix cover the implementation. Historical live rounds 3–5 demonstrated persistent Chat context, a Chat-authored file, receipt-anchored recall, and compact protocol behavior for the earlier 0.9 candidate. A later v1.0 browser attempt showed a reply on the page but could not verify the bytes returned by the visible Copy control; the bridge rejected that transfer and restored its last verified checkpoint. A fresh, fully verified v1.0 end-to-end handoff is still required before a tagged release.

See the [live validation record](docs/live-e2e-validation.md) and [release-readiness gates](docs/v1.0-release-readiness.md). A green CI badge verifies local contracts, not the availability of ChatGPT or a particular desktop/browser session.

![Codex Bridge to ChatGPT architecture](assets/codex-bridge-chatgpt-architecture.en.png)

[Editable architecture source](docs/architecture/codex-bridge-chatgpt-v1.en.architecture.json)

## Workflow

1. Codex runs Doctor, reads repository rules and relevant files, and binds one Chat to the current workspace.
2. It creates a small, privacy-reviewed Context Packet with the objective, constraints, decisive evidence, and questions. The first exchange establishes `compact-v1`; later exchanges carry deltas.
3. Direct app Chat coordination is preferred where available. The visible in-app Browser path requires a browser-risk decision before its first automated send. An uncertain send or copy stops the round.
4. The same Chat returns a structured Reasoning Result or a complete-file artifact. Codex checks identity, round, structure, paths, hashes, and current local evidence before accepting any part.
5. Codex performs accepted work and tests it. A local receipt records what happened; a compact checkpoint carries accepted decisions and open questions into the next round.

ChatGPT authors proposals and files; Codex controls local adoption and execution. The [v1.0 design](docs/superpowers/specs/2026-09-14-v1.0-public-release.md) describes the protocol in detail.

## How it works

### Persistent context

Version 1.0 binds one normalized Chat, one bridge, and one canonical workspace through an opaque conversation scope. The Chat holds conversational history. Local state stores monotonic rounds, verified receipts, and a compact checkpoint of accepted decisions, invariants, open questions, and artifacts. Workspace changes invalidate stale file-backed facts. Chat migration and older-state upgrades use preview/apply transactions with backups.

### Bounded handoffs

The Context Packet excludes unrelated files and likely credentials, enforces a 3,000 approximate-token input ceiling, and records which sources were included, redacted, shortened, or reused. An identical verified result is reused only when its semantic content, workspace fingerprint, and checkpoint hash still match. Local cost reports make that reuse visible.

### Verification and recovery

The local adoption gate checks complete-file artifacts against the allowed path, base hash, content hash, and current file state. Web output is untrusted data. Accepted, rejected, and deferred recommendations are recorded separately; completion requires a verified receipt. Asynchronous app sends use an idempotency key and bounded read polling, keeping an unresolved round recoverable without automatically resending. SHA-256 receipts bind local artifacts but cannot prove the remote backend model.

## Requirements and surfaces

- Node.js 18 or newer.
- A Codex environment with this Skill installed; ordinary-Chat handoffs require the desktop app's Chat coordination capability or its supported in-app Browser.
- For the browser path, a visible ChatGPT login and requested model. Login, CAPTCHA, two-factor authentication, permissions, and model selection remain user actions.

| Surface | Scope of support |
|---|---|
| macOS desktop app + Codex | Target desktop workflow; earlier live app-adapter rounds exercised |
| Windows desktop app + Codex | Target desktop workflow; deterministic package gates run in CI |
| Codex CLI or IDE extension | Local read-only MCP tools; no in-app Browser fallback |
| Linux | Local logic, MCP, and packaging tested in CI; no desktop Browser workflow |

The desktop handoff depends on capabilities exposed by the user's app version. A visible model label is evidence of UI state, not proof of the backend model.

## Installation

The Skill Installer command in [Start here](#start-here) is the recommended path. [Manual installation, upgrades, and removal](docs/installation.md) are documented separately. The repository also includes a [Codex Plugin manifest](.codex-plugin/plugin.json) for distribution.

### Optional local MCP tools

The project-scoped STDIO MCP server exposes five **local, read-only** tools: `bridge_status`, `bridge_health`, `bridge_lease_status`, `bridge_dry_run`, and `bridge_pull_context`. It opens no port and needs no API key or background daemon. Clone this repository, run the following **from the cloned repository root**, inspect the generated plan, and apply that same plan:

```bash
npm run setup -- --workspace /path/to/your/project --output bridge-setup-plan.json
npm run setup -- --apply bridge-setup-plan.json
```

On Windows, replace `/path/to/your/project` with the absolute path to your workspace. Keep the cloned repository in place while using MCP: the generated configuration points to its local server script. Setup changes only the marked project configuration block. See the [MCP guide](skills/codex-bridge-chatgpt/references/local-mcp.md) and [example configuration](docs/codex-mcp-config.example.toml).

## Quick start

After installation, keep using the same Codex task for repository work. The bridge binds one ordinary ChatGPT Chat and sends later rounds to it. If the Chat must change, the stored checkpoint provides a controlled migration point. Useful requests include:

```text
$codex-bridge-chatgpt Compare these two designs, implement the one supported by this repository, and verify it.

$codex-bridge-chatgpt Draft the migration guide in the same Chat, check it against the current code, and add the verified file.
```

If Doctor reports `NEEDS_AUTOMATION_CONSENT`, read the disclosure before deciding whether to enable the browser path. `AUTOMATION_DISABLED` leaves browser automation off. For `NEEDS_CHATGPT_LOGIN` or `NEEDS_MODEL_SELECTION`, complete that step in the visible app and tell Codex to continue; it retains the task. The [first-run guide](docs/first-run.md) lists other states. Never send a password, code, cookie, or recovery code to Codex.

## Privacy and security

Only minimized task context is intended for the designated Chat. The Skill does not use private ChatGPT endpoints, extract cookies or hidden authentication data, or send telemetry. It blocks common credential patterns and requires a semantic privacy review; private repository evidence or sensitive data can still require a specific decision before transmission. Commands and patches returned by Chat are never executed directly. See [privacy](docs/privacy.md) and [security](SECURITY.md).

Browser automation may be affected by site changes or account safeguards. If a visible Send or Copy action cannot be verified, the round stops and can be inspected or recovered. Risk consent can be revoked from the installed Skill directory with `node scripts/automation-consent.mjs disable --json`.

## Local verification

From the cloned repository root:

```bash
npm test
npm run doctor
npm run validate
```

Release preparation also uses `npm run doctor:release` and `npm run release:build`. Advanced local commands include `npm run bridge -- start`, `npm run bridge -- health`, `npm run bridge -- dry-run`, `npm run bridge -- provide-context`, `npm run bridge -- recovery-export`, `npm run bridge -- cost`, and `npm run mcp`; their arguments and contracts are documented under [Skill references](skills/codex-bridge-chatgpt/references/). These commands are local tools, not extra steps for the first natural-language task.

## Development and license

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing behavior. The [GitHub landscape audit](docs/v1.0-github-landscape-2026-09-14.md) and [upstream record](UPSTREAM.md) explain the project's lineage and design comparisons. Licensed under [MIT](LICENSE).
