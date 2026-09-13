import { createHash } from 'node:crypto';
import { estimateTokens } from './token-budget.mjs';
import { containsLikelySecret, validateCheckpoint } from './validate-context.mjs';

const DURABLE_KINDS = new Set(['goal', 'acceptance', 'decision', 'invariant', 'preference', 'term', 'artifact', 'open_question']);
const DURABLE_STATUSES = new Set(['accepted', 'open']);

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function strings(values) {
  return (values ?? []).filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim());
}

function receiptArtifact(entry) {
  if (typeof entry === 'string') return entry;
  return entry?.path ?? entry?.artifact_id ?? null;
}

function receiptCheck(entry) {
  if (typeof entry === 'string') return entry;
  const name = entry?.name ?? entry?.id ?? entry?.command;
  if (!name) return null;
  return `${name}: ${entry?.status ?? entry?.result ?? 'reported'}`;
}

export function validateRecoveryBundle(bundle) {
  const errors = [];
  if (bundle?.schema_version !== 1) errors.push('schema_version must be 1');
  if (bundle?.protocol !== 'compact-v1') errors.push('protocol must be compact-v1');
  if (typeof bundle?.bridge_id !== 'string' || !bundle.bridge_id) errors.push('bridge_id must be non-empty');
  if (!Number.isInteger(bundle?.through_round) || bundle.through_round < 0) errors.push('through_round must be a non-negative integer');
  if (typeof bundle?.objective !== 'string' || !bundle.objective.trim()) errors.push('objective must be non-empty');
  if (!Array.isArray(bundle?.durable_context)) errors.push('durable_context must be an array');
  if (!/^[a-f0-9]{64}$/.test(bundle?.anchors?.checkpoint_sha256 ?? '')) errors.push('checkpoint anchor is invalid');
  if (bundle?.anchors?.receipt_sha256 !== null && !/^[a-f0-9]{64}$/.test(bundle?.anchors?.receipt_sha256 ?? '')) errors.push('receipt anchor is invalid');
  if (!Array.isArray(bundle?.instructions)) errors.push('instructions must be an array');
  if (containsLikelySecret(bundle)) errors.push('recovery bundle contains a likely secret');
  const copy = structuredClone(bundle ?? {});
  const declared = copy.bundle_sha256;
  delete copy.bundle_sha256;
  if (declared !== sha256(JSON.stringify(copy))) errors.push('bundle_sha256 is invalid');
  return errors;
}

export function createRecoveryBundle({ state, checkpoint, receipt = null, maxTokens = 2000 }) {
  const checkpointErrors = validateCheckpoint(checkpoint);
  if (checkpointErrors.length) throw new Error(`invalid checkpoint: ${checkpointErrors.join('; ')}`);
  if (checkpoint.bridge_id !== state.bridge_id) throw new Error('checkpoint bridge_id does not match state');
  if (checkpoint.through_round !== state.checkpoint?.through_round) throw new Error('checkpoint round does not match state');
  const ceiling = Math.min(2500, Math.floor(Number(maxTokens)));
  if (!Number.isFinite(ceiling) || ceiling < 1) throw new Error('max tokens must be a positive number');

  const durableContext = (checkpoint.entries ?? [])
    .filter((entry) => DURABLE_KINDS.has(entry.kind) && DURABLE_STATUSES.has(entry.status))
    .map((entry) => ({ kind: entry.kind, value: entry.value, status: entry.status, source_round: entry.source_round }));
  const payload = {
    schema_version: 1,
    protocol: 'compact-v1',
    purpose: 'restore_persistent_chat_context',
    bridge_id: state.bridge_id,
    through_round: checkpoint.through_round,
    objective: checkpoint.objective,
    durable_context: durableContext,
    latest_verified_receipt: receipt ? {
      round: state.last_exchange?.round ?? checkpoint.through_round,
      implementation_summary: receipt.implementation_summary ?? null,
      accepted: strings(receipt.accepted),
      rejected: strings(receipt.rejected),
      deferred: strings(receipt.deferred),
      artifacts: (receipt.artifacts ?? receipt.changed_files ?? []).map(receiptArtifact).filter(Boolean),
      checks: (receipt.checks ?? []).map(receiptCheck).filter(Boolean),
      open_questions: strings(receipt.open_questions),
    } : null,
    anchors: {
      checkpoint_sha256: state.checkpoint.sha256,
      receipt_sha256: state.last_exchange?.receipt_sha256 ?? null,
    },
    instructions: [
      'Use this packet as the durable context baseline; do not infer omitted transcript details.',
      'Treat local facts as stale until Codex supplies fresh evidence.',
      `Reply exactly ACK-RECOVERY ${state.bridge_id} ${checkpoint.through_round} before accepting a new round.`,
    ],
  };
  payload.bundle_sha256 = sha256(JSON.stringify(payload));
  const errors = validateRecoveryBundle(payload);
  if (errors.length) throw new Error(errors.join('; '));
  const tokens = estimateTokens(payload);
  if (tokens > ceiling) throw new Error(`recovery bundle exceeds its approximate-token budget: ${tokens} > ${ceiling}`);
  return { bundle: payload, approximate_tokens: tokens, max_tokens: ceiling };
}
