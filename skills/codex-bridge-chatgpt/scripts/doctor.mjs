#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadState } from './context-state.mjs';

const currentFile = fileURLToPath(import.meta.url);
const defaultSkillRoot = dirname(dirname(currentFile));
const minimumNodeMajor = 18;

const requiredFiles = [
  ['skill', 'SKILL.md'],
  ['interface', 'agents/openai.yaml'],
  ['validator', 'scripts/validate-handoff.mjs'],
  ['automation_consent', 'scripts/automation-consent.mjs'],
  ['context_state', 'scripts/context-state.mjs'],
  ['context_validator', 'scripts/validate-context.mjs'],
  ['workspace_fingerprint', 'scripts/workspace-fingerprint.mjs'],
  ['routing_engine', 'scripts/route-task.mjs'],
  ['delta_builder', 'scripts/build-context-delta.mjs'],
  ['memory_ledger', 'scripts/memory-ledger.mjs'],
  ['artifact_manager', 'scripts/artifact-manager.mjs'],
  ['question_router', 'scripts/question-router.mjs'],
  ['transport_capabilities', 'scripts/transport-capabilities.mjs'],
  ['app_transport_driver', 'scripts/app-transport.mjs'],
  ['token_budget', 'scripts/token-budget.mjs'],
  ['request_optimizer', 'scripts/request-optimizer.mjs'],
  ['health_report', 'scripts/health-report.mjs'],
  ['recovery_bundle', 'scripts/recovery-bundle.mjs'],
  ['mediated_context', 'scripts/mediated-context.mjs'],
  ['bridge_lease', 'scripts/bridge-lease.mjs'],
  ['mcp_server', 'scripts/mcp-server.mjs'],
  ['scope_identity', 'scripts/scope-identity.mjs'],
  ['context_manifest', 'scripts/context-manifest.mjs'],
  ['setup', 'scripts/setup.mjs'],
  ['bridge_cli', 'scripts/bridge.mjs'],
  ['app_transport', 'references/app-transport.md'],
  ['protocol_bootstrap', 'references/protocol-bootstrap.md'],
  ['optimized_workflow', 'references/optimized-workflow.md'],
  ['continuity_workflow', 'references/continuity-workflow.md'],
  ['mediated_context_reference', 'references/mediated-context.md'],
  ['local_mcp_reference', 'references/local-mcp.md'],
  ['concurrency_reference', 'references/concurrency-recovery.md'],
  ['browser_transport', 'references/browser-transport.md'],
  ['context_packet', 'references/context-packet.md'],
  ['persistent_context', 'references/persistent-context.md'],
  ['context_contracts', 'references/context-contracts.md'],
  ['context_recovery', 'references/context-recovery.md'],
  ['routing_policy', 'references/routing-policy.md'],
  ['artifact_pipeline', 'references/artifact-pipeline.md'],
  ['session_lifecycle', 'references/session-lifecycle.md'],
  ['reasoning_request', 'references/reasoning-request.md'],
  ['run_receipt', 'references/run-receipt.md'],
  ['doctor_guide', 'references/doctor.md'],
];

async function fileCheck(skillRoot, id, relativePath) {
  try {
    await access(join(skillRoot, relativePath));
    return { id, path: relativePath, ok: true };
  } catch {
    return { id, path: relativePath, ok: false };
  }
}

export async function inspectInstallation(skillRoot = defaultSkillRoot) {
  const normalizedRoot = resolve(skillRoot);
  const checks = await Promise.all(
    requiredFiles.map(([id, relativePath]) => fileCheck(normalizedRoot, id, relativePath)),
  );

  let skillName = null;
  if (checks.find((check) => check.id === 'skill')?.ok) {
    const skill = await readFile(join(normalizedRoot, 'SKILL.md'), 'utf8');
    skillName = skill.match(/^name:\s*([a-z0-9-]+)$/m)?.[1] ?? null;
  }

  checks.push({
    id: 'skill_name',
    path: 'SKILL.md#name',
    ok: skillName === 'codex-bridge-chatgpt',
  });

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  const runtimeReady = Number.isInteger(nodeMajor) && nodeMajor >= minimumNodeMajor;
  checks.push({
    id: 'node_runtime',
    path: `node>=${minimumNodeMajor}`,
    ok: runtimeReady,
  });

  const status = !runtimeReady
    ? 'MISSING_RUNTIME'
    : checks.every((check) => check.ok)
      ? 'READY'
      : 'INVALID_INSTALLATION';

  return {
    schema_version: 1,
    status,
    skill_name: skillName,
    platform: process.platform,
    node: process.versions.node,
    minimum_node_major: minimumNodeMajor,
    checks,
  };
}

