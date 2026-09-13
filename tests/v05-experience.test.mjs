import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDelivery, inspectSnapshot, prepareRepair, resumeDelivery } from '../skills/codex-bridge-chatgpt/scripts/app-transport.mjs';
import { buildCompactRequest, buildContextDelta } from '../skills/codex-bridge-chatgpt/scripts/build-context-delta.mjs';
import { calculateCostReport, statusView } from '../skills/codex-bridge-chatgpt/scripts/bridge.mjs';
import { analyzePayload, duplicateEstimate, estimateTokens } from '../skills/codex-bridge-chatgpt/scripts/token-budget.mjs';
import { validateContextRequest, validateContextResult, validatePair } from '../skills/codex-bridge-chatgpt/scripts/validate-context.mjs';

const identity = {
  schema_version: 2,
  protocol: 'compact-v1',
  bridge_id: 'bridge-compact',
  round: 5,
  idempotency_key: 'idem-compact',
};

function delta() {
  return buildContextDelta({
    userIntent: ['Review the parser'],
    newlyVerifiedFacts: ['Targeted tests pass'],
    constraints: ['Keep Node 18 compatibility'],
    expectedOutputs: ['One concise review'],
    historyTokenEstimate: 2400,
  });
}

test('compact requests use an object delta and profile-specific review results', () => {
  const request = buildCompactRequest({
    bridgeId: identity.bridge_id,
    round: identity.round,
    profile: 'review',
    objective: 'Review the parser',
    contextDelta: delta(),
  });
  request.idempotency_key = identity.idempotency_key;
  const result = {
    ...identity,
    profile: 'review',
    summary: 'No blocking issue found.',
    decisions: [{ decision: 'Accept the parser', basis: 'Targeted evidence passed', confidence: 'high' }],
    findings: [],
    questions: [],
    context_update: { proposed_entries: [] },
  };
  assert.equal(typeof request.context_delta, 'object');
  assert.deepEqual(validateContextRequest(request), []);
  assert.deepEqual(validateContextResult(result), []);
  assert.deepEqual(validatePair(request, result), []);
  assert.equal(Object.hasOwn(result, 'artifacts'), false);
  assert.equal(Object.hasOwn(result, 'instructions_for_codex'), false);
});

test('compact artifact results omit planning-only fields', () => {
  const result = {
    ...identity,
    profile: 'artifact',
    summary: 'Drafted one file.',
    artifacts: [{ artifact_id: 'a', path: 'docs/a.md', media_type: 'text/markdown', encoding: 'utf8', operation: 'create', delivery: 'inline', content: 'A', base_sha256: null, declared_sha256: null, size: 1 }],
    instructions_for_codex: [],
    questions: [],
    context_update: { proposed_entries: [] },
  };
  assert.deepEqual(validateContextResult(result), []);
  assert.equal(Object.hasOwn(result, 'decisions'), false);
});

test('all compact response profiles accept their minimum useful shape', () => {
  const common = { ...identity, summary: 'Done', questions: [], context_update: { proposed_entries: [] } };
  const results = [
    { ...common, profile: 'plan', decisions: [] },
    { ...common, profile: 'review', decisions: [], findings: [] },
    { ...common, profile: 'diagnosis', decisions: [], hypotheses: [] },
    { ...common, profile: 'artifact', artifacts: [], instructions_for_codex: [] },
    { ...common, profile: 'checkpoint' },
  ];
  for (const result of results) assert.deepEqual(validateContextResult(result), [], result.profile);
});

test('token budget reports protocol share, duplication, and avoided history', () => {
  const compact = buildCompactRequest({ bridgeId: 'b', round: 2, profile: 'review', objective: 'Review', contextDelta: delta() });
  const full = {
    ...compact,
    protocol: undefined,
    context_delta: JSON.stringify(delta()),
    routing: { route: 'chat', reason_codes: ['test'], verification_tier: 'contract_only' },
    workspace: { fingerprint_id: 'workspace' },
    local_evidence: [], constraints: [], expected_outputs: [], checkpoint: null,
  };
  const metrics = analyzePayload({ request: compact, previousRequest: compact, historyTokenEstimate: 2400 });
  assert.ok(estimateTokens(compact) < estimateTokens(full));
  assert.ok(metrics.protocol_share >= 0 && metrics.protocol_share <= 1);
  assert.equal(metrics.avoided_history_tokens, 2400);
  assert.ok(duplicateEstimate(compact, compact).duplicate_rate > 0.99);
});

