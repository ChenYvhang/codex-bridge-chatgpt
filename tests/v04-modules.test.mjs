import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyReadyArtifacts, hashContent, planArtifacts, resolveArtifactPath } from '../skills/codex-bridge-chatgpt/scripts/artifact-manager.mjs';
import { buildContextDelta } from '../skills/codex-bridge-chatgpt/scripts/build-context-delta.mjs';
import { refreshMemoryLedger } from '../skills/codex-bridge-chatgpt/scripts/memory-ledger.mjs';
import { routeQuestions } from '../skills/codex-bridge-chatgpt/scripts/question-router.mjs';
import { routeTask } from '../skills/codex-bridge-chatgpt/scripts/route-task.mjs';
import { negotiateCapabilities, requireCapabilities } from '../skills/codex-bridge-chatgpt/scripts/transport-capabilities.mjs';
import { compareWorkspaceFingerprints, sanitizeRemote, workspaceFingerprint } from '../skills/codex-bridge-chatgpt/scripts/workspace-fingerprint.mjs';

test('routing records Chat, Codex, hybrid, privacy, and user override reasons', () => {
  const base = { computer_dependency: 'low', context_value: 'high', output_weight: 'medium', verification_need: 'low', sensitivity: 'project' };
  assert.equal(routeTask(base).route, 'chat');
  assert.equal(routeTask({ ...base, computer_dependency: 'high', context_value: 'low', verification_need: 'high' }).route, 'codex');
  assert.equal(routeTask({ ...base, output_weight: 'high', context_value: 'medium' }).route, 'hybrid');
  assert.deepEqual(routeTask({ ...base, sensitivity: 'secret' }).reason_codes, ['secret_never_sent']);
  assert.equal(routeTask({ ...base, override: 'codex' }).reason_codes[0], 'user_override');
});

test('workspace comparison distinguishes identity changes from stale local facts', () => {
  const previous = { canonical_root: '/a', repository_root: '/a', remote: 'origin', worktree: '.git', branch: 'main', head: '1', dirty_sha256: 'x' };
  const branchChange = compareWorkspaceFingerprints(previous, { ...previous, branch: 'feature', head: '2' });
  assert.equal(branchChange.same_workspace, true);
  assert.equal(branchChange.invalidate_local_facts, true);
  const repositoryChange = compareWorkspaceFingerprints(previous, { ...previous, canonical_root: '/b', repository_root: '/b' });
  assert.equal(repositoryChange.same_workspace, false);
  assert.equal(sanitizeRemote('https://user:token@example.com/org/repo.git'), 'https://example.com/org/repo.git');
});

test('context deltas anchor the previous receipt and checkpoint without replaying history', () => {
  const delta = buildContextDelta({
    userIntent: ['Add recovery'], newlyVerifiedFacts: ['Tests pass'], invalidatedFacts: ['Old branch fact'],
    previousReceipt: { round: 3, idempotency_key: 'i3', accepted: ['a'], rejected: [], deferred: ['b'] },
    checkpoint: { through_round: 2, entries: [] }, expectedOutputs: ['recovery.md'], questions: ['Choose format'],
  });
  assert.equal(delta.previous_receipt.round, 3);
  assert.match(delta.previous_receipt.sha256, /^[a-f0-9]{64}$/);
  assert.equal(delta.checkpoint.through_round, 2);
  assert.equal(Object.hasOwn(delta, 'transcript'), false);
});

test('questions use local evidence when available and ask the user for intent or credentials', () => {
  const routed = routeQuestions([
    { id: 'q1', text: 'Which Node version?', type: 'local_fact', evidence_key: 'node' },
    { id: 'q2', text: 'Which audience?', type: 'product_intent' },
    { id: 'q3', text: 'What token?', type: 'credential' },
  ], { node: '22.1.0' });
  assert.equal(routed[0].route, 'codex_answer');
  assert.equal(routed[1].route, 'user');
  assert.equal(routed[2].route, 'user');
});

test('transport capability negotiation fails closed when a required feature is unavailable', () => {
  const app = negotiateCapabilities('app-thread', { wait: true, attachment_acquisition: true });
  assert.equal(requireCapabilities(app, ['wait', 'attachment_acquisition']).status, 'ready');
  assert.equal(negotiateCapabilities('app-thread').capabilities.send, false);
  const browser = negotiateCapabilities('in-app-browser');
  assert.deepEqual(requireCapabilities(browser, ['wait']).missing, ['wait']);
  assert.equal(requireCapabilities(browser, ['wait']).status, 'blocked');
});

