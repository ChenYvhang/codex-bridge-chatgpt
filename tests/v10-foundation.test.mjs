import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyChatMigration,
  beginRound,
  initializeState,
  invalidateCompletedRound,
  loadState,
  migrateState,
  prepareRound,
  previewChatMigration,
  recordProtocolBootstrap,
  statePaths,
} from '../skills/codex-bridge-chatgpt/scripts/context-state.mjs';
import { statusView } from '../skills/codex-bridge-chatgpt/scripts/bridge.mjs';
import { createMcpDispatcher } from '../skills/codex-bridge-chatgpt/scripts/mcp-server.mjs';
import { normalizeChatReference, publicConversationScope, validateConversationScope, workspaceScopeFingerprint } from '../skills/codex-bridge-chatgpt/scripts/scope-identity.mjs';
import { applySetupPlan, createSetupPlan } from '../skills/codex-bridge-chatgpt/scripts/setup.mjs';
import { createSupportBundle } from '../skills/codex-bridge-chatgpt/scripts/doctor.mjs';

test('conversation scope normalizes Chat URLs and detects identity tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v10-scope-'));
  const directory = join(root, '.bridge');
  try {
    const initialized = await initializeState({
      directory,
      chatRef: 'https://chatgpt.com/c/abc-123?temporary_secret=hidden#fragment',
      transport: 'in-app-browser',
      workspaceRoot: root,
    });
    assert.equal(initialized.chat.ref, 'chatgpt:c:abc-123');
    assert.deepEqual(validateConversationScope(initialized), []);
    assert.equal(publicConversationScope(initialized.conversation_scope).key, undefined);
    assert.equal(JSON.stringify(statusView(initialized)).includes(initialized.conversation_scope.key), false);

    const paths = statePaths(directory);
    const tampered = JSON.parse(await readFile(paths.state, 'utf8'));
    tampered.chat.ref = 'chatgpt:c:other';
    await writeFile(paths.state, `${JSON.stringify(tampered)}\n`, 'utf8');
    await assert.rejects(loadState(directory), /SCOPE_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('conversation scope survives ordinary branch and dirty-state refreshes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v10-stable-scope-'));
  const directory = join(root, '.bridge');
  try {
    const initialized = await initializeState({ directory, chatRef: 'chat-a', transport: 'app-thread', workspaceRoot: root });
    const refreshed = structuredClone(initialized);
    refreshed.workspace.branch = 'feature/continued-work';
    refreshed.workspace.head = '1'.repeat(40);
    refreshed.workspace.dirty_sha256 = '2'.repeat(64);
    refreshed.workspace.fingerprint_id = '3'.repeat(64);
    assert.equal(workspaceScopeFingerprint(refreshed.workspace), initialized.conversation_scope.workspace_fingerprint_id);
    assert.deepEqual(validateConversationScope(refreshed), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalidating an unverified completed round restores only a verified prior checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v10-invalidate-'));
  const directory = join(root, '.bridge');
  try {
    const state = await initializeState({ directory, chatRef: 'chat-a', transport: 'app-thread', workspaceRoot: root });
    const oldCheckpoint = { schema_version: 2, bridge_id: state.bridge_id, through_round: 5, objective: 'Keep verified context', workspace: state.workspace, entries: [] };
    const newCheckpoint = { ...oldCheckpoint, through_round: 7, entries: [{ id: 'unverified', kind: 'decision', value: 'Unverified result', status: 'accepted', source_round: 7 }] };
    const oldPath = join(directory, 'checkpoint.prior.json');
    const newPath = join(directory, 'checkpoint.json');
    const oldRaw = `${JSON.stringify(oldCheckpoint)}\n`;
    const newRaw = `${JSON.stringify(newCheckpoint)}\n`;
    const hash = (value) => createHash('sha256').update(value).digest('hex');
    await writeFile(oldPath, oldRaw, 'utf8');
    await writeFile(newPath, newRaw, 'utf8');
    state.current_round = 7;
    state.last_completed_round = 7;
    state.chat.last_successful_round = 7;
    state.checkpoint = { path: newPath, sha256: hash(newRaw), through_round: 7 };
    state.last_exchange = { round: 7, outcome: 'COMPLETED', profile: 'review', idempotency_key: 'key', result_sha256: hash('result') };
    await writeFile(statePaths(directory).state, `${JSON.stringify(state)}\n`, 'utf8');
    const options = { directory, round: 7, expectedRevision: state.state_revision, priorCheckpointPath: oldPath, priorCheckpointSha256: hash(oldRaw), reason: 'visible copy could not be verified' };
    await assert.rejects(invalidateCompletedRound({ ...options, priorCheckpointSha256: hash('wrong') }), /prior checkpoint integrity changed/);
    const invalidated = await invalidateCompletedRound(options);
    assert.equal(invalidated.status, 'PAUSED');
    assert.equal(invalidated.current_round, 7);
    assert.equal(invalidated.last_completed_round, 5);
    assert.equal(invalidated.last_exchange.outcome, 'ABORTED');
    assert.equal(invalidated.checkpoint.sha256, hash(oldRaw));
    assert.equal(invalidated.invalidated_exchanges.length, 1);
    assert.equal(await readFile(newPath, 'utf8'), newRaw);
    await assert.rejects(invalidateCompletedRound(options), /STATE_CONFLICT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('v2 migration keeps an exact backup and records integrity provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v10-migrate-'));
  const directory = join(root, '.bridge');
  try {
    const current = await initializeState({ directory, chatRef: 'chat-a', transport: 'app-thread', workspaceRoot: root });
    const legacy = structuredClone(current);
    legacy.schema_version = 2;
    delete legacy.conversation_scope;
    delete legacy.migration;
    const raw = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(statePaths(directory).state, raw, 'utf8');

    const migrated = await migrateState({ directory, workspaceRoot: root });
    assert.equal(migrated.schema_version, 3);
    assert.deepEqual(validateConversationScope(migrated), []);
    const migration = migrated.migration.history.at(-1);
    assert.equal(migration.from_schema, 2);
    assert.equal(migration.to_schema, 3);
    assert.equal(await readFile(join(directory, migration.backup), 'utf8'), raw);
    const again = await migrateState({ directory, workspaceRoot: root });
    assert.equal(again.state_revision, migrated.state_revision);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Chat migration requires an unchanged, hash-bound preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v10-chat-migrate-'));
  const directory = join(root, '.bridge');
  try {
    const state = await initializeState({ directory, chatRef: 'chat-a', transport: 'app-thread', workspaceRoot: root });
    state.checkpoint = { sha256: 'a'.repeat(64), through_round: 0, path: join(directory, 'checkpoint.json') };
    await writeFile(statePaths(directory).state, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    const previewed = await previewChatMigration({ directory, chatRef: 'https://chatgpt.com/c/chat-b?ignored=1', chatTitle: 'Replacement', transport: 'in-app-browser', reason: 'lost old Chat' });
    const migrated = await applyChatMigration({ directory, previewPath: previewed.preview_path });
    assert.equal(migrated.chat.ref, 'chatgpt:c:chat-b');
    assert.equal(migrated.chat.history.at(-1).ref, 'chat-a');
    assert.notEqual(migrated.conversation_scope.id, state.conversation_scope.id);

    const second = await previewChatMigration({ directory, chatRef: 'chat-c', transport: 'app-thread', reason: 'test stale preview' });
    await recordProtocolBootstrap({ directory, protocol: 'compact-v1', evidence: 'scope changed after preview' });
    await assert.rejects(applyChatMigration({ directory, previewPath: second.preview_path }), /STATE_CONFLICT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('prepared requests carry scope and an auditable source manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v10-manifest-'));
  const directory = join(root, '.bridge');
  try {
    await initializeState({ directory, chatRef: 'chat-a', transport: 'app-thread', workspaceRoot: root });
    await recordProtocolBootstrap({ directory, protocol: 'compact-v1', evidence: 'ACK-BRIDGE-PROTOCOL compact-v1' });
    const started = await beginRound({ directory, profile: 'review', workspaceRoot: root });
    const requestPath = join(started.exchange_directory, 'request.json');
    await writeFile(requestPath, JSON.stringify({
      schema_version: 2,
      protocol: 'compact-v1',
      bridge_id: started.bridge_id,
      round: started.round,
      idempotency_key: 'pending',
      profile: 'review',
      objective: 'Review the release contract',
      context_delta: { user_intent: ['Review'], evidence: ['Tests pass'] },
    }), 'utf8');
    const prepared = await prepareRound({ directory, round: started.round, requestPath });
    const request = JSON.parse(await readFile(requestPath, 'utf8'));
    const manifest = JSON.parse(await readFile(prepared.in_flight.context_manifest_path, 'utf8'));
    assert.equal(request.conversation_scope_id, started.conversation_scope_id);
    assert.equal(manifest.conversation_scope_id, started.conversation_scope_id);
    assert.equal(manifest.entries.find((entry) => entry.source === 'context_delta.evidence').status, 'included');
    assert.equal(manifest.entries.find((entry) => entry.source === 'context_delta.questions').status, 'skipped');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('MCP status and health support unchanged revision responses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v10-revision-'));
  const directory = join(root, '.bridge');
  try {
    const state = await initializeState({ directory, chatRef: 'chat-a', transport: 'app-thread', workspaceRoot: root });
    const dispatch = createMcpDispatcher({ directory, workspaceRoot: root });
    const status = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bridge_status', arguments: { since_revision: state.state_revision } } });
    assert.deepEqual(status.result.structuredContent, { status: 'READY', state_revision: state.state_revision, unchanged: true });
    const health = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_health', arguments: { since_revision: state.state_revision } } });
    assert.deepEqual(health.result.structuredContent, { status: 'READY', state_revision: state.state_revision, unchanged: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('chat reference normalization removes credentials and unstable URL parts', () => {
  assert.equal(normalizeChatReference('https://user:pass@example.com/path/?token=secret#x'), 'https://example.com/path');
  assert.equal(normalizeChatReference(' thread-id '), 'thread-id');
  assert.equal(normalizeChatReference('https://user:pass@chatgpt.com/c/abc-123?token=secret'), 'chatgpt:c:abc-123');
  assert.throws(() => normalizeChatReference('https://user:pass@chatgpt.com/c/%ZZ?token=secret'), /invalid identifier/);
  assert.throws(() => normalizeChatReference('https://user:pass@chatgpt.com:invalid/c/abc-123'), /URL is invalid/);
  assert.throws(() => normalizeChatReference('https://chatgpt.com/c/abc-123/other'), /secure conversation URL/);
  assert.throws(() => normalizeChatReference('http://chatgpt.com/c/abc-123'), /secure conversation URL/);
});

test('project setup is previewed, hash-bound, repeatable, and removable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v10-setup-'));
  const skillRoot = join(process.cwd(), 'skills', 'codex-bridge-chatgpt');
  try {
    const plan = await createSetupPlan({ workspaceRoot: root, skillRoot });
    assert.equal(plan.changed, true);
    await assert.rejects(readFile(plan.config_path, 'utf8'), /ENOENT/);
    const applied = await applySetupPlan(plan);
    assert.equal(applied.action, 'setup_applied');
    const configured = await readFile(plan.config_path, 'utf8');
    assert.match(configured, /CODEX_BRIDGE_CHATGPT:START/);
    assert.match(configured, /mcp_servers\.codex_bridge_chatgpt/);

    const repeat = await createSetupPlan({ workspaceRoot: root, skillRoot });
    assert.equal(repeat.changed, false);
    assert.equal((await applySetupPlan(repeat)).action, 'setup_unchanged');

    const remove = await createSetupPlan({ workspaceRoot: root, skillRoot, action: 'remove' });
    await applySetupPlan(remove);
    assert.equal((await readFile(remove.config_path, 'utf8')).includes('codex_bridge_chatgpt'), false);
    assert.match(await readFile(join(root, '.codex', 'codex-bridge-chatgpt', `setup-receipt.${remove.plan_id}.json`), 'utf8'), /"action": "remove"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('setup refuses stale plans and unmanaged table collisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v10-setup-conflict-'));
  const skillRoot = join(process.cwd(), 'skills', 'codex-bridge-chatgpt');
  try {
    const plan = await createSetupPlan({ workspaceRoot: root, skillRoot });
    await writeFile(join(root, 'change.txt'), 'unrelated', 'utf8');
    await writeFile(plan.config_path, '# user changed config\n', { encoding: 'utf8', flag: 'w' }).catch(async (error) => {
      if (error.code !== 'ENOENT') throw error;
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(root, '.codex'), { recursive: true });
      await writeFile(plan.config_path, '# user changed config\n', 'utf8');
    });
    await assert.rejects(applySetupPlan(plan), /SETUP_CONFLICT/);
    await writeFile(plan.config_path, '[mcp_servers.codex_bridge_chatgpt]\ncommand="other"\n', 'utf8');
    await assert.rejects(createSetupPlan({ workspaceRoot: root, skillRoot }), /unmanaged/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('setup confines a recomputed plan to its managed project paths and content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v10-setup-boundary-'));
  const skillRoot = join(process.cwd(), 'skills', 'codex-bridge-chatgpt');
  const rehash = (plan) => {
    const unsigned = { ...plan };
    delete unsigned.plan_sha256;
    plan.plan_sha256 = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
    return plan;
  };
  try {
    const plan = await createSetupPlan({ workspaceRoot: root, skillRoot });
    const wrongPath = rehash({ ...plan, config_path: join(root, 'other.toml') });
    await assert.rejects(applySetupPlan(wrongPath), /SETUP_CONFLICT/);
    const wrongContent = rehash({ ...plan, target_config: 'unexpected\n', target_sha256: createHash('sha256').update('unexpected\n').digest('hex') });
    await assert.rejects(applySetupPlan(wrongContent), /SETUP_CONFLICT/);
    await assert.rejects(readFile(join(root, 'other.toml'), 'utf8'), /ENOENT/);
    await assert.rejects(readFile(plan.config_path, 'utf8'), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('support bundle exposes lifecycle evidence without private Chat or workspace paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v10-support-'));
  const directory = join(root, '.bridge');
  const outputPath = join(root, 'support.json');
  try {
    const state = await initializeState({ directory, chatRef: 'private-chat-reference', chatTitle: 'Private title', transport: 'app-thread', workspaceRoot: root });
    const created = await createSupportBundle({ stateDirectory: directory, outputPath });
    const text = await readFile(outputPath, 'utf8');
    assert.equal(created.bundle.bridge.conversation_scope_id, state.conversation_scope.id);
    assert.equal(text.includes('private-chat-reference'), false);
    assert.equal(text.includes('Private title'), false);
    assert.equal(text.includes(root), false);
    assert.equal(text.includes(state.conversation_scope.key), false);
    assert.match(text, /codex_bridge_public_support_bundle/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
