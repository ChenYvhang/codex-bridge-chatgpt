#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function git(root, args) {
  const run = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  return run.status === 0 ? run.stdout.trim() : null;
}

export function sanitizeRemote(remote) {
  if (!remote) return remote;
  return remote.replace(/:\/\/[^/@\s]+@/, '://');
}

export async function workspaceFingerprint(workspaceRoot = process.cwd(), projectLabel = null) {
  const requestedRoot = resolve(workspaceRoot);
  const canonicalRoot = await realpath(requestedRoot).catch(() => requestedRoot);
  const repositoryRoot = git(canonicalRoot, ['rev-parse', '--show-toplevel']);
  const remote = sanitizeRemote(git(canonicalRoot, ['config', '--get', 'remote.origin.url']));
  const branch = git(canonicalRoot, ['branch', '--show-current']);
  const head = git(canonicalRoot, ['rev-parse', 'HEAD']);
  const status = git(canonicalRoot, ['status', '--porcelain=v1', '-z']) ?? '';
  const worktree = git(canonicalRoot, ['rev-parse', '--git-dir']);
  const fingerprint = {
    canonical_root: canonicalRoot,
    repository_root: repositoryRoot,
    remote,
    worktree,
    branch,
    head,
    dirty_sha256: sha256(status),
    project_label: projectLabel,
  };
  return { ...fingerprint, fingerprint_id: sha256(JSON.stringify(fingerprint)) };
}

export function compareWorkspaceFingerprints(previous, current) {
  const changed = [];
  for (const field of ['canonical_root', 'repository_root', 'remote', 'worktree', 'branch', 'head', 'dirty_sha256']) {
    if ((previous?.[field] ?? null) !== (current?.[field] ?? null)) changed.push(field);
  }
  return {
    same_workspace: !changed.some((field) => ['canonical_root', 'repository_root', 'remote', 'worktree'].includes(field)),
    changed,
    invalidate_local_facts: changed.some((field) => ['branch', 'head', 'dirty_sha256', 'worktree'].includes(field)),
  };
}

async function main() {
  const rootIndex = process.argv.indexOf('--workspace-root');
  const labelIndex = process.argv.indexOf('--project-label');
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd();
  const label = labelIndex >= 0 ? process.argv[labelIndex + 1] : null;
  console.log(JSON.stringify(await workspaceFingerprint(root, label), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
