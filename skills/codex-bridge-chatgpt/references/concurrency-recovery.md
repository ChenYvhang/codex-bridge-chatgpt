# Concurrency and lease recovery

All persistent state commits use `.write-lease` inside the bridge runtime directory. The lease is short-lived, exclusive, heartbeat-backed, and tied to a random ownership id.

On `BRIDGE_BUSY`, inspect `bridge_lease_status` and retry after the reported operation completes. Do not manually delete a live lease.

A lease is reclaimed only when both conditions hold: its heartbeat exceeds the stale interval and its PID is no longer alive. Reclamation first renames the whole directory to an ownership-unique quarantine path, then removes that quarantine. Release uses the same rename-before-remove rule and verifies the lease id.

`STATE_CONFLICT` means another process committed after the caller read state. Reload status and repeat the intended operation against the new state. Never retry a send operation merely because a local state commit conflicted; first inspect the bound round and delivery record.

Schema-v1 and schema-v2 state are upgraded explicitly with `migrate-state`. The upgrade runs under the write lease, saves and verifies the exact original bytes, records migration provenance, and atomically publishes schema-v3 state. Never replace corrupt or newer state with an empty default.

Read-only status and health callers may pass `since_revision`. When it matches the current revision, return only the current status, revision, and `unchanged: true` so polling does not repeatedly load the same context.

Journal records are written before the atomic state replacement. `context-state.mjs recover` acquires the same write lease, selects the latest valid journal snapshot, aborts any uncertain in-flight round, increments its revision, and restores a safe root status. Recovery never authorizes resending an uncertain Chat message.
