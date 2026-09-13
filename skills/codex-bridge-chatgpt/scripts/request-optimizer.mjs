#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { analyzePayload, estimateTokens } from './token-budget.mjs';

const ARRAY_LIMITS = {
  user_intent: 4,
  newly_verified_facts: 12,
  invalidated_facts: 8,
  evidence: 12,
  constraints: 8,
  expected_outputs: 6,
  questions: 6,
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function uniqueStrings(value, limit) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const output = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    const key = trimmed.replace(/\s+/g, ' ').toLocaleLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    output.push(trimmed);
  }
  if (output.length > limit) throw new Error(`context delta field exceeds its ${limit}-item limit`);
  return output;
}

function compactAnchor(anchor, roundField) {
  if (!anchor || typeof anchor !== 'object') return null;
  const compact = {};
  if (Number.isInteger(anchor[roundField])) compact[roundField] = anchor[roundField];
  if (typeof anchor.sha256 === 'string' && anchor.sha256) compact.sha256 = anchor.sha256;
  return Object.keys(compact).length ? compact : null;
}

export function compactContextDelta(delta = {}, limits = ARRAY_LIMITS) {
  const compact = {};
  for (const field of Object.keys(ARRAY_LIMITS)) {
    let values;
    try { values = uniqueStrings(delta[field], limits[field] ?? ARRAY_LIMITS[field]); }
    catch (error) { throw new Error(`${field}: ${error.message}`); }
    if (values.length) compact[field] = values;
  }
  const receipt = compactAnchor(delta.previous_receipt, 'round');
  const checkpoint = compactAnchor(delta.checkpoint, 'through_round');
  if (receipt) compact.previous_receipt = receipt;
  if (checkpoint) compact.checkpoint = checkpoint;
  const history = Math.max(0, Number(delta.history_token_estimate) || 0);
  if (history) compact.history_token_estimate = Math.floor(history);
  return compact;
}

export function requestSemanticKey(request, { workspaceFingerprint = null, checkpointSha256 = null } = {}) {
  const semantic = {
    conversation_scope_id: request?.conversation_scope_id ?? null,
    protocol: request?.protocol ?? 'full-v2',
    profile: request?.profile ?? request?.mode ?? null,
    objective: request?.objective ?? null,
    context_delta: request?.context_delta ?? null,
    routing: request?.routing ?? null,
    workspace_fingerprint: workspaceFingerprint ?? request?.workspace?.fingerprint_id ?? null,
    checkpoint_sha256: checkpointSha256 ?? request?.context_delta?.checkpoint?.sha256 ?? request?.checkpoint?.sha256 ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical(semantic))).digest('hex');
}

export function optimizeRequest(request, { previousRequest = null, maxInputTokens = 3000 } = {}) {
  const beforeTokens = estimateTokens(request);
  const optimized = structuredClone(request);
  if (optimized.protocol === 'compact-v1') optimized.context_delta = compactContextDelta(optimized.context_delta);
  if (optimized.routing === null) delete optimized.routing;
  if (optimized.workspace === null) delete optimized.workspace;
  const metrics = analyzePayload({
    request: optimized,
    previousRequest,
    historyTokenEstimate: optimized.context_delta?.history_token_estimate ?? 0,
    maxInputTokens,
  });
  const afterTokens = metrics.request_tokens;
  const suggestions = [];
  if (beforeTokens > afterTokens) suggestions.push('use_compacted_delta');
  if (metrics.duplicate_rate >= 0.55) suggestions.push('review_duplicate_context');
  if (metrics.protocol_share >= 0.25) suggestions.push('remove_optional_envelope_fields');
  if (metrics.budget_status === 'over_budget') suggestions.push('split_or_reduce_before_send');
  return {
    request: optimized,
    before_tokens: beforeTokens,
    after_tokens: afterTokens,
    saved_tokens: Math.max(0, beforeTokens - afterTokens),
    saved_rate: beforeTokens === 0 ? 0 : Number(((beforeTokens - afterTokens) / beforeTokens).toFixed(4)),
    metrics,
    suggestions,
  };
}

export function reusableExchange(state, semanticKey) {
  const exchange = state?.last_exchange;
  if (state?.status !== 'READY' || exchange?.outcome !== 'COMPLETED') return null;
  if (!exchange.result_path || exchange.semantic_key !== semanticKey) return null;
  if (!state.conversation_scope?.id || exchange.conversation_scope_id !== state.conversation_scope.id) return null;
  if (exchange.workspace_fingerprint !== state.workspace?.fingerprint_id) return null;
  if ((exchange.semantic_checkpoint_sha256 ?? null) !== (state.checkpoint?.sha256 ?? null)) return null;
  return { round: exchange.round, result_path: exchange.result_path, result_sha256: exchange.result_sha256 };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('usage: request-optimizer.mjs <request.json>');
  const request = JSON.parse(await readFile(inputPath, 'utf8'));
  console.log(JSON.stringify(optimizeRequest(request), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
