#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const START = '# CODEX_BRIDGE_CHATGPT:START';
const END = '# CODEX_BRIDGE_CHATGPT:END';
const currentFile = fileURLToPath(import.meta.url);
const defaultSkillRoot = dirname(dirname(currentFile));

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function toml(value) { return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }

async function optionalText(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return ''; throw error; }
}

async function assertLocalSetupPaths(workspace) {
  for (const path of [join(workspace, '.codex'), join(workspace, '.codex', 'config.toml'), join(workspace, '.codex', 'codex-bridge-chatgpt')]) {
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error(`SETUP_CONFLICT: setup path is a symbolic link: ${path}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function mcpBlock({ workspaceRoot, skillRoot }) {
  const script = join(skillRoot, 'scripts', 'mcp-server.mjs');
  return `${START}
[mcp_servers.codex_bridge_chatgpt]
command = "node"
args = [
  ${toml(script)},
  "--dir", ".codex/codex-bridge-chatgpt",
  "--workspace", ".",
  "--max-tokens", "1200"
]
cwd = ${toml(workspaceRoot)}
enabled = true
required = false
enabled_tools = ["bridge_status", "bridge_health", "bridge_lease_status", "bridge_dry_run", "bridge_pull_context"]
default_tools_approval_mode = "auto"
startup_timeout_sec = 10
tool_timeout_sec = 60

[mcp_servers.codex_bridge_chatgpt.tools.bridge_pull_context]
output_token_limit = 3000
${END}`;
}

function replaceMarked(content, block, action) {
  const start = content.indexOf(START);
  const end = content.indexOf(END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) throw new Error('SETUP_CONFLICT: malformed existing managed block');
  if (start < 0 && /\[mcp_servers\.codex_bridge_chatgpt(?:\]|\.)/.test(content)) throw new Error('SETUP_CONFLICT: an unmanaged codex_bridge_chatgpt table already exists');
  if (start >= 0) {
    const after = end + END.length;
    const replacement = action === 'install' ? block : '';
    return `${content.slice(0, start)}${replacement}${content.slice(after)}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }
  if (action === 'remove') return content;
  return `${content.trimEnd()}${content.trim() ? '\n\n' : ''}${block}\n`;
}

export async function createSetupPlan({ workspaceRoot = process.cwd(), skillRoot = defaultSkillRoot, action = 'install' } = {}) {
  if (!['install', 'remove'].includes(action)) throw new Error('setup action must be install or remove');
  const workspace = await realpath(resolve(workspaceRoot));
  const skill = await realpath(resolve(skillRoot));
  await assertLocalSetupPaths(workspace);
  const configPath = join(workspace, '.codex', 'config.toml');
  const before = await optionalText(configPath);
  const after = replaceMarked(before, mcpBlock({ workspaceRoot: workspace, skillRoot: skill }), action);
  const plan = {
    schema_version: 1,
    kind: 'codex_bridge_setup_plan',
    action,
    plan_id: randomUUID(),
    workspace_root: workspace,
    skill_root: skill,
    config_path: configPath,
    state_directory: join(workspace, '.codex', 'codex-bridge-chatgpt'),
    base_sha256: sha256(before),
    target_sha256: sha256(after),
    changed: before !== after,
    operations: before === after ? [] : [{ operation: before ? 'replace_managed_block' : 'create_project_config', path: '.codex/config.toml' }],
    target_config: after,
    created_at: new Date().toISOString(),
  };
  plan.plan_sha256 = sha256(JSON.stringify(plan));
  return plan;
}

async function atomicText(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

export async function applySetupPlan(plan) {
  const unsigned = structuredClone(plan);
  delete unsigned.plan_sha256;
  if (plan?.schema_version !== 1 || plan?.kind !== 'codex_bridge_setup_plan' || !['install', 'remove'].includes(plan.action) || sha256(JSON.stringify(unsigned)) !== plan.plan_sha256) throw new Error('SETUP_CONFLICT: setup plan is invalid or changed');
  const workspace = await realpath(plan.workspace_root);
  const skill = await realpath(plan.skill_root);
  if (workspace !== plan.workspace_root || skill !== plan.skill_root) throw new Error('SETUP_CONFLICT: canonical paths changed after preview');
  if (plan.config_path !== join(workspace, '.codex', 'config.toml') || plan.state_directory !== join(workspace, '.codex', 'codex-bridge-chatgpt')) throw new Error('SETUP_CONFLICT: setup plan paths are outside the project');
  await assertLocalSetupPaths(workspace);
  const current = await optionalText(plan.config_path);
  if (sha256(current) !== plan.base_sha256) throw new Error('SETUP_CONFLICT: project config changed after preview');
  if (sha256(plan.target_config) !== plan.target_sha256) throw new Error('SETUP_CONFLICT: target config hash does not match the preview');
  if (plan.target_config !== replaceMarked(current, mcpBlock({ workspaceRoot: workspace, skillRoot: skill }), plan.action) || plan.changed !== (current !== plan.target_config)) throw new Error('SETUP_CONFLICT: target config differs from the managed preview');
  if (!plan.changed) return { action: 'setup_unchanged', plan_id: plan.plan_id, config_path: plan.config_path, state_preserved: true };

  const backupDirectory = join(plan.state_directory, 'setup-backups');
  let backupPath = null;
  if (current) {
    backupPath = join(backupDirectory, `config.${plan.base_sha256.slice(0, 12)}.toml`);
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    try { await writeFile(backupPath, current, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    if (sha256(await readFile(backupPath, 'utf8')) !== plan.base_sha256) throw new Error('SETUP_CONFLICT: setup backup integrity check failed');
  }
  await atomicText(plan.config_path, plan.target_config);
  const receipt = {
    schema_version: 1,
    action: plan.action,
    plan_id: plan.plan_id,
    plan_sha256: plan.plan_sha256,
    config_sha256: plan.target_sha256,
    backup: backupPath ? `setup-backups/${backupPath.split(/[\\/]/).at(-1)}` : null,
    applied_at: new Date().toISOString(),
  };
  await mkdir(plan.state_directory, { recursive: true, mode: 0o700 });
  await atomicText(join(plan.state_directory, `setup-receipt.${plan.plan_id}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  return { action: plan.action === 'install' ? 'setup_applied' : 'setup_removed', plan_id: plan.plan_id, config_path: plan.config_path, backup_path: backupPath, state_preserved: true };
}

function parseArgs(argv) {
  const options = { action: 'install', workspace: process.cwd(), skillRoot: defaultSkillRoot, apply: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--workspace' && argv[index + 1]) options.workspace = argv[++index];
    else if (argument === '--skill-root' && argv[index + 1]) options.skillRoot = argv[++index];
    else if (argument === '--action' && argv[index + 1]) options.action = argv[++index];
    else if (argument === '--output' && argv[index + 1]) options.output = argv[++index];
    else if (argument === '--apply' && argv[index + 1]) options.apply = argv[++index];
    else throw new Error(`unknown or incomplete argument: ${argument}`);
  }
  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.apply) {
      const plan = JSON.parse(await readFile(resolve(options.apply), 'utf8'));
      console.log(JSON.stringify(await applySetupPlan(plan), null, 2));
      return;
    }
    const plan = await createSetupPlan({ workspaceRoot: options.workspace, skillRoot: options.skillRoot, action: options.action });
    if (options.output) await atomicText(resolve(options.output), `${JSON.stringify(plan, null, 2)}\n`);
    console.log(JSON.stringify(plan, null, 2));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === currentFile) await main();
