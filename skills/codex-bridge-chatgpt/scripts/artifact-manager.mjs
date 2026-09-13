#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTECTED_ROOTS = new Set(['.git', '.codex', 'node_modules']);
const PROTECTED_NAMES = new Set(['.env', '.npmrc', '.pypirc', 'credentials', 'credentials.json']);

export function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function resolveArtifactPath(workspaceRoot, artifactPath) {
  if (typeof artifactPath !== 'string' || !artifactPath.trim() || isAbsolute(artifactPath) || /^[a-z]:/i.test(artifactPath)) {
    throw new Error('artifact path must be workspace-relative');
  }
  const normalized = normalize(artifactPath).replaceAll('\\', '/');
  const first = normalized.split('/')[0].toLowerCase();
  const basename = normalized.split('/').at(-1).toLowerCase();
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || PROTECTED_ROOTS.has(first) || PROTECTED_NAMES.has(basename) || first === '.ssh') {
    throw new Error('artifact path is outside the allowed workspace surface');
  }
  const root = resolve(workspaceRoot);
  const target = resolve(root, normalized);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('artifact path escapes the workspace');
  }
  return target;
}

async function existingHash(path) {
  try {
    return hashContent(await readFile(path));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertNoLinkedComponents(workspaceRoot, target) {
  const root = resolve(workspaceRoot);
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const part of relative(root, target).split(sep)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('artifact path contains a symbolic link');
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
  return canonicalRoot;
}

export async function planArtifacts(artifacts, workspaceRoot, maximumBytes = 2_000_000) {
  const plans = [];
  for (const artifact of artifacts ?? []) {
    try {
      const target = resolveArtifactPath(workspaceRoot, artifact.path);
      const canonicalRoot = await assertNoLinkedComponents(workspaceRoot, target);
      const currentSha256 = await existingHash(target);
      let status = 'ready';
      let reason = null;
      if (artifact.delivery === 'attachment') {
        status = 'pending_attachment';
        reason = 'attachment must be acquired and inspected locally';
      } else if (!['create', 'replace', 'merge', 'suggest'].includes(artifact.operation)) {
        status = 'invalid';
        reason = 'unsupported operation';
      } else if (typeof artifact.content !== 'string') {
        status = 'invalid';
        reason = 'inline artifact requires content';
      } else if (Buffer.byteLength(artifact.content, artifact.encoding ?? 'utf8') > maximumBytes) {
        status = 'invalid';
        reason = 'inline artifact exceeds configured size limit';
      } else if (Number.isInteger(artifact.size) && artifact.size !== Buffer.byteLength(artifact.content, artifact.encoding ?? 'utf8')) {
        status = 'invalid';
        reason = 'declared artifact size mismatch';
      } else if (artifact.operation === 'create' && currentSha256 !== null) {
        status = 'conflict';
        reason = 'create target already exists';
      } else if (['replace', 'merge'].includes(artifact.operation)) {
        if (currentSha256 === null) {
          status = 'conflict';
          reason = 'replacement target does not exist';
        } else if (!artifact.base_sha256 || artifact.base_sha256 !== currentSha256) {
          status = 'conflict';
          reason = 'base hash does not match current file';
        }
      } else if (artifact.operation === 'suggest') {
        status = 'suggestion';
        reason = 'suggestions are never applied automatically';
      }
      const contentSha256 = typeof artifact.content === 'string' ? hashContent(artifact.content) : null;
      if (status === 'ready' && artifact.declared_sha256 && artifact.declared_sha256 !== contentSha256) {
        status = 'invalid';
        reason = 'declared content hash mismatch';
      }
      plans.push({ artifact_id: artifact.artifact_id, path: artifact.path, target, workspace_root_real: canonicalRoot, status, reason, current_sha256: currentSha256, content_sha256: contentSha256, artifact_sha256: hashContent(JSON.stringify(artifact)) });
    } catch (error) {
      plans.push({ artifact_id: artifact?.artifact_id ?? null, path: artifact?.path ?? null, status: 'invalid', reason: error.message });
    }
  }
  return plans;
}

export async function applyReadyArtifacts(artifacts, plans, workspaceRoot) {
  if (!workspaceRoot) throw new Error('workspace root is required for artifact application');
  const byId = new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact]));
  const applied = [];
  for (const plan of plans) {
    if (plan.status !== 'ready') continue;
    const artifact = byId.get(plan.artifact_id);
    if (!artifact || typeof artifact.content !== 'string') throw new Error(`missing content for ${plan.artifact_id}`);
    const verifiedTarget = resolveArtifactPath(workspaceRoot, artifact.path);
    if (verifiedTarget !== plan.target) throw new Error(`artifact plan target changed for ${artifact.path}`);
    if (await assertNoLinkedComponents(workspaceRoot, verifiedTarget) !== plan.workspace_root_real) throw new Error(`artifact workspace changed after planning for ${artifact.path}`);
    if (hashContent(artifact.content) !== plan.content_sha256) throw new Error(`artifact content changed after planning for ${artifact.path}`);
    if (hashContent(JSON.stringify(artifact)) !== plan.artifact_sha256) throw new Error(`artifact metadata changed after planning for ${artifact.path}`);
    const currentSha256 = await existingHash(verifiedTarget);
    if (currentSha256 !== plan.current_sha256) throw new Error(`artifact target changed after planning for ${artifact.path}`);
    await mkdir(dirname(plan.target), { recursive: true });
    const temporary = `${plan.target}.codex-bridge-${process.pid}-${Date.now()}.tmp`;
    try {
      await writeFile(temporary, artifact.content, { encoding: artifact.encoding ?? 'utf8', flag: 'wx' });
      await rename(temporary, plan.target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    const actual = await existingHash(plan.target);
    if (actual !== plan.content_sha256) throw new Error(`post-write hash mismatch for ${artifact.path}`);
    applied.push({ artifact_id: artifact.artifact_id, path: artifact.path, sha256: actual });
  }
  return applied;
}

async function main() {
  const [command, manifestPath, workspaceRoot] = process.argv.slice(2);
  if (!['plan', 'apply'].includes(command) || !manifestPath || !workspaceRoot) {
    throw new Error('usage: artifact-manager.mjs <plan|apply> <result.json> <workspace-root>');
  }
  const result = JSON.parse(await readFile(manifestPath, 'utf8'));
  const plans = await planArtifacts(result.artifacts, workspaceRoot);
  if (command === 'plan') {
    console.log(JSON.stringify({ status: 'planned', plans }, null, 2));
    return;
  }
  if (process.env.CODEX_BRIDGE_APPLY !== 'I_REVIEWED_ARTIFACTS') {
    throw new Error('set CODEX_BRIDGE_APPLY=I_REVIEWED_ARTIFACTS only after local artifact review');
  }
  const applied = await applyReadyArtifacts(result.artifacts, plans, workspaceRoot);
  console.log(JSON.stringify({ status: 'applied', plans, applied }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
