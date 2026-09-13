import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { exportRecoveryBundle, healthReport, prepareQuestionBatch } from '../skills/codex-bridge-chatgpt/scripts/bridge.mjs';
import { batchQuestions } from '../skills/codex-bridge-chatgpt/scripts/question-router.mjs';
import { createRecoveryBundle, validateRecoveryBundle } from '../skills/codex-bridge-chatgpt/scripts/recovery-bundle.mjs';
import { createConversationScope, workspaceScopeFingerprint } from '../skills/codex-bridge-chatgpt/scripts/scope-identity.mjs';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

async function runtime(root, { checkpointRound = 3, lastCompletedRound = 3, checkpointValue = 'Keep durable context' } = {}) {
  const directory = join(root, '.bridge');
  const exchange = join(directory, 'exchanges', '0003');
  await mkdir(exchange, { recursive: true });
  const checkpointPath = join(directory, 'checkpoint.json');
  const receiptPath = join(exchange, 'receipt.json');
  const checkpoint = {
    schema_version: 2,
    bridge_id: 'bridge-v07',
    through_round: checkpointRound,
    objective: 'Finish the persistent bridge',
    workspace: { canonical_root: root, fingerprint_id: 'workspace-v07' },
    entries: [
      { id: 'decision-1', kind: 'decision', value: checkpointValue, status: 'accepted', source_round: 2 },
      { id: 'fact-1', kind: 'local_fact', value: 'Temporary test output exists', status: 'accepted', source_round: 3, freshness: { workspace_fingerprint: 'workspace-v07' } },
      { id: 'old-1', kind: 'decision', value: 'Rejected old option', status: 'rejected', source_round: 1 },
    ],
  };
  const receipt = {
    schema_version: 2,
    bridge_id: 'bridge-v07',
    round: 3,
    idempotency_key: 'idem-v07',
    accepted: ['Health report'], rejected: [], deferred: ['Live migration'],
    artifacts: [{ path: 'docs/report.md', status: 'applied' }],
    checks: [{ name: 'node tests', status: 'passed' }],
    implementation_summary: 'Verified the third improvement batch',
    new_facts: [], open_questions: ['Which label do you prefer?'],
  };
  const checkpointRaw = `${JSON.stringify(checkpoint, null, 2)}\n`;
  const receiptRaw = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeFile(checkpointPath, checkpointRaw, 'utf8');
  await writeFile(receiptPath, receiptRaw, 'utf8');
  const workspace = { canonical_root: root, fingerprint_id: 'workspace-v07', project_label: 'private-project' };
  const conversationScope = createConversationScope({
    bridgeId: 'bridge-v07',
    chatRef: 'private-chat-id',
    workspaceFingerprintId: workspaceScopeFingerprint(workspace),
    scopeKey: 'f'.repeat(64),
    boundAt: '2026-09-14T00:00:00.000Z',
  });
  const state = {
    schema_version: 3,
    state_revision: 1,
    bridge_id: 'bridge-v07',
    goal: { name: 'Finish bridge', authorization_scope: 'Finish bridge' },
    workspace,
    conversation_scope: conversationScope,
    chat: {
      ref: 'private-chat-id', title: 'Bridge Chat', transport: 'app-thread', identity_status: 'verified',
      capabilities: { persistent_chat_id: true, read: true, send: true, read_after_write: true, wait: true, structured_result_retrieval: true, attachment_acquisition: false },
      protocol: { version: 'compact-v1', status: 'ready' }, history: [],
    },
    status: 'READY', automatic_routing: true, current_round: 3, last_completed_round: lastCompletedRound, in_flight: null,
    checkpoint: { path: checkpointPath, sha256: sha256(checkpointRaw), through_round: checkpointRound, updated_at: '2026-09-14T00:00:00.000Z' },
    last_exchange: { round: 3, conversation_scope_id: conversationScope.id, outcome: 'COMPLETED', receipt_path: receiptPath, receipt_sha256: sha256(receiptRaw), completed_at: '2026-09-14T00:30:00.000Z' },
    pending_artifacts: [], pending_questions: receipt.open_questions,
    cost: { estimator: 'local-heuristic-v1', rounds: [], totals: {} },
    created_at: '2026-09-14T00:00:00.000Z', updated_at: '2026-09-14T01:00:00.000Z',
  };
  await writeFile(join(directory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return { directory, checkpoint, receipt, state, receiptPath };
}

test('question batching removes duplicates and keeps local evidence away from the user', () => {
  const batch = batchQuestions([
    { id: 'a', text: 'Which name?', type: 'preference' },
    { id: 'b', text: '  which   name? ', type: 'preference' },
    { id: 'c', text: 'What Node version is installed?', type: 'local_fact', evidence_key: 'node' },
    { id: 'd', text: 'Does the file exist?', type: 'local_fact', evidence_key: 'file' },
  ], { node: '22.18.0' });
  assert.equal(batch.counts.duplicates_removed, 1);
  assert.equal(batch.user_questions.length, 1);
  assert.equal(batch.codex_answers[0].answer, '22.18.0');
  assert.equal(batch.codex_checks.length, 1);
  assert.equal(batch.user_prompt.includes('Node version'), false);
});

test('stored pending questions are available as one user prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-v07-questions-'));
  try {
    const { directory } = await runtime(root);
    const batch = await prepareQuestionBatch(directory);
    assert.equal(batch.requires_user, true);
    assert.match(batch.user_prompt, /Which label/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('health report exposes continuity, cost, and actionable warnings without the Chat id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-v07-health-'));
  try {
    const { directory } = await runtime(root);
    const report = await healthReport(directory, '2026-09-14T01:00:00.000Z');
    assert.equal(report.context.checkpoint_age_seconds, 3600);
    assert.equal(report.latest_receipt.checks[0].status, 'passed');
    assert.ok(report.warnings.some((warning) => warning.code === 'QUESTIONS_PENDING'));
    assert.equal(JSON.stringify(report).includes('private-chat-id'), false);
    assert.equal(JSON.stringify(report).includes(root), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('health report detects receipt tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-v07-integrity-'));
  try {
    const { directory, receiptPath } = await runtime(root);
    await writeFile(receiptPath, '{}\n', 'utf8');
    const report = await healthReport(directory);
    assert.ok(report.warnings.some((warning) => warning.code === 'RECEIPT_INTEGRITY_FAILED'));
    assert.equal(report.healthy, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recovery export is bounded, integrity-bound, and strips local or account identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-v07-recovery-'));
  try {
    const { directory } = await runtime(root);
    const output = join(root, 'recovery.json');
    const result = await exportRecoveryBundle({ directory, outputPath: output, maxTokens: 900 });
    const bundle = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.should_send, false);
    assert.ok(result.approximate_tokens <= 900);
    assert.deepEqual(validateRecoveryBundle(bundle), []);
    assert.equal(bundle.durable_context.length, 1);
    const serialized = JSON.stringify(bundle);
    assert.equal(serialized.includes('private-chat-id'), false);
    assert.equal(serialized.includes('private-project'), false);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes('Temporary test output exists'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recovery export fails closed for stale checkpoints and likely secrets', async () => {
  const staleRoot = await mkdtemp(join(tmpdir(), 'codex-bridge-v07-stale-'));
  const secretRoot = await mkdtemp(join(tmpdir(), 'codex-bridge-v07-secret-'));
  try {
    const stale = await runtime(staleRoot, { checkpointRound: 2, lastCompletedRound: 3 });
    await assert.rejects(exportRecoveryBundle({ directory: stale.directory, outputPath: join(staleRoot, 'out.json') }), /checkpoint is behind/);

    const secret = await runtime(secretRoot, { checkpointValue: 'password=super-secret-value' });
    await assert.rejects(exportRecoveryBundle({ directory: secret.directory, outputPath: join(secretRoot, 'out.json') }), /likely secret/);
  } finally {
    await rm(staleRoot, { recursive: true, force: true });
    await rm(secretRoot, { recursive: true, force: true });
  }
});

test('recovery bundle integrity detects modification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-v07-tamper-'));
  try {
    const { state, checkpoint, receipt } = await runtime(root);
    const created = createRecoveryBundle({ state, checkpoint, receipt });
    created.bundle.objective = 'Changed after export';
    assert.ok(validateRecoveryBundle(created.bundle).includes('bundle_sha256 is invalid'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
