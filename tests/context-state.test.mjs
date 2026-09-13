import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  abortRound,
  beginRound,
  blockForUserAction,
  completeRound,
  initializeState,
  loadState,
  markRoundSent,
  migrateChat,
  migrateState,
  pauseBridge,
  prepareRound,
  recordAdoption,
  recordAppSnapshot,
  recordExecutionReceipt,
  recordProtocolBootstrap,
  recordRoundResult,
  recordTransportObservation,
  recoverState,
  requestIdempotencyKey,
  resumeAppPolling,
  resumeBridge,
  statePaths,
  steerRound,
  switchTransport,
  supersedeRound,
  unbindChat,
} from '../skills/codex-bridge-chatgpt/scripts/context-state.mjs';

function exchange(started) {
  const request = {
    schema_version: 2, bridge_id: started.bridge_id, conversation_scope_id: started.conversation_scope_id, round: started.round, idempotency_key: 'pending', profile: started.profile,
    objective: 'Continue the bridge task', routing: { route: 'hybrid', reason_codes: ['test'], verification_tier: 'targeted' },
    workspace: started.workspace, context_delta: '', local_evidence: [], constraints: [], expected_outputs: [], checkpoint: null,
  };
  request.idempotency_key = requestIdempotencyKey(request);
  const identity = { schema_version: 2, bridge_id: started.bridge_id, conversation_scope_id: started.conversation_scope_id, round: started.round, idempotency_key: request.idempotency_key };
  return {
    request,
    result: { ...identity, profile: started.profile, summary: 'Completed the requested round.', decisions: [], artifacts: [], instructions_for_codex: [], questions: [], context_update: { proposed_entries: [] } },
    adoption: { ...identity, status: 'accepted', accepted_artifact_ids: [], rejected_artifact_ids: [], notes: [], verification_tier: 'targeted' },
    receipt: { ...identity, accepted: [], rejected: [], deferred: [], artifacts: [], checks: ['contract validated'], implementation_summary: 'Verified the response.', new_facts: [], open_questions: [] },
  };
}

async function writeExchange(started) {
  const values = exchange(started);
  const paths = {};
  for (const name of ['request', 'result', 'adoption', 'receipt']) {
    paths[`${name}Path`] = join(started.exchange_directory, `${name}.json`);
    await writeFile(paths[`${name}Path`], `${JSON.stringify(values[name])}\n`, 'utf8');
  }
  return { ...values, ...paths };
}

async function runToReporting(directory, started) {
  const files = await writeExchange(started);
  await prepareRound({ directory, round: started.round, requestPath: files.requestPath });
  await markRoundSent({ directory, round: started.round });
  await recordRoundResult({ directory, round: started.round, resultPath: files.resultPath });
  await recordAdoption({ directory, round: started.round, adoptionPath: files.adoptionPath });
  await recordExecutionReceipt({ directory, round: started.round, receiptPath: files.receiptPath });
  return files;
}