test('memory ledger invalidates file-backed local facts but keeps durable decisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-memory-'));
  try {
    const source = join(root, 'source.txt');
    await writeFile(source, 'before', 'utf8');
    const workspace = await workspaceFingerprint(root);
    const beforeHash = createHash('sha256').update('before').digest('hex');
    const checkpoint = {
      schema_version: 2, bridge_id: 'b', through_round: 1, objective: 'Test memory', workspace,
      entries: [
        { id: 'fact-1', kind: 'local_fact', value: 'Source says before', status: 'accepted', source_round: 1, freshness: { workspace_fingerprint: workspace.fingerprint_id, files: [{ path: 'source.txt', sha256: beforeHash }] } },
        { id: 'decision-1', kind: 'decision', value: 'Keep JSONL', status: 'accepted', source_round: 1 },
      ],
    };
    await writeFile(source, 'after', 'utf8');
    const refreshed = await refreshMemoryLedger(checkpoint, root);
    assert.equal(refreshed.entries[0].status, 'stale');
    assert.match(refreshed.entries[0].invalidation_reasons.join(','), /file_changed/);
    assert.equal(refreshed.entries[1].status, 'accepted');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('artifact pipeline protects paths, requires fresh bases, and atomically applies reviewed files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-artifacts-'));
  try {
    assert.throws(() => resolveArtifactPath(root, '../escape.txt'), /outside|escapes/);
    assert.throws(() => resolveArtifactPath(root, '.git/config'), /outside/);
    const artifacts = [{ artifact_id: 'a1', path: 'docs/new.md', operation: 'create', delivery: 'inline', content: '# New\n', encoding: 'utf8', declared_sha256: hashContent('# New\n') }];
    const plans = await planArtifacts(artifacts, root);
    assert.equal(plans[0].status, 'ready');
    const applied = await applyReadyArtifacts(artifacts, plans, root);
    assert.equal(applied[0].sha256, hashContent('# New\n'));
    assert.equal(await readFile(join(root, 'docs', 'new.md'), 'utf8'), '# New\n');
    const conflict = await planArtifacts([{ ...artifacts[0], operation: 'replace', content: '# Other\n', base_sha256: '0'.repeat(64) }], root);
    assert.equal(conflict[0].status, 'conflict');
    const attachment = await planArtifacts([{ ...artifacts[0], artifact_id: 'a2', path: 'asset.bin', delivery: 'attachment', attachment_name: 'asset.bin' }], root);
    assert.equal(attachment[0].status, 'pending_attachment');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('artifact application refuses content changed after planning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-artifact-stale-'));
  try {
    const artifact = { artifact_id: 'a', path: 'new.txt', operation: 'create', delivery: 'inline', content: 'approved' };
    const plans = await planArtifacts([artifact], root);
    await assert.rejects(applyReadyArtifacts([{ ...artifact, content: 'changed' }], plans, root), /content changed/);
    await assert.rejects(applyReadyArtifacts([{ ...artifact, encoding: 'utf16le' }], plans, root), /metadata changed/);
    await assert.rejects(readFile(join(root, 'new.txt'), 'utf8'), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('artifact batches reject duplicate targets and preflight every file before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-bridge-artifact-batch-'));
  try {
    const first = { artifact_id: 'first', path: 'docs/first.md', operation: 'create', delivery: 'inline', content: 'first', encoding: 'utf8' };
    const second = { artifact_id: 'second', path: 'docs/second.md', operation: 'create', delivery: 'inline', content: 'second', encoding: 'utf8' };
    const duplicate = await planArtifacts([first, { ...second, path: 'docs/./first.md' }], root);
    assert.deepEqual(duplicate.map((plan) => plan.status), ['conflict', 'conflict']);
    assert.deepEqual(await applyReadyArtifacts([first, { ...second, path: 'docs/./first.md' }], duplicate, root), []);

    const plans = await planArtifacts([first, second], root);
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'second.md'), 'changed after plan', 'utf8');
    await assert.rejects(applyReadyArtifacts([first, second], plans, root), /target changed after planning/);
    await assert.rejects(readFile(join(root, 'docs', 'first.md'), 'utf8'), /ENOENT/);

    const wrongEncoding = await planArtifacts([{ ...first, path: 'docs/utf16.md', encoding: 'utf16le' }], root);
    assert.equal(wrongEncoding[0].status, 'invalid');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('artifact planning refuses a linked directory outside the workspace', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'codex-bridge-artifact-link-'));
  const root = join(parent, 'workspace');
  const outside = join(parent, 'outside');
  try {
    await mkdir(root);
    await mkdir(outside);
    try { await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) { t.skip('symlinks unavailable'); return; } throw error; }
    const plan = await planArtifacts([{ artifact_id: 'a', path: 'linked/new.txt', operation: 'create', delivery: 'inline', content: 'no' }], root);
    assert.equal(plan[0].status, 'invalid');
    assert.match(plan[0].reason, /symbolic link/);
    await assert.rejects(readFile(join(outside, 'new.txt'), 'utf8'), /ENOENT/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
