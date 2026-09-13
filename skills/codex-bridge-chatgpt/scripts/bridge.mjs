#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abortRound, beginRound, DEFAULT_STATE_DIRECTORY, loadState, prepareRound, resumeAppPolling, resumeBridge, statePaths } from './context-state.mjs';
import { buildCompactRequest } from './build-context-delta.mjs';
import { compactContextDelta, optimizeRequest, requestSemanticKey, reusableExchange } from './request-optimizer.mjs';
import { analyzePayload, estimateTokens, summarizeCosts } from './token-budget.mjs';
import { compareWorkspaceFingerprints, workspaceFingerprint } from './workspace-fingerprint.mjs';
import { validateContextRequest } from './validate-context.mjs';
import { buildHealthReport } from './health-report.mjs';
import { batchQuestions } from './question-router.mjs';
import { createRecoveryBundle } from './recovery-bundle.mjs';
import { SecureContextReader, executeContextQuery } from './mediated-context.mjs';
import { buildRequestContextManifest } from './context-manifest.mjs';

function parseArgs(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--') || argv[index + 1] === undefined) throw new Error(`unknown or incomplete argument: ${argument}`);
    options[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  return { command, options };
}

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function verifiedJson(path, expectedSha256) {
  if (!path) return { value: null, integrity: null };
  try {
    const raw = await readFile(path);
    const integrity = expectedSha256 ? createHash('sha256').update(raw).digest('hex') === expectedSha256 : null;
    return { value: JSON.parse(raw.toString('utf8')), integrity };
  } catch (error) {
    if (error.code === 'ENOENT') return { value: null, integrity: false };
    throw error;
  }
}

export function statusView(state, { sinceRevision = null } = {}) {
  if (sinceRevision !== null && Number(sinceRevision) === state.state_revision) {
    return { status: state.status, state_revision: state.state_revision, unchanged: true };
  }
  const delivery = state.in_flight?.delivery ?? null;
  return {
    status: state.status,
    state_revision: state.state_revision,
    conversation_scope_id: state.conversation_scope?.id ?? null,
    chat: { title: state.chat.title, transport: state.chat.transport, identity_status: state.chat.identity_status },
    protocol: state.chat.protocol ?? { version: 'compact-v1', status: 'required' },
    round: state.in_flight?.round ?? state.last_completed_round,
    phase: state.in_flight?.phase ?? null,
    delivery_status: delivery?.status ?? null,
    next_action: state.status === 'READY' && state.chat.protocol?.status !== 'ready' ? 'bootstrap_chat_protocol'
      : state.status === 'READY' ? 'start_round'
      : state.status === 'AWAITING_RESULT' || (state.status === 'RECOVERY_REQUIRED' && delivery) ? 'poll_bound_chat'
        : state.status === 'PAUSED' || state.status === 'BLOCKED_BY_USER_ACTION' ? 'resume_when_ready'
          : 'continue_current_phase',
    should_resend: false,
    last_outcome: state.last_exchange?.outcome ?? null,
  };
}

export async function inspectRound(directory, requestedRound, full = false) {
  const state = await loadState(directory);
  const round = requestedRound === 'current' ? state.in_flight?.round
    : requestedRound === 'last' || requestedRound === undefined ? state.in_flight?.round ?? state.last_completed_round
      : Number(requestedRound);
  if (!Number.isInteger(round) || round < 1) throw new Error('no inspectable round');
  const exchangeRoot = join(statePaths(directory).exchanges, String(round).padStart(4, '0'));
  const request = await optionalJson(join(exchangeRoot, 'request.json'));
  const result = await optionalJson(join(exchangeRoot, 'result.json'));
  const adoption = await optionalJson(join(exchangeRoot, 'adoption.json'));
  const receipt = await optionalJson(join(exchangeRoot, 'receipt.json'));
  const view = {
    round,
    profile: request?.profile ?? result?.profile ?? null,
    objective: request?.objective ?? null,
    protocol: request?.protocol ?? 'full-v2',
    idempotency_key: request?.idempotency_key ?? null,
    has_result: Boolean(result),
    adoption_status: adoption?.status ?? null,
    receipt_recorded: Boolean(receipt),
    paths: { request: join(exchangeRoot, 'request.json'), result: result ? join(exchangeRoot, 'result.json') : null },
  };
  if (full) Object.assign(view, { request, result, adoption, receipt });
  return view;
}

export async function calculateCostReport(directory) {
  const paths = statePaths(directory);
  const entries = await readdir(paths.exchanges, { withFileTypes: true });
  const rounds = [];
  let previousRequest = null;
  for (const entry of entries.filter((item) => item.isDirectory() && /^\d{4,}$/.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const root = join(paths.exchanges, entry.name);
    const request = await optionalJson(join(root, 'request.json'));
    if (!request) continue;
    const result = await optionalJson(join(root, 'result.json'));
    const exchangeFiles = await readdir(root);
    const invalidResults = [];
    for (const filename of exchangeFiles.filter((name) => /^result-invalid-.*\.json$/.test(name))) {
      const invalid = await optionalJson(join(root, filename));
      if (invalid) invalidResults.push(invalid);
    }
    const historyTokenEstimate = typeof request.context_delta === 'object' ? request.context_delta.history_token_estimate ?? 0 : 0;
    const metrics = analyzePayload({ request, previousRequest, historyTokenEstimate });
    rounds.push({
      round: Number(entry.name),
      profile: request.profile,
      protocol: request.protocol ?? 'full-v2',
      request_tokens: metrics.request_tokens,
      response_tokens: result ? estimateTokens(result) : 0,
      wasted_response_tokens: invalidResults.reduce((sum, invalid) => sum + estimateTokens(invalid), 0),
      response_attempts: (result ? 1 : 0) + invalidResults.length,
      protocol_tokens: metrics.protocol_tokens,
      protocol_share: metrics.protocol_share,
      duplicate_tokens: metrics.duplicate_tokens,
      duplicate_rate: metrics.duplicate_rate,
      avoided_history_tokens: metrics.avoided_history_tokens,
      has_result: Boolean(result),
    });
    previousRequest = request;
  }
  return { estimator: 'local-heuristic-v1', rounds, totals: summarizeCosts(rounds) };
}

export async function healthReport(directory, currentTime = new Date().toISOString()) {
  const state = await loadState(directory);
  const checkpoint = await verifiedJson(state.checkpoint?.path, state.checkpoint?.sha256);
  const receipt = await verifiedJson(state.last_exchange?.receipt_path, state.last_exchange?.receipt_sha256);
  return buildHealthReport({
    state,
    checkpoint: checkpoint.value,
    checkpointIntegrity: checkpoint.integrity,
    receipt: receipt.value,
    receiptIntegrity: receipt.integrity,
    cost: await calculateCostReport(directory),
    now: currentTime,
  });
}

export async function prepareQuestionBatch(directory, inputPath = null) {
  const state = await loadState(directory);
  const input = inputPath ? JSON.parse(await readFile(resolve(inputPath), 'utf8')) : { questions: state.pending_questions ?? [] };
  return batchQuestions(input.questions ?? [], input.available_evidence ?? {});
}

export async function exportRecoveryBundle({ directory, outputPath, maxTokens = 2000 }) {
  if (!outputPath) throw new Error('recovery export requires --output');
  const state = await loadState(directory);
  if (state.in_flight) throw new Error('finish or abort the in-flight round before exporting recovery context');
  if (!state.checkpoint) throw new Error('a durable checkpoint is required before exporting recovery context');
  if (state.checkpoint.through_round !== state.last_completed_round) throw new Error('checkpoint is behind the latest completed round; refresh it before export');
  const checkpoint = await verifiedJson(state.checkpoint.path, state.checkpoint.sha256);
  if (!checkpoint.value || checkpoint.integrity !== true) throw new Error('checkpoint integrity check failed');
  const receipt = await verifiedJson(state.last_exchange?.receipt_path, state.last_exchange?.receipt_sha256);
  if (state.last_exchange?.receipt_path && receipt.integrity !== true) throw new Error('latest receipt integrity check failed');
  const created = createRecoveryBundle({ state, checkpoint: checkpoint.value, receipt: receipt.value, maxTokens });
  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(created.bundle, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return {
    action: 'recovery_context_exported',
    output_path: destination,
    through_round: created.bundle.through_round,
    approximate_tokens: created.approximate_tokens,
    max_tokens: created.max_tokens,
    bundle_sha256: created.bundle.bundle_sha256,
    next_action: 'select_replacement_chat_then_send_bundle_once',
    should_send: false,
  };
}

async function previousRequest(state) {
  if (!state.last_exchange?.request_path) return null;
  return optionalJson(state.last_exchange.request_path);
}

function sendBudget(value = 3000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error('max input tokens must be a positive number');
  return Math.min(3000, Math.floor(parsed));
}

async function checkpointInputHash(state) {
  if (!state.checkpoint) return null;
  const raw = await readFile(state.checkpoint.path);
  const actual = createHash('sha256').update(raw).digest('hex');
  if (actual !== state.checkpoint.sha256) throw new Error('checkpoint changed outside the bridge state; refresh it before starting a round');
  return actual;
}

export async function optimizeStoredRequest(requestPath, { outputPath = null, previous = null, maxInputTokens = 3000 } = {}) {
  const request = JSON.parse(await readFile(resolve(requestPath), 'utf8'));
  const optimized = optimizeRequest(request, { previousRequest: previous, maxInputTokens: sendBudget(maxInputTokens) });
  if (outputPath) {
    const destination = resolve(outputPath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `${JSON.stringify(optimized.request, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    optimized.output_path = destination;
  }
  return optimized;
}

export async function startRoundFromSpec({ directory, specPath, workspaceRoot = null }) {
  const state = await loadState(directory);
  if (state.status !== 'READY') throw new Error(`bridge must be READY, found ${state.status}`);
  if (state.chat.protocol?.status !== 'ready') throw new Error('compact protocol bootstrap is not acknowledged for this Chat');
  const spec = JSON.parse(await readFile(resolve(specPath), 'utf8'));
  const compactDelta = compactContextDelta(spec.context_delta);
  const currentWorkspace = await workspaceFingerprint(workspaceRoot ?? state.workspace.canonical_root, state.workspace.project_label ?? null);
  const checkpointSha256 = await checkpointInputHash(state);
  const prospective = buildCompactRequest({
    bridgeId: state.bridge_id,
    conversationScopeId: state.conversation_scope.id,
    round: state.current_round + 1,
    profile: spec.profile,
    objective: spec.objective,
    contextDelta: compactDelta,
    routing: spec.routing ?? null,
    workspace: spec.include_workspace === true ? { fingerprint_id: currentWorkspace.fingerprint_id, project_label: currentWorkspace.project_label ?? null } : null,
  });
  const optimized = optimizeRequest(prospective, { previousRequest: await previousRequest(state), maxInputTokens: sendBudget(spec.max_input_tokens ?? 3000) });
  const requestErrors = validateContextRequest(optimized.request);
  if (requestErrors.length) throw new Error(`invalid optimized request: ${requestErrors.join('; ')}`);
  if (optimized.metrics.budget_status === 'over_budget') throw new Error(`optimized request exceeds its approximate-token budget: ${optimized.after_tokens}`);
  const semanticKey = requestSemanticKey(optimized.request, { workspaceFingerprint: currentWorkspace.fingerprint_id, checkpointSha256 });
  const reuse = spec.allow_reuse === false ? null : reusableExchange({ ...state, workspace: currentWorkspace }, semanticKey);
  if (reuse) return { action: 'reuse_verified_result', ...reuse, saved_send_tokens: optimized.after_tokens, should_send: false };

  let started = null;
  try {
    started = await beginRound({ directory, profile: spec.profile, workspaceRoot: workspaceRoot ?? state.workspace.canonical_root });
    const request = { ...optimized.request, bridge_id: started.bridge_id, conversation_scope_id: started.conversation_scope_id, round: started.round };
    if (request.workspace) request.workspace = started.workspace;
    const requestPath = join(started.exchange_directory, 'request.json');
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    const prepared = await prepareRound({ directory, round: started.round, requestPath });
    return {
      action: 'send_prepared_request',
      round: started.round,
      profile: spec.profile,
      request_path: requestPath,
      idempotency_key: prepared.in_flight.idempotency_key,
      cost: prepared.in_flight.cost_estimate,
      optimizer: { before_tokens: optimized.before_tokens, after_tokens: optimized.after_tokens, saved_tokens: optimized.saved_tokens, suggestions: optimized.suggestions },
      next_action: 'capture_baseline_then_send_once',
      should_send: true,
    };
  } catch (error) {
    if (started) await abortRound({ directory, reason: `start command failed: ${error.message}` }).catch(() => {});
    throw error;
  }
}

export async function dryRunFromSpec({ directory, specPath, workspaceRoot = null }) {
  const spec = JSON.parse(await readFile(resolve(specPath), 'utf8'));
  return dryRunFromValue({ directory, spec, workspaceRoot });
}

export async function dryRunFromValue({ directory, spec, workspaceRoot = null }) {
  const state = await loadState(directory);
  if (state.status !== 'READY') throw new Error(`bridge must be READY, found ${state.status}`);
  if (state.chat.protocol?.status !== 'ready') throw new Error('compact protocol bootstrap is not acknowledged for this Chat');
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('dry-run spec must be an object');
  const compactDelta = compactContextDelta(spec.context_delta);
  const currentWorkspace = await workspaceFingerprint(workspaceRoot ?? state.workspace.canonical_root, state.workspace.project_label ?? null);
  const checkpointSha256 = await checkpointInputHash(state);
  const prospective = buildCompactRequest({
    bridgeId: state.bridge_id,
    conversationScopeId: state.conversation_scope.id,
    round: state.current_round + 1,
    profile: spec.profile,
    objective: spec.objective,
    contextDelta: compactDelta,
    routing: spec.routing ?? null,
    workspace: spec.include_workspace === true ? { fingerprint_id: currentWorkspace.fingerprint_id, project_label: currentWorkspace.project_label ?? null } : null,
  });
  const optimized = optimizeRequest(prospective, { previousRequest: await previousRequest(state), maxInputTokens: sendBudget(spec.max_input_tokens ?? 3000) });
  const requestErrors = validateContextRequest(optimized.request);
  if (requestErrors.length) throw new Error(`invalid optimized request: ${requestErrors.join('; ')}`);
  const semanticKey = requestSemanticKey(optimized.request, { workspaceFingerprint: currentWorkspace.fingerprint_id, checkpointSha256 });
  const reuse = spec.allow_reuse === false ? null : reusableExchange({ ...state, workspace: currentWorkspace }, semanticKey);
  const sourceTokens = Object.fromEntries(Object.entries(optimized.request.context_delta ?? {}).map(([name, value]) => [name, estimateTokens(value)]));
  return {
    action: 'dry_run',
    round: state.current_round + 1,
    profile: optimized.request.profile,
    before_tokens: optimized.before_tokens,
    after_tokens: optimized.after_tokens,
    saved_tokens: optimized.saved_tokens,
    budget_status: optimized.metrics.budget_status,
    source_tokens: sourceTokens,
    context_manifest: buildRequestContextManifest(optimized.request, { previousRequest: await previousRequest(state) }),
    reusable_round: reuse?.round ?? null,
    would_send: !reuse,
    state_mutated: false,
    preview: optimized.request,
  };
}

function receiptSummary(state, receipt) {
  if (!receipt) return null;
  const artifacts = (receipt.artifacts ?? receipt.changed_files ?? []).map((entry) => typeof entry === 'string' ? entry : { path: entry?.path ?? entry?.artifact_id ?? null, status: entry?.status ?? null });
  const checks = (receipt.checks ?? []).map((entry) => typeof entry === 'string' ? entry : { name: entry?.name ?? entry?.id ?? entry?.command ?? null, status: entry?.status ?? entry?.result ?? null });
  return { round: state.last_exchange?.round ?? null, implementation_summary: receipt.implementation_summary ?? null, accepted: receipt.accepted ?? [], rejected: receipt.rejected ?? [], deferred: receipt.deferred ?? [], artifacts, checks };
}

export async function prepareContextResponse({ directory, requestPath, outputPath, workspaceRoot = null, maxTokens = 2000 }) {
  if (!requestPath || !outputPath) throw new Error('provide-context requires --request and --output');
  const query = JSON.parse(await readFile(resolve(requestPath), 'utf8'));
  const prepared = await prepareContextResponseValue({ directory, query, workspaceRoot, maxTokens });
  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(prepared.response, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { ...prepared.summary, output_path: destination };
}

export async function prepareContextResponseValue({ directory, query, workspaceRoot = null, maxTokens = 2000 }) {
  const state = await loadState(directory);
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('context request must be an object');
  const expectedRound = state.in_flight?.round ?? state.current_round + 1;
  if (query.bridge_id !== state.bridge_id || query.round !== expectedRound) throw new Error('context request does not match the bridge and active/next round');
  if (query.conversation_scope_id !== state.conversation_scope.id) throw new Error('SCOPE_MISMATCH: context request does not match the bound Chat and workspace');
  const root = workspaceRoot ?? state.workspace.canonical_root;
  const currentWorkspace = await workspaceFingerprint(root, state.workspace.project_label ?? null);
  if (!compareWorkspaceFingerprints(state.workspace, currentWorkspace).same_workspace) throw new Error('workspace does not match the bound bridge');
  const receipt = await verifiedJson(state.last_exchange?.receipt_path, state.last_exchange?.receipt_sha256);
  if (state.last_exchange?.receipt_path && receipt.integrity !== true) throw new Error('latest receipt integrity check failed');
  const reader = await SecureContextReader.open(root);
  const prepared = await executeContextQuery({ query, reader, latestReceipt: receiptSummary(state, receipt.value), maxTokens });
  return {
    response: prepared.response,
    summary: { action: 'context_response_prepared', round: query.round, item_count: prepared.response.items.length, denied_count: prepared.response.items.filter((item) => item.status === 'denied').length, approximate_tokens: prepared.approximate_tokens, max_tokens: prepared.max_tokens, response_sha256: prepared.response.response_sha256, should_send: false, next_action: 'review_then_send_context_once' },
  };
}

async function resume(directory, workspace) {
  const state = await loadState(directory);
  if (state.in_flight?.phase === 'AWAITING_RESULT' && state.chat.transport === 'app-thread') {
    if (state.in_flight.delivery?.status === 'RECOVERY_REQUIRED') return resumeAppPolling({ directory, round: state.in_flight.round });
    return { status: state.status, round: state.in_flight.round, action: 'poll_bound_chat', should_resend: false };
  }
  if (['PAUSED', 'BLOCKED_BY_USER_ACTION'].includes(state.status)) return statusView(await resumeBridge({ directory, workspaceRoot: workspace ?? null }));
  if (state.status === 'READY') return {
    status: 'READY',
    action: state.chat.protocol?.status === 'ready' ? 'start_round' : 'bootstrap_chat_protocol',
    should_resend: false,
  };
  return { status: state.status, round: state.in_flight?.round ?? null, action: 'continue_current_phase', should_resend: false };
}

function human(command, value) {
  if (command === 'status') return [`Bridge: ${value.status}`, `Chat: ${value.chat.title ?? '(untitled)'} via ${value.chat.transport}`, `Round: ${value.round ?? 0}${value.phase ? ` (${value.phase})` : ''}`, `Next: ${value.next_action}`].join('\n');
  if (command === 'cost') return [`Estimated tokens: ${value.totals.total_tokens}`, `Request: ${value.totals.request_tokens}; accepted response: ${value.totals.response_tokens}; invalid response: ${value.totals.wasted_response_tokens}`, `Protocol share: ${(value.totals.protocol_share * 100).toFixed(1)}%`, `Avoided history: ${value.totals.avoided_history_tokens}`].join('\n');
  if (command === 'optimize') return [`Optimized request: ${value.before_tokens} -> ${value.after_tokens} tokens`, `Saved: ${value.saved_tokens} (${(value.saved_rate * 100).toFixed(1)}%)`, `Budget: ${value.metrics.budget_status}`, `Suggestions: ${value.suggestions.join(', ') || 'none'}${value.output_path ? `\nWritten: ${value.output_path}` : ''}`].join('\n');
  if (command === 'start') return value.action === 'reuse_verified_result'
    ? [`Reuse verified round: ${value.round}`, `Result: ${value.result_path}`, `Avoided send: ~${value.saved_send_tokens} tokens`].join('\n')
    : [`Prepared round: ${value.round} (${value.profile})`, `Request: ${value.request_path}`, `Estimated request: ${value.cost.request_tokens} tokens`, `Next: ${value.next_action}`].join('\n');
  if (command === 'health') return [
    `Bridge health: ${value.healthy ? 'healthy' : 'attention needed'} (${value.status})`,
    `Context: checkpoint round ${value.context.through_round ?? 'none'}, ${value.context.durable_entries} durable entries`,
    `Pending: ${value.context.pending_questions} questions, ${value.context.pending_artifacts} artifacts`,
    `Cost: ${value.cost?.total_tokens ?? 0} estimated tokens; ${value.cost?.avoided_history_tokens ?? 0} history tokens avoided`,
    `Warnings: ${value.warnings.map((warning) => warning.code).join(', ') || 'none'}`,
  ].join('\n');
  if (command === 'questions') return value.requires_user
    ? `${value.user_prompt}\n\nCodex will handle ${value.counts.codex_answer} answers and ${value.counts.codex_check} local checks. Removed ${value.counts.duplicates_removed} duplicate(s).`
    : `No user input needed. Codex can answer ${value.counts.codex_answer} and verify ${value.counts.codex_check} question(s). Removed ${value.counts.duplicates_removed} duplicate(s).`;
  if (command === 'recovery-export') return [`Recovery context written: ${value.output_path}`, `Through round: ${value.through_round}`, `Estimated size: ${value.approximate_tokens} tokens`, `Next: ${value.next_action}`].join('\n');
  if (command === 'dry-run') return [`Dry run: round ${value.round} (${value.profile})`, `Estimated request: ${value.after_tokens} tokens`, `Budget: ${value.budget_status}`, `Would send: ${value.would_send ? 'yes' : 'no (verified result reusable)'}`, `State changed: no`].join('\n');
  if (command === 'provide-context') return [`Context response written: ${value.output_path}`, `Items: ${value.item_count}; denied: ${value.denied_count}`, `Estimated size: ${value.approximate_tokens} tokens`, `Next: ${value.next_action}`].join('\n');
  return JSON.stringify(value, null, 2);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const directory = options.dir ?? DEFAULT_STATE_DIRECTORY;
  let result;
  if (command === 'status') result = statusView(await loadState(directory));
  else if (command === 'health') result = await healthReport(directory);
  else if (command === 'resume') result = await resume(directory, options.workspace);
  else if (command === 'inspect') result = await inspectRound(directory, options.round, options.full === 'true');
  else if (command === 'cost') result = await calculateCostReport(directory);
  else if (command === 'optimize') result = await optimizeStoredRequest(options.request, { outputPath: options.output ?? null, maxInputTokens: Number(options['max-input-tokens'] ?? 3000) });
  else if (command === 'questions') result = await prepareQuestionBatch(directory, options.input ?? null);
  else if (command === 'recovery-export') result = await exportRecoveryBundle({ directory, outputPath: options.output, maxTokens: Number(options['max-tokens'] ?? 2000) });
  else if (command === 'dry-run') result = await dryRunFromSpec({ directory, specPath: options.spec, workspaceRoot: options.workspace ?? null });
  else if (command === 'provide-context') result = await prepareContextResponse({ directory, requestPath: options.request, outputPath: options.output, workspaceRoot: options.workspace ?? null, maxTokens: Number(options['max-tokens'] ?? 2000) });
  else if (command === 'start') result = await startRoundFromSpec({ directory, specPath: options.spec, workspaceRoot: options.workspace ?? null });
  else throw new Error('usage: bridge.mjs <status|health|resume|inspect|cost|optimize|questions|recovery-export|dry-run|provide-context|start> [--dir <path>] [--round <n|current|last>] [--request <path>] [--input <path>] [--spec <path>] [--output <path>] [--json true]');
  console.log(options.json === 'true' ? JSON.stringify(result, null, 2) : human(command, result));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
