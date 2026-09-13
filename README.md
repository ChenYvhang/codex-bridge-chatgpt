# Codex Bridge to ChatGPT

**English** | [简体中文](README.zh-CN.md)

[![CI](https://github.com/ChenYvhang/codex-bridge-chatgpt/actions/workflows/ci.yml/badge.svg)](https://github.com/ChenYvhang/codex-bridge-chatgpt/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-1.0.0-10a37f)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-43853d)](package.json)

An open-source Codex Skill and Plugin-ready package that keeps one ordinary ChatGPT Chat as a persistent planning, writing, review, and reasoning partner while Codex retains local evidence, computer actions, artifact adoption, edits, and tests.

This project is built directly on upstream commit `56e36c2feeb6705376c1d1dc50dbec52ea43d4f4`; see [UPSTREAM.md](UPSTREAM.md) for the retained base and local additions.

```text
$codex-bridge-chatgpt Diagnose this complex bug, implement the fix, and verify it locally.
```

No OpenAI API key or background service. Direct desktop app chat coordination is preferred when available. The visible ChatGPT Web fallback pauses for one explicit browser-risk decision before its first automated send.

> **Unofficial Experimental:** automatic ChatGPT web control carries non-zero account risk and may trigger safeguards, temporary restrictions, or account action. This project is not affiliated with or endorsed by OpenAI. It cannot guarantee policy compliance, account safety, model availability, or permanent separation between ChatGPT and Codex allowances. Full automation remains disabled until the user explicitly accepts this disclosure.

![Codex Bridge to ChatGPT architecture](assets/codex-bridge-chatgpt-architecture.en.png)

Maintained diagram source: [docs/architecture/codex-bridge-chatgpt-v1.en.architecture.json](docs/architecture/codex-bridge-chatgpt-v1.en.architecture.json).

Version 1.0 binds one normalized Chat, one bridge, and one canonical workspace through an opaque conversation scope. It adds safe state upgrades, context-source manifests, revision-based quiet reads, preview/apply setup and Chat migration, private diagnostics, and reproducible release artifacts while retaining the local-only [v0.9 MCP and concurrency](docs/superpowers/specs/2026-09-14-v0.9-mcp-and-concurrency.md) architecture. The [v1.0 design](docs/superpowers/specs/2026-09-14-v1.0-public-release.md), [GitHub landscape audit](docs/v1.0-github-landscape-2026-09-14.md), and [release-readiness record](docs/v1.0-release-readiness.md) separate implementation from publication evidence.

See the sanitized [three-round live persistent-context validation](docs/live-e2e-validation.md) for the tested app adapter, compact protocol, repair recovery, and receipt-anchored recall evidence.

## Why this project exists

Complex debugging, architecture decisions, and multi-option trade-offs often benefit from a stronger reasoning pass. Repository inspection and execution, however, should remain close to the working tree where facts can be checked and changes can be tested.

Codex Bridge to ChatGPT separates those responsibilities:

| Responsibility | Owner |
|---|---|
| Read repository rules, code, tests, and working-tree state | Codex |
| Minimize and sanitize the evidence | Codex |
| Perform the expensive reasoning pass | ChatGPT Web |
| Decide which recommendations are trustworthy | Codex |
| Edit files and run commands | Codex |
| Validate tests and declare completion | Codex |

ChatGPT proposes. Codex verifies and executes.

## What it does

- Starts from one natural-language task and reuses one verified ordinary ChatGPT Chat across later rounds.
- Bootstraps `compact-v1` once per Chat, then uses profile-specific result shapes and object deltas without JSON-inside-JSON escaping.
- Uses app send acknowledgements plus idempotency-keyed read polling, tolerating asynchronous Chat delivery without duplicate sends.
- Reports estimated request, response, protocol, duplicate, and avoided-history tokens locally without telemetry.
- Provides `start`, `optimize`, `status`, `resume`, `inspect`, and `cost` commands for routine operation and recovery.
- Exposes status, health, dry-run, lease inspection, and bounded context pulls through a dependency-free local STDIO MCP server.
- Binds requests and context pulls to an opaque Chat/workspace scope and rejects cross-scope reuse.
- Records which context sources were included, skipped, redacted, truncated, or reused, with local token estimates and hashes.
- Supports revision-based status reads so unchanged polling consumes only a minimal response.
- Previews project setup and Chat migration before applying the exact hash-bound transaction.
- Serializes persistent commits with ownership-checked leases and rejects stale concurrent writers instead of losing state.
- Trims empty and duplicate delta content before sending and blocks requests above 3,000 approximate input tokens.
- Reuses the last verified result only when semantic content, workspace fingerprint, and checkpoint hash are unchanged.
- Delegates planning, long-form writing, file drafting, review, and high-cost reasoning.
- Routes each step to Chat, Codex, or both with recorded reasons, privacy handling, and a verification tier.
- Sends bounded context deltas instead of replaying the full conversation or repository.
- Anchors deltas to the previous execution receipt and checkpoint digest.
- Stores a durable local checkpoint so context can recover or migrate without replaying the transcript.
- Invalidates stale file-backed facts when the workspace changes.
- Applies complete-file artifacts only after path, base hash, race, and content-hash checks.
- Runs Automatic Doctor before the first handoff.
- Requires versioned risk consent before any ChatGPT browser action.
- Checks the supported desktop surface, in-app Browser, ChatGPT login, and requested model.
- Compresses decisive repository evidence into a bounded 1–3K approximate-token Context Packet.
- Removes likely credentials and unrelated repository context before transmission.
- Uses the Codex in-app Browser instead of an ordinary browser profile.
- Requires ChatGPT to return a structured Reasoning Result.
- Treats all web output as untrusted data.
- Records every recommendation as `accepted`, `rejected`, or `deferred`.
- Reconstructs edits and test commands from current local repository state.
- Binds Packet, Result, browser evidence, and run status with SHA-256 receipts.
- Declares completion only after the deterministic `complete` gate passes.

## Workflow

1. **Invoke** — the user names `$codex-bridge-chatgpt` in a real repository task.
2. **Preflight** — Automatic Doctor validates the installed package and runtime.
3. **Chat binding** — the Skill verifies and stores one ordinary ChatGPT Chat as the continuing context owner, then records one `compact-v1` protocol acknowledgement.
4. **Transport selection** — direct app chat coordination is preferred and uses bounded read polling after send acknowledgement; browser fallback requires explicit versioned consent and preflight.
5. **Local evidence** — Codex reads project instructions, status, relevant code, and tests.
6. **Prepare once** — `bridge start` compacts and validates the delta, enforces its budget, reuses an identical verified result when safe, or leaves one canonical request ready to send.
7. **Chat work** — the continuing Chat plans, writes, reviews, or reasons and returns a structured result or file artifact.
8. **Pair validation** — Codex verifies bridge identity, round, result structure, and returned file paths.
9. **Local adoption gate** — Codex independently verifies each proposed change.
10. **Edit and test** — Codex applies accepted artifacts, reconstructs actions, and runs local checks.
11. **Receipt and checkpoint** — Codex returns verified outcomes to the same Chat and updates durable local context.

## How it works

### Persistent context

The ordinary ChatGPT Chat retains semantic history. Project-local state records the stable Chat reference and monotonic rounds, while a compact checkpoint stores only locally accepted decisions, invariants, open questions, and artifacts. Each later request is a delta from the last verified execution receipt. If the Chat must be replaced, the checkpoint becomes the migration boundary.

### Context Packet

The outbound Packet contains only the information needed to change the decision:

- objective;
- acceptance criteria;
- relevant repository state;
- decisive evidence;
- constraints;
- explicit questions for the reasoner.

The validator rejects malformed markers, missing sections, duplicate fields, oversized Packets, and common credential patterns.

### Reasoning Result

ChatGPT must separate evidence from inference and return a fixed result contract containing a verdict, assumptions, evidence used, proposed changes, tests, risks, and unknowns. A matching `packet_id` binds the answer to the request.

### Local adoption gate

A valid Result is not permission to execute it. Codex reopens the relevant local files and symbols, verifies every accepted recommendation, and reconstructs commands or patches itself. Commands, paths, patches, and test strings from the webpage are never passed directly to tools.

### Run receipt

The final receipt records:

- Packet, Result, and browser-evidence SHA-256 hashes;
- observed Codex and ChatGPT model UI evidence;
- privacy-review fields;
- accepted, rejected, and deferred recommendations;
- local modification and test status.

Hashes bind local artifacts. They do not cryptographically attest the remote backend model.

## Requirements and support

- Node.js 18 or newer.
- A Mac or Windows ChatGPT desktop App environment with Codex.
- The Codex in-app Browser capability and `browser:control-in-app-browser` Skill.
- A ChatGPT Web session that can visibly access the requested model.

| Surface | V1 status |
|---|---|
| macOS ChatGPT desktop App + Codex | Supported target; locally exercised |
| Windows ChatGPT desktop App + Codex | Supported target; package gates run in Windows CI |
| Codex CLI | Local MCP tools supported; no in-app Browser fallback |
| Codex IDE extension | Local MCP tools supported; no in-app Browser fallback |
| Linux | Local logic, MCP, and packaging tested in CI; desktop Browser workflow unavailable |

The deterministic package is tested on Linux, macOS, and Windows. End-to-end web transport still depends on the Browser capabilities exposed by the user's desktop App version.

## Installation

### Recommended: Skill Installer

If your Codex installation includes `$skill-installer`, send this in Codex:

```text
$skill-installer Install codex-bridge-chatgpt from https://github.com/ChenYvhang/codex-bridge-chatgpt/tree/main/skills/codex-bridge-chatgpt
```

Open a new Codex task after installation so the Skill list is reloaded.

### Manual installation on macOS

```bash
git clone --depth 1 https://github.com/ChenYvhang/codex-bridge-chatgpt.git
mkdir -p "$HOME/.codex/skills"
cp -R codex-bridge-chatgpt/skills/codex-bridge-chatgpt "$HOME/.codex/skills/"
```

### Manual installation on Windows PowerShell

```powershell
git clone --depth 1 https://github.com/ChenYvhang/codex-bridge-chatgpt.git
New-Item -ItemType Directory -Force "$HOME\.codex\skills" | Out-Null
Copy-Item -Recurse "codex-bridge-chatgpt\skills\codex-bridge-chatgpt" "$HOME\.codex\skills\"
```

If the destination already exists, back it up and compare versions instead of overwriting it blindly.

The repository also includes a validated [Codex Plugin manifest](.codex-plugin/plugin.json). The Skill directory is the canonical workflow; the Plugin is its distribution wrapper.

### Optional local MCP tools

Codex clients support project-scoped STDIO MCP servers. Preview the exact project-local configuration first, inspect the generated plan, then apply that unchanged plan:

```bash
npm run setup -- --workspace . --output bridge-setup-plan.json
npm run setup -- --apply bridge-setup-plan.json
```

Use `--action remove --output bridge-remove-plan.json` to preview removal of only the managed configuration block. Runtime context remains preserved. The server exposes only `bridge_status`, `bridge_health`, `bridge_lease_status`, `bridge_dry_run`, and `bridge_pull_context`; all five are read-only and local. Manual configuration remains documented in [docs/codex-mcp-config.example.toml](docs/codex-mcp-config.example.toml).

The MCP server opens no port and requires no OAuth, tunnel, API key, or background daemon. See [references/local-mcp.md](skills/codex-bridge-chatgpt/references/local-mcp.md) and the [official OpenAI MCP documentation](https://developers.openai.com/codex/mcp/).

## Quick start

Open a repository in Codex and send one task:

```text
$codex-bridge-chatgpt Find the root cause of this intermittent failure, implement the smallest safe fix, and run the relevant tests.
```

Other useful prompts:

```text
$codex-bridge-chatgpt Review this architecture decision and implement the locally verified option.

$codex-bridge-chatgpt Diagnose this performance regression from first principles and verify the fix.

$codex-bridge-chatgpt Compare the plausible designs, choose one with evidence, then modify and test the repository.
```

Use the bridge for unclear root causes, multiple plausible designs, or high-cost technical decisions. Keep mechanical edits, simple lookups, and already-decided plans local.

## First-run Doctor

The natural-language Skill workflow does not require MCP setup. Optional local MCP configuration uses the preview/apply transaction above. The Skill checks installation, then the persistent browser-risk decision, then volatile browser state:

| Status | Meaning | Recovery |
|---|---|---|
| `NEEDS_AUTOMATION_CONSENT` | No current browser-risk decision exists | Read the disclosure and explicitly enable or decline automation |
| `AUTOMATION_DISABLED` | Automatic browser handoff was declined or revoked | Keep work local, or explicitly enable it later |
| `READY` | Current consent and the relevant preflight layer are ready | Continue to the next preflight layer or handoff |
| `MISSING_RUNTIME` | Node.js 18+ is unavailable | Install Node.js 18+ and retry |
| `INVALID_INSTALLATION` | Required Skill files are missing or mismatched | Reinstall the Skill directory |
| `NEEDS_DESKTOP_APP` | The current Codex surface does not support this bridge | Use the Mac/Windows ChatGPT desktop App |
| `NEEDS_BROWSER` | The in-app Browser capability is unavailable | Update or enable the required Browser capability |
| `NEEDS_CHATGPT_LOGIN` | ChatGPT is visibly logged out in the in-app Browser | Take over the page, log in, then reply that login is complete |
| `NEEDS_MODEL_SELECTION` | The requested model is not visible or selected | Select it; the Skill does not substitute another model |
| `NEEDS_SITE_PERMISSION` | Access to `chatgpt.com` needs user permission | Approve access in the desktop App |

The original repository task is preserved across human takeover. Passwords, verification codes, cookies, and recovery codes must never be sent to Codex.

Revoke automatic browser handoff at any time from the installed Skill directory:

```bash
node scripts/automation-consent.mjs disable --json
```

## Privacy and security

The Skill sends only minimized task deltas to the designated Chat. Direct app coordination is preferred. After browser consent, the fallback uses visible in-app Browser controls at `https://chatgpt.com/`. It does not use private ChatGPT endpoints, read cookies or browser storage, require an API key, run a hosted service, or collect telemetry. Imported output remains untrusted until Codex revalidates it locally.

It is designed not to send:

- passwords, tokens, API keys, private keys, cookies, or verification codes;
- `.env` files or raw credential stores;
- complete private repositories or complete uncommitted diffs;
- unrelated source files;
- personal, customer, financial, medical, or organizational data without explicit action-time approval.

Regex scanning cannot understand every business secret, so the workflow also requires a semantic privacy review before transmission.

This project does not bypass ChatGPT plans, model entitlements, login, workspace policy, rate limits, or site security. It cannot turn a Plus account into Pro. Any token or cost savings depend on the user's actual Codex and ChatGPT plans and workload; they are not guaranteed by the Skill.

Risk disclosure reduces surprise; it does not remove risk. Automatic submission and response capture may still be interpreted under applicable service terms or trigger abuse-prevention systems.

See [docs/privacy.md](docs/privacy.md) and [SECURITY.md](SECURITY.md).

## Local verification

The project has no npm dependencies:

```bash
npm test
npm run doctor
npm run doctor:release
npm run validate
npm run release:build
npm run setup -- --workspace . --output bridge-setup-plan.json
npm run bridge -- status
npm run bridge -- health
npm run bridge -- dry-run --spec handoff.json
npm run bridge -- start --spec handoff.json
npm run bridge -- optimize --request request.json
npm run bridge -- questions
npm run bridge -- recovery-export --output recovery.json
npm run bridge -- provide-context --request context-query.json --output context-response.json
npm run bridge -- inspect --round last
npm run bridge -- cost
npm run mcp -- --dir .codex/codex-bridge-chatgpt --workspace . --max-tokens 1200
```

The verification suite covers Doctor states, portable copied installation, Packet/Result validation, compact contracts, app delivery recovery, token accounting, request optimization, scoped reuse, state migration and backups, setup transactions, dry runs, context manifests, quiet polling, secure mediated reads/search/diffs, diagnostic privacy, deterministic packaging, extracted-package checks, health and integrity reporting, question batching, bounded recovery export, secret rejection, hash binding, model evidence, privacy fields, receipt completion, and the architecture asset.

## Repository layout

```text
.
├── .codex-plugin/plugin.json         # Plugin distribution manifest
├── assets/                           # English and Chinese architecture images
├── docs/                             # Installation, first-run, privacy, and design docs
├── scripts/verify.mjs                # Portable package verification
├── skills/codex-bridge-chatgpt/
│   ├── SKILL.md                      # Canonical workflow entrypoint
│   ├── agents/openai.yaml            # Codex interface metadata
│   ├── references/                   # Transport, persistent context, and handoff contracts
│   └── scripts/                      # Doctor, consent, persistent state, and validators
└── tests/                            # Unit, contract, portability, and E2E artifacts
```

## Limitations

- V1 requires desktop app chat coordination or the supported in-app Browser workflow for ordinary-Chat handoffs; the local MCP surface remains read-only.
- Persistent context still depends on ChatGPT conversation retention; the local checkpoint is the recovery boundary when that context is unavailable.
- App send acknowledgement is asynchronous. The bridge polls the bound Chat by idempotency key and keeps an unresolved round recoverable instead of resending it.
- Login, CAPTCHA, two-factor authentication, permissions, and model selection remain human actions.
- Visible model UI is auditable evidence, not cryptographic remote-model attestation.
- ChatGPT page changes can make visible Send or Copy controls uncertain; the Skill stops without DOM response extraction or automatic retry.
- Private repository evidence may require explicit confirmation before transmission.
- A valid Result can still be wrong; local verification remains mandatory.

## Development and contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing workflow behavior. Preserve the central boundary: ChatGPT proposes; Codex verifies, edits, and tests locally.

For model-family terminology, see the [official OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model).

## License

[MIT](LICENSE)
