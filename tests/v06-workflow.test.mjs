import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { startRoundFromSpec } from '../skills/codex-bridge-chatgpt/scripts/bridge.mjs';
import { abortRound, beginRound, completeRound, initializeState, loadState, markRoundSent, prepareRound, recordAdoption, recordExecutionReceipt, recordProtocolBootstrap, recordRoundResult } from '../skills/codex-bridge-chatgpt/scripts/context-state.mjs';
import { compactContextDelta, optimizeRequest, requestSemanticKey, reusableExchange } from '../skills/codex-bridge-chatgpt/scripts/request-optimizer.mjs';

const sha = 'a'.repeat(64);

test('delta compaction trims, deduplicates, guards limits, and shortens receipt anchors', () => {
  const compact = compactContextDelta({
    user_intent: ['  Review   this  ', 'review this', '', 7],
    evidence: Array.from({ length: 12 }, (_, index) => `evidence ${index}`),
    constraints: [],
    previous_receipt: { round: 4, sha256: sha, accepted: ['large repeated summary'] },
    checkpoint: null,
    history_token_estimate: 1200.8,
  });
  assert.deepEqual(compact.user_intent, ['Review   this']);
  assert.equal(compact.evidence.length, 12);
  assert.deepEqual(compact.previous_receipt, { round: 4, sha256: sha });
  assert.equal(compact.history_token_estimate, 1200);
  assert.equal(Object.hasOwn(compact, 'constraints'), false);
  assert.throws(() => compactContextDelta({ evidence: Array.from({ length: 13 }, (_, index) => `evidence ${index}`) }), /evidence.*12-item limit/);
});

test('request optimization reports saved tokens and a hard budget decision', () => {
  const request = {
    schema_version: 2, protocol: 'compact-v1', bridge_id: 'b', round: 1, idempotency_key: 'pending', profile: 'review', objective: 'Review',
    context_delta: { user_intent: ['same', 'same', '  same  '], constraints: [], questions: [], history_token_estimate: 50 },
  };
  const optimized = optimizeRequest(request, { maxInputTokens: 10 });
  assert.ok(optimized.saved_tokens > 0);
  assert.equal(optimized.request.context_delta.user_intent.length, 1);
  assert.equal(optimized.metrics.budget_status, 'over_budget');
  assert.ok(optimized.suggestions.includes('split_or_reduce_before_send'));
});

test('verified result reuse requires semantic, workspace, and checkpoint identity', () => {
  const request = { protocol: 'compact-v1', profile: 'review', objective: 'Same', context_delta: { user_intent: ['same'] } };
  const key = requestSemanticKey(request, { workspaceFingerprint: 'workspace', checkpointSha256: 'checkpoint' });
  const state = {
    status: 'READY', conversation_scope: { id: sha }, workspace: { fingerprint_id: 'workspace' }, checkpoint: { sha256: 'checkpoint' },
    last_exchange: { outcome: 'COMPLETED', round: 3, conversation_scope_id: sha, result_path: 'result.json', result_sha256: sha, semantic_key: key, workspace_fingerprint: 'workspace', semantic_checkpoint_sha256: 'checkpoint' },
  };
  assert.equal(reusableExchange(state, key).round, 3);
  assert.equal(reusableExchange({ ...state, workspace: { fingerprint_id: 'changed' } }, key), null);
  assert.equal(reusableExchange({ ...state, checkpoint: { sha256: 'changed' } }, key), null);
  assert.equal(reusableExchange(state, 'different'), null);
});

