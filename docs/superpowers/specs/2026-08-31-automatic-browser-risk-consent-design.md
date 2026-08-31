# Automatic Browser Risk Consent Design

## Status

Approved product direction; written design awaiting final user review before implementation.

## Goal

Preserve the project's defining capability: after one explicit first-run decision, Codex can automatically submit one minimized Context Packet to the user's logged-in ChatGPT web session, wait for one response, import it through the visible copy-response action, and continue local verification.

The workflow must clearly disclose that browser automation is experimental and carries non-zero account and policy risk. Full automation is disabled until the user explicitly accepts that risk, and it can be disabled later.

## Product Decision

V0.2 keeps both selected properties:

- automatic Codex-to-ChatGPT web handoff;
- use of the user's own ChatGPT web subscription and visible signed-in session.

The project does not promise zero account risk, policy compliance, permanent quota separation, model availability, or uninterrupted browser compatibility. It must not present the workflow as a way to bypass Codex limits or turn one plan into another.

The manual copy-and-paste workflow is not the primary product path. The official API is not required for the automatic web mode.

## Consent Boundary

Add a deterministic `automation-consent.mjs` helper with three operations:

- `status`: read the current local decision without changing it;
- `enable`: persist acceptance only when the exact versioned acknowledgement flag is present;
- `disable`: persist that automatic browser handoff is disabled.

The default state is `NEEDS_AUTOMATION_CONSENT`. Declining or revoking produces `AUTOMATION_DISABLED`. A current accepted disclosure produces `READY`.

Consent is stored outside repositories at:

```text
$CODEX_HOME/codex-bridge-chatgpt/automation-consent.json
```

When `CODEX_HOME` is unset, use `~/.codex/codex-bridge-chatgpt/automation-consent.json`. Tests must use an explicit temporary `--state-file` and must never read or change the user's real state.

The state contains only:

- schema version;
- disclosure version;
- `browser_automation_enabled`;
- decision timestamp.

It must not contain account identifiers, ChatGPT cookies, browser data, repository paths, prompts, or model names. Writes are atomic. POSIX files use owner-only permissions where supported.

Changing the disclosure version invalidates earlier acceptance and requires a new decision.

## First-Run Experience

The Skill runs the installation Doctor and then checks consent before opening ChatGPT or preparing a browser action.

When consent is missing or stale, Codex displays this substance without softening it:

> Experimental browser automation submits prompts to and retrieves outputs from ChatGPT web using your signed-in session. This may conflict with service terms or trigger safeguards, temporary restrictions, or account action. The project cannot guarantee account safety or permanent quota separation. It is not intended to bypass limits. Enable it only if you understand and accept the non-zero risk.

Codex asks whether to enable full automatic browser handoff. It may persist `enable` only after an explicit affirmative user response in the current conversation. Silence, unrelated replies, ambiguous approval, or merely invoking the Skill do not count as consent.

If the user declines, Codex persists `disable`, performs no ChatGPT browser action, and continues only with work that can stay local. Re-enabling requires the same explicit disclosure and acknowledgement.

## Automatic Browser Contract

After consent and ordinary Doctor checks pass, one invocation may perform one bounded handoff:

1. Inspect the repository and prepare one minimized, sanitized Packet.
2. Obtain separate action-time confirmation if the Packet contains non-public sensitive context, even when browser automation consent is already enabled.
3. Recheck the visible ChatGPT origin, signed-in state, requested model, and absence of warnings.
4. Submit one Packet through the visible ChatGPT composer.
5. Wait for one completed response.
6. Use only ChatGPT's visible copy-response action to import the marked Result.
7. Validate the Result and return to local adoption, editing, and tests.

The automation must stop rather than retry when submission, completion, copy, markers, headings, authentication, model selection, or validation fails.

The default and documented implementation prohibits:

- DOM text extraction or script-based page scraping;
- background, scheduled, Dockerized, headless, or unattended execution;
- parallel ChatGPT handoffs;
- multi-round browser conversations within one Skill invocation;
- automatic retries, refresh loops, or model fallback;
- CAPTCHA solving, proxies, stealth techniques, cookie access, or anti-detection behavior;
- triggering the bridge because a Codex allowance is exhausted;
- continuing after a rate-limit banner, abuse warning, unusual-activity warning, CAPTCHA, or account restriction.

The Skill delegates only because the task needs high-cost reasoning, not because another product allowance is depleted.

## Documentation and Positioning

English and Chinese public documentation must:

- label automatic browser handoff `Experimental` near the first usage example;
- explain the first-run decision, disable command, and re-consent behavior;
- state that risk cannot be reduced to zero;
- distinguish official in-app Browser availability from permission to automate every website workflow;
- remove quota-arbitrage language, including claims equivalent to “Plus as Pro,” “use spare web quota,” “unlimited,” or “bypass Codex limits”;
- retain the privacy, untrusted-output, local adoption, and receipt boundaries.

The repository remains independent and must not imply OpenAI endorsement.

Updating or republishing an already-public WeChat article is a separate publication action and is not part of the repository implementation.

## Version and Compatibility

Release the behavior change as `0.2.0` because first-run behavior and the browser transport contract change materially.

Existing installations have no consent state, so they default to `NEEDS_AUTOMATION_CONSENT`. No earlier installation is silently grandfathered into automatic browser use.

The implementation remains dependency-free on Node.js 18+ and supports macOS and Windows. It must not install global dependencies or change Codex's general configuration.

## Test Strategy

Use test-first development. New tests must fail before production changes.

Automated tests cover:

- missing state requires consent;
- exact acknowledgement enables automation;
- ambiguous or wrong acknowledgement cannot enable it;
- disable revokes automation;
- stale disclosure versions require re-consent;
- malformed state fails closed;
- test state is isolated from the real Codex home;
- required consent helper is included in copied installations;
- Skill and Browser Transport contain the no-DOM, one-handoff, no-retry, no-quota-trigger rules;
- English and Chinese README files expose the Experimental warning and no-zero-risk statement;
- version metadata is consistently `0.2.0`.

The existing Packet, Result, pair, receipt, complete gate, Doctor, package-layout, Skill-discovery, and sensitive-content checks must remain green.

## Acceptance Evidence

Implementation is complete only when:

1. A fresh temporary installation reports `NEEDS_AUTOMATION_CONSENT` before any acceptance.
2. Explicit versioned acceptance changes that temporary installation to `READY`.
3. Disable changes it to `AUTOMATION_DISABLED` and prevents browser routing.
4. No default workflow contains DOM extraction, automated retry, parallel, headless, Docker, quota-exhaustion, or anti-detection behavior.
5. All Node tests, Doctor, package validation, Packet/Result/pair/receipt/complete gates, Skill validation, and sensitive scan pass with fresh results.
6. The working diff contains no credentials or machine-specific consent state.

Browser policy compliance and account safety remain external uncertainties; local tests cannot certify either one.
