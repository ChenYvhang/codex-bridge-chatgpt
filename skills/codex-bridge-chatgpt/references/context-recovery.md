# Context Recovery

Use recovery when state is corrupt, the designated Chat is inaccessible, or the user selects a replacement.

1. Run `context-state.mjs recover` when `state.json` is corrupt. Recovery uses the newest valid journal snapshot and aborts any recovered in-flight round.
2. Refresh `checkpoint.json` with `memory-ledger.mjs`; reopen current files and mark stale `local_fact` entries.
3. Ask the user to select one replacement ordinary Chat only when the stored Chat cannot be reached.
4. Run `npm run bridge -- recovery-export --output recovery.json`. It requires a current checkpoint, verifies checkpoint and receipt hashes, excludes volatile local facts and private local identity, scans for likely secrets, and applies a hard token ceiling.
5. Send the resulting bundle once to the user-selected replacement Chat. Do not replay the transcript.
6. Validate the replacement Chat's `ACK-RECOVERY` response and compact-protocol bootstrap response.
7. Migrate only after a durable checkpoint exists:

```bash
node scripts/context-state.mjs preview-chat-migration --chat-ref <new-ref> --chat-title <title> --transport <transport> --reason <reason> --output /path/to/chat-migration.json
node scripts/context-state.mjs apply-chat-migration --preview /path/to/chat-migration.json
```

The prior identity stays in `chat.history`. The bridge never silently changes the Chat. A schema v1 runtime state must first use:

```bash
node scripts/context-state.mjs migrate-state --workspace <root>
```

Schema-v3 migration saves the exact prior state under `backups/`, verifies its SHA-256, records provenance, and publishes the new state atomically. A failed preflight or integrity check returns `MIGRATION_REQUIRED` and leaves the source state available for inspection.
