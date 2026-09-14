import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { dryRunFromSpec, prepareContextResponse } from '../skills/codex-bridge-chatgpt/scripts/bridge.mjs';
import { initializeState, loadState, recordProtocolBootstrap } from '../skills/codex-bridge-chatgpt/scripts/context-state.mjs';
import { SecureContextReader, executeContextQuery, validateContextQuery } from '../skills/codex-bridge-chatgpt/scripts/mediated-context.mjs';

function digestWithoutDeclared(response) {
  const copy = structuredClone(response);
  delete copy.response_sha256;
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

test('secure reader returns bounded line ranges with workspace-relative identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v08-read-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.txt'), Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join('\n'), 'utf8');
    const reader = await SecureContextReader.open(root);
    const result = await reader.readText('src/a.txt', { startLine: 20, endLine: 999 });
    assert.equal(result.path, 'src/a.txt');
    assert.equal(result.start_line, 20);
    assert.equal(result.end_line, 419);
    assert.equal(result.has_more, true);
    assert.equal(JSON.stringify(result).includes(root), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('secure reader blocks traversal, sensitive paths, and custom ignore rules', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'bridge-v08-deny-'));
  const root = join(parent, 'workspace');
  try {
    await mkdir(root);
    await writeFile(join(parent, 'outside.txt'), 'outside', 'utf8');
    await writeFile(join(root, '.env'), 'SAFE_TEST_VALUE=1', 'utf8');
    await writeFile(join(root, 'private.txt'), 'private', 'utf8');
    await writeFile(join(root, '.codexbridgeignore'), 'private.txt\n', 'utf8');
    const reader = await SecureContextReader.open(root);
    await assert.rejects(reader.readText('../outside.txt'), /PATH_OUTSIDE_WORKSPACE/);
    await assert.rejects(reader.readText('.env'), /ACCESS_DENIED/);
    await assert.rejects(reader.readText('private.txt'), /ACCESS_DENIED/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('secure reader denies nested metadata and credential paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v08-nested-deny-'));
  try {
    await mkdir(join(root, 'nested', '.git'), { recursive: true });
    await mkdir(join(root, 'nested', '.codex'), { recursive: true });
    await writeFile(join(root, 'nested', '.git', 'config'), 'metadata marker', 'utf8');
    await writeFile(join(root, 'nested', '.codex', 'state.json'), 'state marker', 'utf8');
    await writeFile(join(root, 'nested', 'credentials'), 'credential marker', 'utf8');
    const reader = await SecureContextReader.open(root);
    await assert.rejects(reader.readText('nested/.git/config'), /ACCESS_DENIED/);
    await assert.rejects(reader.readText('nested/.codex/state.json'), /ACCESS_DENIED/);
    await assert.rejects(reader.readText('nested/credentials'), /ACCESS_DENIED/);
    assert.deepEqual((await reader.search('marker')).matches, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('context errors hide local paths and unreadable ignore rules fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v08-error-privacy-'));
  try {
    const reader = await SecureContextReader.open(root);
    const prepared = await executeContextQuery({
      query: { schema_version: 1, bridge_id: 'b', conversation_scope_id: 'a'.repeat(64), round: 1, request_id: 'missing-1', requests: [{ id: 'missing', kind: 'read_file', path: 'not-here.txt' }] },
      reader,
    });
    assert.equal(prepared.response.items[0].error, 'NOT_FOUND');
    assert.equal(JSON.stringify(prepared.response).includes(root), false);
    await mkdir(join(root, '.codexbridgeignore'));
    await assert.rejects(SecureContextReader.open(root), /IGNORE_FILE_UNAVAILABLE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('directory search does not follow a link outside the workspace', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'bridge-v08-search-link-'));
  const root = join(parent, 'workspace');
  const outside = join(parent, 'outside');
  try {
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, 'hidden.txt'), 'outside-marker', 'utf8');
    try { await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) { t.skip('symlinks unavailable'); return; } throw error; }
    const reader = await SecureContextReader.open(root);
    assert.deepEqual((await reader.search('outside-marker')).matches, []);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('mediated response denies secret-bearing content without returning it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v08-secret-'));
  try {
    await writeFile(join(root, 'code.txt'), 'api_key=sk-abcdefghijklmnopqrstuvwxyz123456', 'utf8');
    const reader = await SecureContextReader.open(root);
    const prepared = await executeContextQuery({
      query: { schema_version: 1, bridge_id: 'b', conversation_scope_id: 'a'.repeat(64), round: 1, request_id: 'pull-1', requests: [{ id: 'one', kind: 'read_file', path: 'code.txt' }] },
      reader,
    });
    assert.equal(prepared.response.items[0].status, 'denied');
    assert.equal(prepared.response.items[0].error, 'SENSITIVE_CONTENT');
    assert.equal(prepared.response.context_manifest.entries[0].status, 'redacted');
    assert.equal(JSON.stringify(prepared.response).includes('abcdefghijklmnopqrstuvwxyz'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('literal search is bounded and skips protected directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v08-search-'));
  try {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, '.git'));
    await writeFile(join(root, 'src', 'a.txt'), 'needle one\nneedle two\nneedle three', 'utf8');
    await writeFile(join(root, '.git', 'hidden.txt'), 'needle hidden', 'utf8');
    const reader = await SecureContextReader.open(root);
    const result = await reader.search('needle', { limit: 2 });
    assert.equal(result.matches.length, 2);
    assert.equal(result.truncated, true);
    assert.ok(result.matches.every((match) => match.path === 'src/a.txt'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('git diff excludes sensitive paths before returning content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v08-diff-'));
  try {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Bridge Test'], { cwd: root });
    await mkdir(join(root, 'nested', '.codex'), { recursive: true });
    await writeFile(join(root, '.env'), 'HIDDEN=before\n', 'utf8');
    await writeFile(join(root, 'nested', '.codex', 'state.txt'), 'PRIVATE_STATE=before\n', 'utf8');
    await writeFile(join(root, 'safe.txt'), 'safe before\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root, stdio: 'ignore' });
    await writeFile(join(root, '.env'), 'HIDDEN=after\n', 'utf8');
    await writeFile(join(root, 'nested', '.codex', 'state.txt'), 'PRIVATE_STATE=after\n', 'utf8');
    await writeFile(join(root, 'safe.txt'), 'safe after\n', 'utf8');
    const reader = await SecureContextReader.open(root);
    const result = await reader.gitDiff({ mode: 'unstaged' });
    assert.match(result.content, /safe after/);
    assert.equal(result.content.includes('.env'), false);
    assert.equal(result.content.includes('HIDDEN'), false);
    assert.equal(result.content.includes('PRIVATE_STATE'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('context request validation rejects unknown fields, operations, and duplicate ids', () => {
  const errors = validateContextQuery({
    schema_version: 1, bridge_id: 'b', conversation_scope_id: 'a'.repeat(64), round: 1, request_id: 'pull-1', extra: true,
    requests: [{ id: 'x', kind: 'read_file', path: 'a', surprise: true }, { id: 'x', kind: 'shell', command: 'whoami' }],
  });
  assert.ok(errors.some((error) => error.includes('unknown top-level')));
  assert.ok(errors.some((error) => error.includes('unknown fields')));
  assert.ok(errors.some((error) => error.includes('duplicated')));
  assert.ok(errors.some((error) => error.includes('kind is invalid')));
});

test('integrated context preparation binds bridge and round, hashes output, and does not send', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v08-integrated-'));
  const directory = join(root, '.bridge');
  try {
    await writeFile(join(root, 'README.md'), 'public context', 'utf8');
    await initializeState({ directory, chatRef: 'private-chat', transport: 'app-thread', workspaceRoot: root });
    const state = await loadState(directory);
    const requestPath = join(root, 'query.json');
    const outputPath = join(root, 'response.json');
    await writeFile(requestPath, JSON.stringify({ schema_version: 1, bridge_id: state.bridge_id, conversation_scope_id: state.conversation_scope.id, round: 1, request_id: 'pull-1', requests: [{ id: 'readme', kind: 'read_file', path: 'README.md' }, { id: 'receipt', kind: 'latest_receipt' }] }), 'utf8');
    const result = await prepareContextResponse({ directory, requestPath, outputPath, workspaceRoot: root, maxTokens: 800 });
    const response = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(result.should_send, false);
    assert.equal(result.approximate_tokens <= 800, true);
    assert.equal(response.response_sha256, digestWithoutDeclared(response));
    assert.equal(JSON.stringify(response).includes('private-chat'), false);
    assert.equal((await loadState(directory)).current_round, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dry run attributes source tokens and leaves persistent state unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v08-dry-'));
  const directory = join(root, '.bridge');
  try {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await initializeState({ directory, chatRef: 'private-chat', transport: 'app-thread', workspaceRoot: root });
    await recordProtocolBootstrap({ directory, protocol: 'compact-v1', evidence: 'ACK-BRIDGE-PROTOCOL compact-v1' });
    const before = await loadState(directory);
    const specPath = join(root, 'spec.json');
    await writeFile(specPath, JSON.stringify({ profile: 'review', objective: 'Review safely', context_delta: { user_intent: ['Review'], evidence: ['One fact'], constraints: ['Stay local'] } }), 'utf8');
    const result = await dryRunFromSpec({ directory, specPath, workspaceRoot: root });
    const after = await loadState(directory);
    assert.equal(result.state_mutated, false);
    assert.equal(result.source_tokens.evidence > 0, true);
    assert.equal(result.context_manifest.kind, 'outgoing_request');
    assert.equal(after.current_round, before.current_round);
    assert.equal(after.updated_at, before.updated_at);
  } finally { await rm(root, { recursive: true, force: true }); }
});
