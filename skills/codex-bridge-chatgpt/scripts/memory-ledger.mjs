#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceFingerprint, compareWorkspaceFingerprints } from './workspace-fingerprint.mjs';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}

export async function refreshMemoryLedger(checkpoint, workspaceRoot) {
  const root = resolve(workspaceRoot);
  const currentWorkspace = await workspaceFingerprint(root, checkpoint.workspace?.project_label ?? null);
  const workspaceChange = compareWorkspaceFingerprints(checkpoint.workspace, currentWorkspace);
  const now = new Date().toISOString();
  const entries = [];
  for (const original of checkpoint.entries ?? []) {
    const entry = structuredClone(original);
    if (entry.kind !== 'local_fact' || entry.status === 'stale') {
      entries.push(entry);
      continue;
    }
    const reasons = [];
    if (workspaceChange.invalidate_local_facts && entry.freshness?.workspace_fingerprint !== currentWorkspace.fingerprint_id) {
      reasons.push('workspace_changed');
    }
    for (const source of entry.freshness?.files ?? []) {
      const absolute = resolve(root, source.path);
      if (!inside(root, absolute)) {
        reasons.push(`unsafe_source:${source.path}`);
        continue;
      }
      try {
        const actual = sha256(await readFile(absolute));
        if (actual !== source.sha256) reasons.push(`file_changed:${source.path}`);
      } catch {
        reasons.push(`file_unavailable:${source.path}`);
      }
    }
    if (reasons.length) {
      entry.status = 'stale';
      entry.invalidated_at = now;
      entry.invalidation_reasons = [...new Set(reasons)];
    }
    entries.push(entry);
  }
  return {
    ...checkpoint,
    workspace: currentWorkspace,
    entries,
    refreshed_at: now,
  };
}

async function main() {
  const [checkpointPath, workspaceRoot, outputPath] = process.argv.slice(2);
  if (!checkpointPath || !workspaceRoot || !outputPath) {
    throw new Error('usage: memory-ledger.mjs <checkpoint.json> <workspace-root> <output.json>');
  }
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  const refreshed = await refreshMemoryLedger(checkpoint, workspaceRoot);
  await writeFile(outputPath, `${JSON.stringify(refreshed, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ status: 'refreshed', output: resolve(outputPath) }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
