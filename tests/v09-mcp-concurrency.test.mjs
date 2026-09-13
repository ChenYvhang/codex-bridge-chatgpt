import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { acquireBridgeLease, inspectBridgeLease, leasePaths } from '../skills/codex-bridge-chatgpt/scripts/bridge-lease.mjs';
import { initializeState, loadState, recordProtocolBootstrap, recordTransportObservation } from '../skills/codex-bridge-chatgpt/scripts/context-state.mjs';
import { createMcpDispatcher, MCP_TOOLS } from '../skills/codex-bridge-chatgpt/scripts/mcp-server.mjs';

async function initializedRoot(prefix = 'bridge-v09-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const directory = join(root, '.bridge');
  await writeFile(join(root, 'README.md'), 'public workspace context\nsecond line', 'utf8');
  await initializeState({ directory, chatRef: 'private-chat', transport: 'app-thread', workspaceRoot: root });
  await recordProtocolBootstrap({ directory, protocol: 'compact-v1', evidence: 'ACK-BRIDGE-PROTOCOL compact-v1' });
  return { root, directory };
}

test('write lease is exclusive and releases only its own ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v09-lease-'));
  try {
    const first = await acquireBridgeLease({ directory: root, operation: 'first', timeoutMs: 0 });
    await assert.rejects(acquireBridgeLease({ directory: root, operation: 'second', timeoutMs: 30 }), /BRIDGE_BUSY: first/);
    assert.equal((await inspectBridgeLease(root)).operation, 'first');
    assert.equal(await first.release(), true);
    assert.deepEqual(await inspectBridgeLease(root), { active: false });
    const second = await acquireBridgeLease({ directory: root, operation: 'second', timeoutMs: 0 });
    await second.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dead stale lease is atomically quarantined and reclaimed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v09-stale-'));
  try {
    const paths = leasePaths(root);
    await mkdir(paths.lock, { recursive: true });
    await writeFile(paths.owner, JSON.stringify({ schema_version: 1, lease_id: 'dead', pid: 99999999, operation: 'crashed', acquired_at: '2000-01-01T00:00:00.000Z', heartbeat_at: '2000-01-01T00:00:00.000Z' }), 'utf8');
    const lease = await acquireBridgeLease({ directory: root, operation: 'recovery', timeoutMs: 100, staleMs: 1000 });
    assert.equal((await inspectBridgeLease(root)).operation, 'recovery');
    await lease.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('state revisions reject a concurrent stale writer instead of losing an update', async () => {
  const { root, directory } = await initializedRoot('bridge-v09-cas-');
  try {
    const blocker = await acquireBridgeLease({ directory, operation: 'test-blocker', timeoutMs: 0 });
    const writes = [
      recordTransportObservation({ directory, capability: 'read', available: true, evidence: 'observer one' }),
      recordTransportObservation({ directory, capability: 'send', available: true, evidence: 'observer two' }),
    ];
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
    await blocker.release();
    const results = await Promise.allSettled(writes);
    assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(results.filter((entry) => entry.status === 'rejected' && /STATE_CONFLICT/.test(entry.reason?.message)).length, 1);
    const state = await loadState(directory);
    assert.equal(state.chat.capability_observations.length, 1);
    assert.equal(state.state_revision >= 3, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('MCP advertises a bounded read-only tool surface and server guidance', async () => {
  const dispatch = createMcpDispatcher();
  const initialized = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(initialized.result.serverInfo.version, '1.0.0');
  assert.match(initialized.result.instructions, /never send messages/i);
  const listed = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), MCP_TOOLS.map((tool) => tool.name));
  assert.ok(listed.result.tools.every((tool) => tool.annotations.readOnlyHint === true && tool.inputSchema.additionalProperties === false));
});

test('MCP status and dry run do not change persistent state', async () => {
  const { root, directory } = await initializedRoot('bridge-v09-dry-');
  try {
    const dispatch = createMcpDispatcher({ directory, workspaceRoot: root });
    const before = await readFile(join(directory, 'state.json'), 'utf8');
    const status = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bridge_status', arguments: {} } });
    assert.equal(status.result.structuredContent.status, 'READY');
    assert.equal(JSON.stringify(status).includes('private-chat'), false);
    const dry = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_dry_run', arguments: { spec: { profile: 'review', objective: 'Review locally', context_delta: { evidence: ['one fact'] }, allow_reuse: false } } } });
    assert.equal(dry.result.structuredContent.state_mutated, false);
    assert.equal(dry.result.structuredContent.would_send, true);
    assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('MCP context pull returns bounded content without a response file or state mutation', async () => {
  const { root, directory } = await initializedRoot('bridge-v09-pull-');
  try {
    const state = await loadState(directory);
    const dispatch = createMcpDispatcher({ directory, workspaceRoot: root, defaultMaxTokens: 600 });
    const before = await readFile(join(directory, 'state.json'), 'utf8');
    const called = await dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bridge_pull_context', arguments: { query: { schema_version: 1, bridge_id: state.bridge_id, conversation_scope_id: state.conversation_scope.id, round: 1, request_id: 'mcp-pull-1', requests: [{ id: 'readme', kind: 'read_file', path: 'README.md', start_line: 1, end_line: 1 }] } } } });
    assert.equal(called.result.isError, undefined);
    assert.equal(called.result.structuredContent.items[0].data.content, 'public workspace context');
    assert.equal(called.result.structuredContent.items[0].data.has_more, true);
    assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), before);
    await assert.rejects(readFile(join(root, 'response.json'), 'utf8'), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('MCP rejects unknown tools, arbitrary arguments, and over-budget context', async () => {
  const { root, directory } = await initializedRoot('bridge-v09-reject-');
  try {
    const state = await loadState(directory);
    const dispatch = createMcpDispatcher({ directory, workspaceRoot: root });
    const unknown = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shell', arguments: { command: 'whoami' } } });
    assert.equal(unknown.result.isError, true);
    const extra = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_status', arguments: { path: '.' } } });
    assert.equal(extra.result.isError, true);
    const budget = await dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bridge_pull_context', arguments: { max_tokens: 0, query: { schema_version: 1, bridge_id: state.bridge_id, conversation_scope_id: state.conversation_scope.id, round: 1, request_id: 'bad-budget', requests: [{ id: 'x', kind: 'latest_receipt' }] } } } });
    assert.equal(budget.result.isError, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stdio transport exchanges newline-delimited JSON-RPC without non-protocol stdout', async () => {
  const script = resolve('skills/codex-bridge-chatgpt/scripts/mcp-server.mjs');
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  child.stdin.end();
  const exitCode = await new Promise((resolvePromise, reject) => { child.once('error', reject); child.once('close', resolvePromise); });
  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  const messages = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.id), [1, 2]);
  assert.equal(messages[1].result.tools.length, MCP_TOOLS.length);
});