test('start command compacts, creates, validates, and prepares a round in one step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-start-'));
  const directory = join(root, '.bridge');
  const specPath = join(root, 'spec.json');
  try {
    await writeFile(specPath, JSON.stringify({ profile: 'review', objective: 'Review once', context_delta: { user_intent: ['Review', 'Review'], constraints: [], history_token_estimate: 100 } }), 'utf8');
    await initializeState({ directory, chatRef: 'chat_a', transport: 'app-thread', workspaceRoot: root });
    await recordProtocolBootstrap({ directory, protocol: 'compact-v1', evidence: 'ACK-BRIDGE-PROTOCOL compact-v1' });
    const started = await startRoundFromSpec({ directory, specPath, workspaceRoot: root });
    assert.equal(started.action, 'send_prepared_request');
    assert.equal(started.next_action, 'capture_baseline_then_send_once');
    const request = JSON.parse(await readFile(started.request_path, 'utf8'));
    assert.deepEqual(request.context_delta.user_intent, ['Review']);
    assert.equal((await loadState(directory)).status, 'AWAITING_SEND');
    await abortRound({ directory, reason: 'test complete' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('start reuses an identical completed result without allocating or sending a round', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-reuse-'));
  const directory = join(root, '.bridge');
  const specPath = join(root, 'spec.json');
  try {
    await writeFile(specPath, JSON.stringify({ profile: 'review', objective: 'Stable review', context_delta: { user_intent: ['Review stable input'] } }), 'utf8');
    await initializeState({ directory, chatRef: 'chat_a', transport: 'app-thread', workspaceRoot: root });
    await recordProtocolBootstrap({ directory, protocol: 'compact-v1', evidence: 'ACK-BRIDGE-PROTOCOL compact-v1' });
    const started = await startRoundFromSpec({ directory, specPath, workspaceRoot: root });
    const request = JSON.parse(await readFile(started.request_path, 'utf8'));
    const exchangeRoot = join(directory, 'exchanges', '0001');
    const identity = { schema_version: 2, protocol: 'compact-v1', bridge_id: request.bridge_id, conversation_scope_id: request.conversation_scope_id, round: 1, idempotency_key: started.idempotency_key, profile: 'review' };
    const resultPath = join(exchangeRoot, 'result.json');
    const adoptionPath = join(exchangeRoot, 'adoption.json');
    const receiptPath = join(exchangeRoot, 'receipt.json');
    await writeFile(resultPath, JSON.stringify({ ...identity, summary: 'Stable', decisions: [], findings: [], questions: [], context_update: { proposed_entries: [] } }), 'utf8');
    await writeFile(adoptionPath, JSON.stringify({ schema_version: 2, bridge_id: request.bridge_id, round: 1, idempotency_key: started.idempotency_key, status: 'accepted', accepted_artifact_ids: [], rejected_artifact_ids: [], notes: [], verification_tier: 'contract_only' }), 'utf8');
    await writeFile(receiptPath, JSON.stringify({ schema_version: 2, bridge_id: request.bridge_id, round: 1, idempotency_key: started.idempotency_key, accepted: [], rejected: [], deferred: [], artifacts: [], checks: [], implementation_summary: 'Verified stable review', new_facts: [], open_questions: [] }), 'utf8');
    await markRoundSent({ directory, round: 1 });
    await recordRoundResult({ directory, round: 1, resultPath });
    await recordAdoption({ directory, round: 1, adoptionPath });
    await recordExecutionReceipt({ directory, round: 1, receiptPath });
    await completeRound({ directory, round: 1 });
    const reused = await startRoundFromSpec({ directory, specPath, workspaceRoot: root });
    assert.equal(reused.action, 'reuse_verified_result');
    assert.equal(reused.should_send, false);
    assert.equal((await loadState(directory)).current_round, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('low-level prepare blocks requests above the hard send budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-budget-'));
  const directory = join(root, '.bridge');
  try {
    await initializeState({ directory, chatRef: 'chat_a', transport: 'app-thread', workspaceRoot: root });
    await recordProtocolBootstrap({ directory, protocol: 'compact-v1', evidence: 'ACK-BRIDGE-PROTOCOL compact-v1' });
    const started = await beginRound({ directory, profile: 'review', workspaceRoot: root });
    const requestPath = join(started.exchange_directory, 'request.json');
    await writeFile(requestPath, JSON.stringify({
      schema_version: 2, protocol: 'compact-v1', bridge_id: started.bridge_id, round: started.round, idempotency_key: 'pending', profile: 'review', objective: 'Large',
      context_delta: { evidence: ['x'.repeat(13000)] },
    }), 'utf8');
    await assert.rejects(prepareRound({ directory, round: started.round, requestPath }), /3000 approximate-token send budget/);
    await abortRound({ directory, reason: 'test complete' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('start applies the fixed ceiling before allocating a round', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-prebudget-'));
  const directory = join(root, '.bridge');
  const specPath = join(root, 'spec.json');
  try {
    await writeFile(specPath, JSON.stringify({ profile: 'review', objective: 'Large', max_input_tokens: 9000, context_delta: { evidence: ['x'.repeat(13000)] } }), 'utf8');
    await initializeState({ directory, chatRef: 'chat_a', transport: 'app-thread', workspaceRoot: root });
    await recordProtocolBootstrap({ directory, protocol: 'compact-v1', evidence: 'ACK-BRIDGE-PROTOCOL compact-v1' });
    await assert.rejects(startRoundFromSpec({ directory, specPath, workspaceRoot: root }), /exceeds its approximate-token budget/);
    const state = await loadState(directory);
    assert.equal(state.current_round, 0);
    assert.equal(state.status, 'READY');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('start rejects invalid or sensitive specs before allocating a round', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-prevalidate-'));
  const directory = join(root, '.bridge');
  const specPath = join(root, 'spec.json');
  try {
    await writeFile(specPath, JSON.stringify({ profile: 'review', objective: 'Review', context_delta: { evidence: ['api_key=sk-abcdefghijklmnopqrstuvwxyz123456'] } }), 'utf8');
    await initializeState({ directory, chatRef: 'chat_a', transport: 'app-thread', workspaceRoot: root });
    await recordProtocolBootstrap({ directory, protocol: 'compact-v1', evidence: 'ACK-BRIDGE-PROTOCOL compact-v1' });
    await assert.rejects(startRoundFromSpec({ directory, specPath, workspaceRoot: root }), /likely secret/);
    const state = await loadState(directory);
    assert.equal(state.current_round, 0);
    assert.equal(state.status, 'READY');
  } finally { await rm(root, { recursive: true, force: true }); }
});