test('state runs the full v2 lifecycle and keeps one Chat across rounds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-workspace-'));
  const directory = join(root, '.bridge');
  try {
    const initialized = await initializeState({ directory, chatRef: 'chat_ordinary_123', chatTitle: 'Codex Coprocessor', transport: 'app-thread', goal: 'Ship bridge', workspaceRoot: root });
    assert.equal(initialized.chat.capabilities.send, false);
    const observed = await recordTransportObservation({ directory, capability: 'read', available: true, evidence: 'read-back returned the selected Chat' });
    assert.equal(observed.chat.capabilities.read, true);
    const started = await beginRound({ directory, profile: 'plan', workspaceRoot: root });
    assert.equal(started.bridge_id, initialized.bridge_id);
    await runToReporting(directory, started);
    const completed = await completeRound({ directory, round: 1 });
    assert.equal(completed.status, 'READY');
    assert.equal(completed.chat.ref, 'chat_ordinary_123');
    assert.equal(completed.last_completed_round, 1);
    assert.equal(completed.last_exchange.outcome, 'COMPLETED');
    assert.ok(completed.last_exchange.adoption_sha256);
    assert.ok(completed.last_exchange.receipt_sha256);
    const second = await beginRound({ directory, profile: 'artifact', workspaceRoot: root });
    assert.equal(second.round, 2);
    assert.equal((await loadState(directory)).chat.ref, 'chat_ordinary_123');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('prepare atomically replaces a pending idempotency key and records the same request bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-workspace-'));
  const directory = join(root, '.bridge');
  try {
    await initializeState({ directory, chatRef: 'chat_a', transport: 'app-thread', workspaceRoot: root });
    const started = await beginRound({ directory, profile: 'review', workspaceRoot: root });
    const requestPath = join(started.exchange_directory, 'request.json');
    const request = exchange(started).request;
    request.idempotency_key = 'pending';
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');

    const prepared = await prepareRound({ directory, round: started.round, requestPath });
    const stored = JSON.parse(await readFile(requestPath, 'utf8'));
    assert.notEqual(stored.idempotency_key, 'pending');
    assert.equal(stored.idempotency_key, requestIdempotencyKey(stored));
    assert.equal(prepared.in_flight.idempotency_key, stored.idempotency_key);
    assert.equal(prepared.in_flight.phase, 'AWAITING_SEND');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('state records app delivery polling and token cost without duplicate sends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-workspace-'));
  const directory = join(root, '.bridge');
  try {
    await initializeState({ directory, chatRef: 'chat_a', transport: 'app-thread', workspaceRoot: root });
    await recordProtocolBootstrap({ directory, protocol: 'compact-v1', evidence: 'ACK-BRIDGE-PROTOCOL compact-v1' });
    const started = await beginRound({ directory, profile: 'review', workspaceRoot: root });
    const requestPath = join(started.exchange_directory, 'request.json');
    const request = {
      schema_version: 2,
      protocol: 'compact-v1',
      bridge_id: started.bridge_id,
      round: started.round,
      idempotency_key: 'pending',
      profile: 'review',
      objective: 'Review the bridge',
      context_delta: { user_intent: ['Review'], history_token_estimate: 1000 },
    };
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, 'utf8');
    const prepared = await prepareRound({ directory, round: started.round, requestPath });
    const baselinePath = join(started.exchange_directory, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify({ turns: [{ id: 'old-turn' }] }), 'utf8');
    const sent = await markRoundSent({ directory, round: started.round, baselinePath });
    assert.equal(sent.in_flight.delivery.status, 'QUEUED');
    assert.ok(sent.cost.totals.request_tokens > 0);
    assert.equal(sent.cost.totals.avoided_history_tokens, 1000);

    const pendingPath = join(started.exchange_directory, 'pending-snapshot.json');
    await writeFile(pendingPath, JSON.stringify({ turns: [{ id: 'old-turn', status: 'completed', items: [] }] }), 'utf8');
    const pending = await recordAppSnapshot({ directory, round: started.round, snapshotPath: pendingPath, observedAt: new Date(Date.now() + 15_000).toISOString() });
    assert.equal(pending.action, 'poll_read');
    assert.equal(pending.should_resend, false);

    const timeoutPath = join(started.exchange_directory, 'timeout-snapshot.json');
    await writeFile(timeoutPath, JSON.stringify({ turns: [] }), 'utf8');
    const timedOut = await recordAppSnapshot({ directory, round: started.round, snapshotPath: timeoutPath, observedAt: new Date(Date.now() + 240_000).toISOString() });
    assert.equal(timedOut.delivery.status, 'RECOVERY_REQUIRED');
    assert.equal((await loadState(directory)).status, 'RECOVERY_REQUIRED');
    const resumed = await resumeAppPolling({ directory, round: started.round });
    assert.equal(resumed.action, 'poll_read');
    assert.equal(resumed.should_resend, false);
    assert.equal((await loadState(directory)).status, 'AWAITING_RESULT');
    await abortRound({ directory, reason: 'finish app delivery state test' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compact requests require a one-time acknowledged Chat protocol', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-workspace-'));
  const directory = join(root, '.bridge');
  try {
    await initializeState({ directory, chatRef: 'chat_a', transport: 'app-thread', workspaceRoot: root });
    const started = await beginRound({ directory, profile: 'review', workspaceRoot: root });
    const requestPath = join(started.exchange_directory, 'request.json');
    const request = {
      schema_version: 2,
      protocol: 'compact-v1',
      bridge_id: started.bridge_id,
      round: started.round,
      idempotency_key: 'pending',
      profile: 'review',
      objective: 'Review the bridge',
      context_delta: { user_intent: ['Review'] },
    };
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, 'utf8');
    await assert.rejects(prepareRound({ directory, round: started.round, requestPath }), /protocol bootstrap is not acknowledged/);
    await abortRound({ directory, reason: 'acknowledge protocol before retrying' });
    await recordProtocolBootstrap({ directory, protocol: 'compact-v1', evidence: 'ACK-BRIDGE-PROTOCOL compact-v1' });
    assert.equal((await loadState(directory)).chat.protocol.status, 'ready');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('state refuses overwrite, parallel rounds, and migration without checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-workspace-'));
  const directory = join(root, '.bridge');
  try {
    await initializeState({ directory, chatRef: 'chat_a', transport: 'app-thread', workspaceRoot: root });
    await assert.rejects(initializeState({ directory, chatRef: 'chat_b', transport: 'app-thread', workspaceRoot: root }), /already exists/);
    await beginRound({ directory, profile: 'diagnosis', workspaceRoot: root });
    await assert.rejects(beginRound({ directory, profile: 'review', workspaceRoot: root }), /already in flight/);
    await abortRound({ directory, reason: 'transport uncertain' });
    await assert.rejects(migrateChat({ directory, chatRef: 'chat_b', transport: 'app-thread', reason: 'old chat unavailable' }), /without a durable checkpoint/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('migration requires a v2 checkpoint and preserves Chat history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-workspace-'));
  const directory = join(root, '.bridge');
  try {
    await initializeState({ directory, chatRef: 'chat_a', chatTitle: 'First', transport: 'app-thread', workspaceRoot: root });
    const started = await beginRound({ directory, profile: 'checkpoint', workspaceRoot: root });
    await runToReporting(directory, started);
    const checkpointPath = statePaths(directory).checkpoint;
    const localWorkspace = (await loadState(directory)).workspace;
    await writeFile(checkpointPath, `${JSON.stringify({ schema_version: 2, bridge_id: started.bridge_id, through_round: 1, objective: 'Preserve durable context', workspace: localWorkspace, entries: [] })}\n`, 'utf8');
    await completeRound({ directory, round: 1, checkpointPath });
    const migrated = await migrateChat({ directory, chatRef: 'chat_b', chatTitle: 'Second', transport: 'in-app-browser', reason: 'context migration test' });
    assert.equal(migrated.chat.ref, 'chat_b');
    assert.equal(migrated.chat.history[0].ref, 'chat_a');
    assert.equal(migrated.chat.capabilities.wait, false);
    assert.match(await readFile(statePaths(directory).journal, 'utf8'), /chat_migrated/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pause, resume, supersede, and unbind preserve monotonic round numbers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-workspace-'));
  const directory = join(root, '.bridge');
  try {
    await initializeState({ directory, chatRef: 'chat_a', transport: 'app-thread', workspaceRoot: root });
    await pauseBridge({ directory });
    await assert.rejects(beginRound({ directory, profile: 'plan', workspaceRoot: root }), /paused/);
    await resumeBridge({ directory, workspaceRoot: root });
    const switched = await switchTransport({ directory, transport: 'in-app-browser', reason: 'direct app send unavailable' });
    assert.equal(switched.chat.transport, 'in-app-browser');
    assert.equal(switched.chat.transport_history[0].transport, 'app-thread');
    await blockForUserAction({ directory, reason: 'browser login required', action: 'sign in visibly' });
    assert.equal((await loadState(directory)).status, 'BLOCKED_BY_USER_ACTION');
    await resumeBridge({ directory, workspaceRoot: root });
    await beginRound({ directory, profile: 'plan', workspaceRoot: root });
    const queued = await steerRound({ directory, instruction: 'Also cover migration', compatibility: 'compatible' });
    assert.equal(queued.in_flight.queued_deltas[0].instruction, 'Also cover migration');
    const superseded = await steerRound({ directory, instruction: 'Replace the objective', compatibility: 'incompatible' });
    assert.equal(superseded.last_exchange.outcome, 'SUPERSEDED');
    assert.equal((await beginRound({ directory, profile: 'plan', workspaceRoot: root })).round, 2);
    await abortRound({ directory, reason: 'finish lifecycle test' });
    await unbindChat({ directory });
    assert.equal((await loadState(directory)).chat.identity_status, 'unbound');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('explicitly migrates v1 state and recovers a corrupt state file from journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-workspace-'));
  const directory = join(root, '.bridge');
  const paths = statePaths(directory);
  try {
    await writeFile(paths.state, `${JSON.stringify({ schema_version: 1, bridge_id: 'legacy-id', chat: { ref: 'chat_a', title: 'Legacy', transport: 'app-thread', history: [] }, current_round: 1, last_completed_round: 1, in_flight: null, checkpoint: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })}\n`, { encoding: 'utf8', flag: 'wx' }).catch(async (error) => {
      if (error.code === 'ENOENT') {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(directory, { recursive: true });
        await writeFile(paths.state, `${JSON.stringify({ schema_version: 1, bridge_id: 'legacy-id', chat: { ref: 'chat_a', transport: 'app-thread' }, current_round: 0, last_completed_round: 0, in_flight: null })}\n`, 'utf8');
      } else throw error;
    });
    const migrated = await migrateState({ directory, workspaceRoot: root });
    assert.equal(migrated.schema_version, 3);
    assert.equal(migrated.migration.history.at(-1).from_schema, 1);
    await writeFile(paths.state, '{corrupt', 'utf8');
    const recovered = await recoverState({ directory });
    assert.equal(recovered.bridge_id, 'legacy-id');
    assert.equal((await loadState(directory)).status, 'READY');
  } finally { await rm(root, { recursive: true, force: true }); }
});