test('app adapter matches idempotency keys, polls without resend, and resumes safely', () => {
  const delivery = createDelivery({ idempotencyKey: 'idem-5', baselineTurnIds: ['old-matching-turn'], queuedAt: '2026-01-01T00:00:00.000Z', timeoutMs: 60000 });
  const stale = inspectSnapshot(delivery, { turns: [{ id: 'old-matching-turn', status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'idem-5' }] }, { type: 'agentMessage', text: 'stale' }] }] }, '2026-01-01T00:00:10.000Z');
  assert.equal(stale.action, 'poll_read');
  const pending = inspectSnapshot(delivery, { turns: [] }, '2026-01-01T00:00:15.000Z');
  assert.equal(pending.action, 'poll_read');
  assert.equal(pending.should_resend, false);
  const completed = inspectSnapshot(pending.delivery, { turns: [{ id: 'turn-5', status: 'completed', error: null, items: [{ type: 'userMessage', content: [{ type: 'text', text: 'round idem-5' }] }, { type: 'agentMessage', id: 'answer-5', text: '{"ok":true}' }] }] }, '2026-01-01T00:00:30.000Z');
  assert.equal(completed.delivery.status, 'RETRIEVED');
  assert.equal(completed.result_text, '{"ok":true}');
  const repair = prepareRepair(completed.delivery, '2026-01-01T00:00:31.000Z');
  assert.equal(repair.status, 'QUEUED');
  assert.equal(repair.repair_count, 1);
  assert.ok(repair.baseline_turn_ids.includes('turn-5'));
  assert.throws(() => prepareRepair({ ...repair, status: 'RETRIEVED' }), /only one/);
  const timedOut = inspectSnapshot(delivery, { turns: [] }, '2026-01-01T00:02:00.000Z');
  assert.equal(timedOut.delivery.status, 'RECOVERY_REQUIRED');
  assert.equal(resumeDelivery(timedOut.delivery).should_resend, false);
});

test('status view exposes the next user action without revealing the Chat id', () => {
  const view = statusView({ status: 'AWAITING_RESULT', chat: { ref: 'private-id', title: 'Bridge', transport: 'app-thread', identity_status: 'verified' }, in_flight: { round: 7, phase: 'AWAITING_RESULT', delivery: { status: 'QUEUED' } }, last_completed_round: 6 });
  assert.equal(view.next_action, 'poll_bound_chat');
  assert.equal(view.should_resend, false);
  assert.equal(JSON.stringify(view).includes('private-id'), false);
});

test('cost report scans exchange files and aggregates completed rounds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-cost-'));
  try {
    const exchange = join(root, 'exchanges', '0001');
    await mkdir(exchange, { recursive: true });
    const request = { ...buildCompactRequest({ bridgeId: 'b', round: 1, profile: 'review', objective: 'Review', contextDelta: delta() }), idempotency_key: 'i1' };
    const result = { schema_version: 2, protocol: 'compact-v1', bridge_id: 'b', round: 1, idempotency_key: 'i1', profile: 'review', summary: 'Done', decisions: [], findings: [], questions: [], context_update: { proposed_entries: [] } };
    await writeFile(join(exchange, 'request.json'), JSON.stringify(request), 'utf8');
    await writeFile(join(exchange, 'result.json'), JSON.stringify(result), 'utf8');
    await writeFile(join(exchange, 'result-invalid-01.json'), JSON.stringify({ error: 'bad shape' }), 'utf8');
    const report = await calculateCostReport(root);
    assert.equal(report.rounds.length, 1);
    assert.ok(report.totals.total_tokens > 0);
    assert.ok(report.totals.wasted_response_tokens > 0);
    assert.equal(report.rounds[0].response_attempts, 2);
    assert.equal(report.totals.avoided_history_tokens, 2400);
  } finally { await rm(root, { recursive: true, force: true }); }
});