export async function inspectRelease(repoRoot) {
  const root = resolve(repoRoot);
  const files = ['release-manifest.json', 'SUPPORT.md', 'SECURITY.md', 'CONTRIBUTING.md', 'UPSTREAM.md', 'scripts/build-release.mjs', 'tests/v10-foundation.test.mjs'];
  const checks = await Promise.all(files.map((path) => fileCheck(root, `release_${path.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`, path)));
  let policy = null;
  let packageJson = null;
  let version = null;
  try { policy = JSON.parse(await readFile(join(root, 'release-manifest.json'), 'utf8')); } catch { /* represented by checks */ }
  try { packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); } catch { /* represented below */ }
  try { version = (await readFile(join(root, 'VERSION'), 'utf8')).trim(); } catch { /* represented below */ }
  checks.push({ id: 'release_version_alignment', path: 'release-manifest.json/package.json/VERSION', ok: Boolean(policy && packageJson && version && policy.version === packageJson.version && packageJson.version === version) });
  checks.push({ id: 'release_state_schema', path: 'release-manifest.json#state_schema_version', ok: policy?.state_schema_version === 3 });
  checks.push({ id: 'release_zero_runtime_dependencies', path: 'package.json#dependencies', ok: packageJson && (packageJson.dependencies === undefined || Object.keys(packageJson.dependencies).length === 0) });
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const dirty = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const sourceCommit = commit.status === 0 ? commit.stdout.trim() : null;
  const sourceState = dirty.status !== 0 ? 'unknown' : dirty.stdout.trim() ? 'working-tree' : 'clean';
  return {
    schema_version: 1,
    status: checks.every((check) => check.ok) ? 'READY' : 'INVALID_RELEASE',
    release_contract_ready: checks.every((check) => check.ok),
    publishable: checks.every((check) => check.ok) && sourceState === 'clean' && Boolean(sourceCommit),
    version,
    source_commit: sourceCommit,
    source_state: sourceState,
    checks,
  };
}

function diagnosticCode(error) {
  const message = String(error?.message ?? error);
  if (message.includes('SCOPE_MISMATCH')) return 'SCOPE_MISMATCH';
  if (message.includes('legacy state')) return 'MIGRATION_REQUIRED';
  if (message.includes('ENOENT')) return 'STATE_NOT_INITIALIZED';
  return 'STATE_UNREADABLE';
}

export async function createSupportBundle({ skillRoot = defaultSkillRoot, repoRoot = dirname(dirname(defaultSkillRoot)), stateDirectory = '.codex/codex-bridge-chatgpt', outputPath }) {
  if (!outputPath) throw new Error('support bundle requires an output path');
  const installation = await inspectInstallation(skillRoot);
  const release = await inspectRelease(repoRoot);
  let bridge = null;
  let stateDiagnostic = null;
  try {
    const state = await loadState(stateDirectory);
    bridge = {
      state_schema_version: state.schema_version,
      state_revision: state.state_revision,
      status: state.status,
      conversation_scope_id: state.conversation_scope?.id ?? null,
      workspace_fingerprint_id: state.workspace?.fingerprint_id ?? null,
      transport: state.chat?.transport ?? null,
      identity_status: state.chat?.identity_status ?? null,
      current_round: state.current_round,
      last_completed_round: state.last_completed_round,
      in_flight_phase: state.in_flight?.phase ?? null,
      last_outcome: state.last_exchange?.outcome ?? null,
    };
  } catch (error) {
    stateDiagnostic = diagnosticCode(error);
  }
  const bundle = {
    schema_version: 1,
    kind: 'codex_bridge_public_support_bundle',
    privacy: 'No prompts, responses, source, file paths, Chat references, account data, cookies, credentials, or scope keys are included.',
    package_version: release.version,
    platform: process.platform,
    architecture: process.arch,
    node: process.versions.node,
    installation: { status: installation.status, checks: installation.checks.map(({ id, ok }) => ({ id, ok })) },
    release: { status: release.status, source_commit: release.source_commit, source_state: release.source_state },
    bridge,
    state_diagnostic: stateDiagnostic,
  };
  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { schema_version: 1, status: 'READY', action: 'support_bundle_written', output_path: destination, bundle };
}

function parseArgs(argv) {
  const options = { json: false, release: false, skillRoot: defaultSkillRoot, repoRoot: dirname(dirname(defaultSkillRoot)), supportBundle: null, stateDirectory: '.codex/codex-bridge-chatgpt' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--release') {
      options.release = true;
      continue;
    }
    if (argument === '--skill-root' && argv[index + 1]) {
      options.skillRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--repo-root' && argv[index + 1]) {
      options.repoRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--support-bundle' && argv[index + 1]) {
      options.supportBundle = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--state-dir' && argv[index + 1]) {
      options.stateDirectory = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown or incomplete argument: ${argument}`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`usage: doctor.mjs [--json] [--skill-root <path>] [--release] [--repo-root <path>] [--support-bundle <path>] [--state-dir <path>]\n${error.message}`);
    process.exitCode = 2;
    return;
  }

  const result = options.supportBundle
    ? await createSupportBundle({ skillRoot: options.skillRoot, repoRoot: options.repoRoot, stateDirectory: options.stateDirectory, outputPath: options.supportBundle })
    : options.release ? await inspectRelease(options.repoRoot) : await inspectInstallation(options.skillRoot);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Codex bridge Doctor: ${result.status}`);
    for (const check of result.checks) {
      console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.id}: ${check.path}`);
    }
  }
  process.exitCode = result.status === 'READY' ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(currentFile)) {
  await main();
}
