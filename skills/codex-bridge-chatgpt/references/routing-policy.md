# Routing Policy

Classify each step by computer dependency, continuing-context value, output weight, verification need, and sensitivity. Run `route-task.mjs` to record a route and reason codes.

- Use Chat for low-computer-dependency planning or writing where persistent context adds value.
- Use hybrid for substantial output that Codex can verify cheaply, or for design followed by local implementation.
- Use Codex for live files, commands, UI, credentials, external actions, or work whose verification costs as much as doing it locally.
- Never send `secret` data. `sensitive` data requires action-time authorization even when the user overrides routing.

Natural-language overrides map to `chat`, `codex`, or `hybrid` for the current step. They do not rewrite the default policy.

Verification tiers are `contract_only`, `targeted`, `local_authority`, and `full`. Remote output never authorizes local execution.
