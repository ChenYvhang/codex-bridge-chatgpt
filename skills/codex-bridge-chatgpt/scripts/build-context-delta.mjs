#!/usr/bin/env node

import { isDirectExecution } from './cli-entry.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export function stableSha256(value) { return sha256(JSON.stringify(canonical(value))); }
function array(value) { return Array.isArray(value) ? value : []; }

export function buildContextDelta({ userIntent = [], newlyVerifiedFacts = [], invalidatedFacts = [], evidence = [], constraints = [], previousReceipt = null, previousReceiptSha256 = null, checkpoint = null, checkpointSha256 = null, expectedOutputs = [], questions = [], historyTokenEstimate = 0 }) {
  const receiptAnchor = previousReceipt ? {
    round: previousReceipt.round,
    idempotency_key: previousReceipt.idempotency_key,
    sha256: previousReceiptSha256 ?? stableSha256(previousReceipt),
    accepted: array(previousReceipt.accepted),
    rejected: array(previousReceipt.rejected),
    deferred: array(previousReceipt.deferred),
  } : null;
  const checkpointAnchor = checkpoint ? {
    through_round: checkpoint.through_round,
    sha256: checkpointSha256 ?? stableSha256(checkpoint),
  } : null;
  return {
    user_intent: array(userIntent),
    newly_verified_facts: array(newlyVerifiedFacts),
    invalidated_facts: array(invalidatedFacts),
    evidence: array(evidence),
    constraints: array(constraints),
    previous_receipt: receiptAnchor,
    checkpoint: checkpointAnchor,
    expected_outputs: array(expectedOutputs),
    questions: array(questions),
    history_token_estimate: Math.max(0, Number(historyTokenEstimate) || 0),
  };
}

export function serializeContextDelta(delta) { return JSON.stringify(delta); }

export function buildCompactRequest({ bridgeId, conversationScopeId = null, round, profile, objective, contextDelta, routing = null, workspace = null }) {
  const request = {
    schema_version: 2,
    protocol: 'compact-v1',
    bridge_id: bridgeId,
    round,
    idempotency_key: 'pending',
    profile,
    objective,
    context_delta: contextDelta,
  };
  if (conversationScopeId) request.conversation_scope_id = conversationScopeId;
  if (routing) request.routing = routing;
  if (workspace) request.workspace = workspace;
  return request;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('usage: build-context-delta.mjs <input.json>');
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  console.log(JSON.stringify(buildContextDelta(input), null, 2));
}

if (isDirectExecution(import.meta.url)) main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
