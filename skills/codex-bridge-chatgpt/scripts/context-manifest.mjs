import { createHash } from 'node:crypto';
import { estimateTokens } from './token-budget.mjs';

const DELTA_SOURCES = [
  'user_intent',
  'newly_verified_facts',
  'invalidated_facts',
  'evidence',
  'constraints',
  'previous_receipt',
  'checkpoint',
  'expected_outputs',
  'questions',
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function present(value) {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function entry(source, value, previousValue = undefined) {
  if (!present(value)) return { source, status: 'skipped', reason: 'not supplied or removed by compaction', approximate_tokens: 0, sha256: null, reused: false };
  const digest = sha256(value);
  const reused = present(previousValue) && sha256(previousValue) === digest;
  return {
    source,
    status: 'included',
    reason: reused ? 'unchanged value was retained in this packet' : null,
    approximate_tokens: estimateTokens(value),
    sha256: digest,
    reused,
  };
}

export function buildRequestContextManifest(request, { previousRequest = null } = {}) {
  const currentDelta = request?.context_delta && typeof request.context_delta === 'object' ? request.context_delta : {};
  const previousDelta = previousRequest?.context_delta && typeof previousRequest.context_delta === 'object' ? previousRequest.context_delta : {};
  const entries = [
    entry('objective', request?.objective, previousRequest?.objective),
    entry('routing', request?.routing, previousRequest?.routing),
    entry('workspace', request?.workspace, previousRequest?.workspace),
    ...DELTA_SOURCES.map((source) => entry(`context_delta.${source}`, currentDelta[source], previousDelta[source])),
  ];
  return {
    schema_version: 1,
    kind: 'outgoing_request',
    bridge_id: request?.bridge_id ?? null,
    conversation_scope_id: request?.conversation_scope_id ?? null,
    round: request?.round ?? null,
    request_sha256: sha256(request),
    entries,
    totals: {
      approximate_tokens: entries.reduce((sum, item) => sum + item.approximate_tokens, 0),
      included: entries.filter((item) => item.status === 'included').length,
      skipped: entries.filter((item) => item.status === 'skipped').length,
      redacted: 0,
      truncated: 0,
      reused: entries.filter((item) => item.reused).length,
    },
  };
}

export function buildResponseContextManifest(items) {
  const entries = items.map((item) => {
    if (item.status !== 'ok') {
      const redacted = item.error === 'SENSITIVE_CONTENT';
      return {
        source: `${item.kind}:${item.id}`,
        status: redacted ? 'redacted' : 'skipped',
        reason: item.error ?? 'request denied',
        approximate_tokens: 0,
        sha256: null,
        reused: false,
      };
    }
    const truncated = item.data?.truncated === true || item.data?.has_more === true;
    return {
      source: `${item.kind}:${item.id}`,
      status: truncated ? 'truncated' : 'included',
      reason: truncated ? 'bounded response has more source content' : null,
      approximate_tokens: estimateTokens(item.data),
      sha256: item.sha256,
      reused: false,
    };
  });
  return {
    schema_version: 1,
    kind: 'context_response',
    entries,
    totals: {
      approximate_tokens: entries.reduce((sum, item) => sum + item.approximate_tokens, 0),
      included: entries.filter((item) => item.status === 'included').length,
      skipped: entries.filter((item) => item.status === 'skipped').length,
      redacted: entries.filter((item) => item.status === 'redacted').length,
      truncated: entries.filter((item) => item.status === 'truncated').length,
      reused: 0,
    },
  };
}
