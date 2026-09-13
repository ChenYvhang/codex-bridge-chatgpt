# Continuity and Recovery Workflow

The v0.7 user surface closes the remaining continuity gaps without replaying an entire transcript.

## One health view

Run `npm run bridge -- health` for a private-by-default view of checkpoint age and integrity, durable-entry counts, pending work, transport capabilities, the latest receipt, token estimates, warnings, and recovery actions. The stored Chat reference and absolute workspace root are never included.

## One question interruption

Run `npm run bridge -- questions` to deduplicate pending questions and group them by authority. Codex answers questions backed by already authorized evidence, performs live local checks for local facts, and presents product intent, preference, credential, policy, external-side-effect, or unknown questions to the user in one batch. Use `--input <questions.json>` to route a richer typed question set.

Question batching never collects credential values. A credential-class question indicates that the user must act through the appropriate trusted interface.

## Bounded context migration

Before replacing an inaccessible Chat, finish or abort any active round and refresh the checkpoint through the latest completed round. Then run:

```bash
npm run bridge -- recovery-export --output recovery.json
```

The export verifies checkpoint and receipt hashes, rejects likely secrets, excludes Chat/account identity, absolute workspace paths, rejected memory, and volatile local facts, and enforces a 2,000 approximate-token default budget with a 2,500 hard ceiling. It contains accepted/open durable context, a compact verified receipt, integrity anchors, and an exact recovery acknowledgement.

Select the replacement ordinary Chat yourself and send the bundle once. After verifying its acknowledgement, create a `preview-chat-migration` file and inspect the source scope, state revision, checkpoint, target Chat hash, transport, reason, and expiry. Apply that exact file with `apply-chat-migration`. Exporting and previewing do not send, select, or migrate anything automatically.
