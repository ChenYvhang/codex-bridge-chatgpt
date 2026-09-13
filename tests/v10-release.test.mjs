import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { buildRelease } from '../scripts/build-release.mjs';
import { inspectRelease } from '../skills/codex-bridge-chatgpt/scripts/doctor.mjs';

function extractStoredZip(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    assert.equal(method, 0);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const data = buffer.subarray(dataStart, dataStart + size);
    entries.push({ name, data });
    offset = dataStart + size;
  }
  return entries;
}

test('release archive is byte-reproducible and contains a hash inventory', async () => {
  const first = await buildRelease();
  const second = await buildRelease();
  assert.equal(first.archive.equals(second.archive), true);
  assert.equal(createHash('sha256').update(first.archive).digest('hex'), first.archiveSha256);
  const entries = extractStoredZip(first.archive);
  assert.equal(entries.length, first.buildManifest.files.length + 1);
  assert.ok(entries.some((entry) => entry.name.endsWith('/BUILD-MANIFEST.json')));
  assert.ok(entries.some((entry) => entry.name.endsWith('/skills/codex-bridge-chatgpt/scripts/setup.mjs')));
  assert.equal(entries.some((entry) => /\/(?:\.git|\.codex|dist|node_modules)\//.test(entry.name)), false);
  assert.deepEqual(first.buildManifest.runtime_dependencies, []);
});

test('release policy cannot package a file outside its source root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v10-release-boundary-'));
  try {
    await writeFile(join(root, 'VERSION'), '1.0.0\n');
    await writeFile(join(root, 'release-manifest.json'), JSON.stringify({ version: '1.0.0', root_files: ['../private.txt'], directories: [], excluded_segments: [] }));
    await assert.rejects(buildRelease({ root }), /unsafe path/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the extracted release runs Doctor without repository-local dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-v10-release-'));
  try {
    const release = await buildRelease();
    const entries = extractStoredZip(release.archive);
    for (const entry of entries) {
      if (entry.name.includes('..') || entry.name.startsWith('/')) throw new Error(`unsafe archive entry: ${entry.name}`);
      const output = join(root, ...entry.name.split('/'));
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, entry.data);
    }
    const packageRoot = join(root, 'codex-bridge-chatgpt-1.0.0');
    const doctor = join(packageRoot, 'skills', 'codex-bridge-chatgpt', 'scripts', 'doctor.mjs');
    const run = spawnSync(process.execPath, [doctor, '--json'], { cwd: packageRoot, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(JSON.parse(run.stdout).status, 'READY');
    const mcp = join(packageRoot, 'skills', 'codex-bridge-chatgpt', 'scripts', 'mcp-server.mjs');
    const linkedPackage = join(root, 'linked-package');
    let mcpEntry = mcp;
    try {
      await symlink(packageRoot, linkedPackage, process.platform === 'win32' ? 'junction' : 'dir');
      mcpEntry = join(linkedPackage, 'skills', 'codex-bridge-chatgpt', 'scripts', 'mcp-server.mjs');
    } catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error; }
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bridge_lease_status', arguments: {} } },
    ].map((message) => JSON.stringify(message)).join('\n') + '\n';
    const smoke = spawnSync(process.execPath, [mcpEntry, '--dir', join(root, 'empty-runtime'), '--workspace', packageRoot], { cwd: packageRoot, input, encoding: 'utf8', timeout: 10000 });
    assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
    assert.ok(smoke.stdout.trim(), 'MCP produced no JSON-RPC response');
    const outputLines = smoke.stdout.trim().split(/\r?\n/);
    const replies = outputLines.map((line, index) => {
      try { return JSON.parse(line); }
      catch { throw new Error(`MCP response ${index + 1}/${outputLines.length} is incomplete (${line.length} characters)`); }
    });
    assert.deepEqual(replies.map((reply) => reply.id), [1, 2, 3]);
    assert.equal(replies[0].result.serverInfo.version, '1.0.0');
    assert.equal(replies[1].result.tools.length, 5);
    assert.equal(replies[2].result.isError, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Release Doctor validates aligned versions, state schema, and zero dependencies', async () => {
  const report = await inspectRelease(process.cwd());
  assert.equal(report.status, 'READY');
  assert.equal(report.release_contract_ready, true);
  assert.equal(report.version, '1.0.0');
  assert.ok(['clean', 'working-tree'].includes(report.source_state));
  assert.ok(report.checks.every((check) => check.ok));
  assert.equal(typeof report.publishable, 'boolean');
  assert.equal((await readFile('release-manifest.json', 'utf8')).includes('"state_schema_version": 3'), true);
});
