#!/usr/bin/env node

import { isDirectExecution } from './cli-entry.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { access, appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  validateAdoptionDecision,
  validateCheckpoint,
  validateContextRequest,
  validateContextResult,
  validateExecutionReceipt,
  validatePair,
} from './validate-context.mjs';
import { compareWorkspaceFingerprints, workspaceFingerprint } from './workspace-fingerprint.mjs';
import { createDelivery, inspectSnapshot, prepareRepair, resumeDelivery } from './app-transport.mjs';
import { analyzePayload, estimateTokens } from './token-budget.mjs';
import { requestSemanticKey } from './request-optimizer.mjs';
import { withBridgeLease } from './bridge-lease.mjs';
import { createConversationScope, normalizeChatReference, validateConversationScope, workspaceScopeFingerprint } from './scope-identity.mjs';
import { buildRequestContextManifest } from './context-manifest.mjs';

export const STATE_SCHEMA_VERSION = 3;
export const DEFAULT_STATE_DIRECTORY = '.codex/codex-bridge-chatgpt';
const TRANSPORTS = new Set(['app-thread', 'in-app-browser']);
const PROFILES = new Set(['plan', 'artifact', 'review', 'diagnosis', 'checkpoint']);
const ACTIVE_PHASES = new Set(['PREPARING', 'AWAITING_SEND', 'AWAITING_RESULT', 'VALIDATING', 'ADOPTING', 'EXECUTING', 'REPORTING', 'CHECKPOINTING']);
const ROOT_STATUSES = new Set(['READY', 'PAUSED', 'RECOVERY_REQUIRED', 'BLOCKED_BY_USER_ACTION', ...ACTIVE_PHASES]);
const CAPABILITIES = new Set(['persistent_chat_id', 'read', 'send', 'read_after_write', 'wait', 'structured_result_retrieval', 'attachment_acquisition', 'model_label_observation', 'user_takeover']);
const COMPACT_PROTOCOL = 'compact-v1';

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

export function statePaths(directory = DEFAULT_STATE_DIRECTORY) {
  const root = resolve(directory);
  return { root, state: join(root, 'state.json'), journal: join(root, 'journal.jsonl'), checkpoint: join(root, 'checkpoint.json'), exchanges: join(root, 'exchanges') };
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function now() { return new Date().toISOString(); }

function ensureCostState(state) {
  state.cost ??= {
    estimator: 'local-heuristic-v1',
    rounds: [],
    totals: { request_tokens: 0, response_tokens: 0, total_tokens: 0, protocol_tokens: 0, duplicate_tokens: 0, avoided_history_tokens: 0 },
  };
  return state.cost;
}

function finalizeRoundCost(state, outcome) {
  const estimate = state.in_flight?.cost_estimate;
  if (!estimate || state.in_flight.cost_finalized) return;
  ensureCostState(state).rounds.push({ round: state.in_flight.round, profile: state.in_flight.profile, outcome, ...estimate });
  state.in_flight.cost_finalized = true;
}

function validateStateShape(state) {
  return state?.schema_version === STATE_SCHEMA_VERSION
    && typeof state.bridge_id === 'string'
    && typeof state.chat?.ref === 'string'
    && TRANSPORTS.has(state.chat.transport)
    && ROOT_STATUSES.has(state.status)
    && Number.isInteger(state.current_round)
    && (state.state_revision === undefined || (Number.isInteger(state.state_revision) && state.state_revision >= 0))
    && (state.in_flight === null || ACTIVE_PHASES.has(state.in_flight?.phase))
    && validateConversationScope(state).length === 0;
}

export async function loadState(directory = DEFAULT_STATE_DIRECTORY) {
  const state = JSON.parse(await readFile(statePaths(directory).state, 'utf8'));
  if (!validateStateShape(state)) {
    if ([1, 2].includes(state?.schema_version)) throw new Error('legacy state requires migrate-state');
    const scopeErrors = state?.schema_version === STATE_SCHEMA_VERSION ? validateConversationScope(state) : [];
    throw new Error(scopeErrors.length ? `SCOPE_MISMATCH: ${scopeErrors.join('; ')}` : 'invalid persistent bridge state');
  }
  state.state_revision ??= 0;
  return state;
}

async function appendJournal(paths, event, state, details = {}) {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const record = { at: now(), event, ...details, state_snapshot: state };
  await appendFile(paths.journal, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function persist(paths, state, event, details = {}) {
  const expectedRevision = state.state_revision ?? 0;
  return withBridgeLease({ directory: paths.root, operation: event }, async () => {
    let current = null;
    try { current = JSON.parse(await readFile(paths.state, 'utf8')); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const currentRevision = current?.state_revision ?? 0;
    if (current && currentRevision !== expectedRevision) {
      throw new Error(`STATE_CONFLICT: expected revision ${expectedRevision}, found ${currentRevision}`);
    }
    if (current?.bridge_id && state.bridge_id && current.bridge_id !== state.bridge_id) throw new Error('STATE_CONFLICT: bridge identity changed');
    state.state_revision = expectedRevision + 1;
    state.updated_at = now();
    await appendJournal(paths, event, state, { ...details, state_revision: state.state_revision });
    await atomicJson(paths.state, state);
    return state;
  });
}

function defaultCapabilities(transport) {
  if (transport === 'app-thread') {
    return { persistent_chat_id: true, read: false, send: false, read_after_write: false, wait: false, structured_result_retrieval: false, attachment_acquisition: false, model_label_observation: false, user_takeover: false };
  }
  return { persistent_chat_id: false, read: false, send: false, read_after_write: false, wait: false, structured_result_retrieval: false, attachment_acquisition: false, model_label_observation: true, user_takeover: true };
}

function outboundWorkspace(workspace) {
  return { fingerprint_id: workspace.fingerprint_id, project_label: workspace.project_label ?? null };
}

export function requestIdempotencyKey(request) {
  const canonical = structuredClone(request);
  delete canonical.idempotency_key;
  const requestHash = sha256(JSON.stringify(canonical));
  return sha256(`${request.bridge_id}:${request.round}:${requestHash}`);
}

export async function initializeState({ directory, chatRef, chatTitle = null, transport, goal = 'Persistent Chat collaboration', workspaceRoot = process.cwd(), capabilities = null, accountEvidence = null }) {
  if (!chatRef?.trim()) throw new Error('chat reference must be non-empty');
  if (!TRANSPORTS.has(transport)) throw new Error('transport must be app-thread or in-app-browser');
  if (!goal?.trim()) throw new Error('goal must be non-empty');
  const paths = statePaths(directory);
  try { await access(paths.state); throw new Error('persistent bridge state already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(paths.exchanges, { recursive: true, mode: 0o700 });
  const created = now();
  const bridgeId = randomUUID();
  const workspace = await workspaceFingerprint(workspaceRoot);
  const normalizedChatRef = normalizeChatReference(chatRef);
  const state = {
    schema_version: STATE_SCHEMA_VERSION,
    state_revision: 0,
    bridge_id: bridgeId,
    goal: { name: goal, authorization_scope: goal },
    workspace,
    conversation_scope: createConversationScope({ bridgeId, chatRef: normalizedChatRef, workspaceFingerprintId: workspaceScopeFingerprint(workspace), boundAt: created }),
    chat: {
      ref: normalizedChatRef,
      title: chatTitle,
      transport,
      identity_status: 'verified',
      account_evidence: accountEvidence,
      capabilities: capabilities ?? defaultCapabilities(transport),
      first_successful_round: null,
      last_successful_round: null,
      history: [],
      protocol: { version: COMPACT_PROTOCOL, status: 'required', acknowledged_at: null, evidence: null },
    },
    status: 'READY',
    automatic_routing: true,
    current_round: 0,
    last_completed_round: 0,
    in_flight: null,
    checkpoint: null,
    last_exchange: null,
    pending_artifacts: [],
    pending_questions: [],
    cost: {
      estimator: 'local-heuristic-v1',
      rounds: [],
      totals: { request_tokens: 0, response_tokens: 0, total_tokens: 0, protocol_tokens: 0, duplicate_tokens: 0, avoided_history_tokens: 0 },
    },
    created_at: created,
    updated_at: created,
  };
  return persist(paths, state, 'initialized', { bridge_id: state.bridge_id, conversation_scope_id: state.conversation_scope.id, transport });
}

async function verifyBoundWorkspace(state, workspaceRoot) {
  const current = await workspaceFingerprint(workspaceRoot ?? state.workspace.canonical_root, state.workspace.project_label);
  const comparison = compareWorkspaceFingerprints(state.workspace, current);
  if (!comparison.same_workspace) return { ok: false, current, comparison };
  return { ok: true, current, comparison };
}

export async function beginRound({ directory, profile, mode, workspaceRoot = null }) {
  const selectedProfile = profile ?? ({ planning: 'plan', draft_files: 'artifact', review: 'review', reasoning: 'diagnosis', checkpoint: 'checkpoint' }[mode]);
  if (!PROFILES.has(selectedProfile)) throw new Error(`invalid response profile: ${selectedProfile}`);
  const paths = statePaths(directory);
  const state = await loadState(directory);
  if (state.status === 'PAUSED') throw new Error('bridge is paused');
  if (state.status !== 'READY') throw new Error(state.in_flight ? `round ${state.in_flight.round} is already in flight` : `bridge is ${state.status}`);
  const workspaceCheck = await verifyBoundWorkspace(state, workspaceRoot);
  if (!workspaceCheck.ok) {
    state.status = 'RECOVERY_REQUIRED';
    await persist(paths, state, 'workspace_mismatch', { changed: workspaceCheck.comparison.changed });
    throw new Error('workspace does not match the bound bridge');
  }
  state.workspace = workspaceCheck.current;
  const round = state.current_round + 1;
  const exchangeDirectory = join(paths.exchanges, String(round).padStart(4, '0'));
  state.current_round = round;
  state.status = 'PREPARING';
  state.in_flight = { round, profile: selectedProfile, phase: 'PREPARING', idempotency_key: null, started_at: now(), workspace_changes: workspaceCheck.comparison.changed };
  await persist(paths, state, 'round_started', { round, profile: selectedProfile });
  await mkdir(exchangeDirectory, { recursive: true, mode: 0o700 });
  return { bridge_id: state.bridge_id, conversation_scope_id: state.conversation_scope.id, round, profile: selectedProfile, exchange_directory: exchangeDirectory, workspace: outboundWorkspace(state.workspace) };
}

function assertRound(state, round, expectedPhase = null) {
  const parsedRound = Number(round);
  if (!Number.isInteger(parsedRound) || state.in_flight?.round !== parsedRound) throw new Error('the requested round is not in flight');
  if (expectedPhase && state.in_flight.phase !== expectedPhase) throw new Error(`round ${parsedRound} must be in ${expectedPhase}, found ${state.in_flight.phase}`);
  return parsedRound;
}

export async function prepareRound({ directory, round, requestPath }) {
  const paths = statePaths(directory);
  const state = await loadState(directory);
  const parsedRound = assertRound(state, round, 'PREPARING');
  let raw = await readFile(resolve(requestPath), 'utf8');
  const request = JSON.parse(raw);
  let requestChanged = false;
  let scopeInserted = false;
  if (!request.conversation_scope_id) {
    request.conversation_scope_id = state.conversation_scope.id;
    requestChanged = true;
    scopeInserted = true;
  }
  if (scopeInserted || !request.idempotency_key || request.idempotency_key === 'pending') {
    request.idempotency_key = requestIdempotencyKey(request);
    requestChanged = true;
  }
  if (requestChanged) {
    await atomicJson(resolve(requestPath), request);
    raw = `${JSON.stringify(request, null, 2)}\n`;
  }
  const errors = validateContextRequest(request);
  const expectedKey = requestIdempotencyKey(request);
  if (request.bridge_id !== state.bridge_id) errors.push('request bridge_id does not match persistent state');
  if (request.conversation_scope_id !== state.conversation_scope.id) errors.push('SCOPE_MISMATCH: request conversation_scope_id does not match persistent state');
  if (request.round !== parsedRound) errors.push('request round does not match in-flight state');
  if (request.profile !== state.in_flight.profile) errors.push('request profile does not match in-flight state');
  if (request.protocol === COMPACT_PROTOCOL && state.chat.protocol?.status !== 'ready') errors.push('compact protocol bootstrap is not acknowledged for this Chat');
  if (request.workspace && request.workspace.fingerprint_id !== state.workspace.fingerprint_id) errors.push('request workspace does not match current state');
  if (request.idempotency_key !== expectedKey) errors.push('request idempotency_key is invalid');
  if (errors.length) throw new Error(`invalid request: ${errors.join('; ')}`);
  let previousRequest = null;
  if (state.last_exchange?.request_path) {
    try { previousRequest = JSON.parse(await readFile(state.last_exchange.request_path, 'utf8')); } catch { /* cost comparison is optional */ }
  }
  const delta = request.context_delta && typeof request.context_delta === 'object' ? request.context_delta : null;
  const costEstimate = analyzePayload({ request, previousRequest, historyTokenEstimate: delta?.history_token_estimate ?? 0, maxInputTokens: 3000 });
  if (costEstimate.budget_status === 'over_budget') throw new Error(`request exceeds the 3000 approximate-token send budget: ${costEstimate.request_tokens}`);
  const semanticKey = requestSemanticKey(request, { workspaceFingerprint: state.workspace.fingerprint_id, checkpointSha256: state.checkpoint?.sha256 ?? null });
  const contextManifest = buildRequestContextManifest(request, { previousRequest });
  const manifestPath = join(dirname(resolve(requestPath)), 'context-manifest.json');
  await atomicJson(manifestPath, contextManifest);
  Object.assign(state.in_flight, {
    phase: 'AWAITING_SEND', idempotency_key: expectedKey, request_path: resolve(requestPath), request_sha256: sha256(raw),
    semantic_key: semanticKey, semantic_workspace_fingerprint: state.workspace.fingerprint_id,
    semantic_checkpoint_sha256: state.checkpoint?.sha256 ?? null, cost_estimate: costEstimate,
    context_manifest_path: manifestPath, context_manifest_sha256: sha256(`${JSON.stringify(contextManifest, null, 2)}\n`),
  });
  state.status = 'AWAITING_SEND';
  await persist(paths, state, 'request_prepared', { round: parsedRound, idempotency_key: expectedKey });
  return state;
}

export async function markRoundSent({ directory, round, baselinePath = null }) {
  const paths = statePaths(directory);
  const state = await loadState(directory);
  const parsedRound = assertRound(state, round, 'AWAITING_SEND');
  state.in_flight.phase = 'AWAITING_RESULT';
  state.in_flight.sent_at = now();
  if (state.chat.transport === 'app-thread') {
    let baselineTurnIds = [];
    if (baselinePath) {
      const baseline = JSON.parse(await readFile(resolve(baselinePath), 'utf8'));
      baselineTurnIds = (baseline.turns ?? []).map((turn) => turn?.id).filter(Boolean);
    }
    state.in_flight.delivery = createDelivery({ idempotencyKey: state.in_flight.idempotency_key, baselineTurnIds, queuedAt: state.in_flight.sent_at });
  }
  const costs = ensureCostState(state);
  const estimate = state.in_flight.cost_estimate;
  costs.totals.request_tokens += estimate?.request_tokens ?? 0;
  costs.totals.protocol_tokens += estimate?.protocol_tokens ?? 0;
  costs.totals.duplicate_tokens += estimate?.duplicate_tokens ?? 0;
  costs.totals.avoided_history_tokens += estimate?.avoided_history_tokens ?? 0;
  costs.totals.total_tokens = costs.totals.request_tokens + costs.totals.response_tokens;
  state.status = 'AWAITING_RESULT';
  return persist(paths, state, 'request_sent', { round: parsedRound, idempotency_key: state.in_flight.idempotency_key });
}

export async function recordAppSnapshot({ directory, round, snapshotPath, observedAt = null }) {
  const paths = statePaths(directory);
  const state = await loadState(directory);
  const parsedRound = assertRound(state, round, 'AWAITING_RESULT');
  if (state.chat.transport !== 'app-thread') throw new Error('app snapshots require app-thread transport');
  if (!state.in_flight.delivery) throw new Error('app delivery state is missing; mark the round sent first');
  const snapshot = JSON.parse(await readFile(resolve(snapshotPath), 'utf8'));
  const decision = inspectSnapshot(state.in_flight.delivery, snapshot, observedAt ?? now());
  state.in_flight.delivery = decision.delivery;
  state.status = decision.delivery.status === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED' : 'AWAITING_RESULT';
  await persist(paths, state, 'app_snapshot_observed', { round: parsedRound, delivery_status: decision.delivery.status, action: decision.action });
  return decision;
}

export async function resumeAppPolling({ directory, round }) {
  const paths = statePaths(directory);
  const state = await loadState(directory);
  const parsedRound = assertRound(state, round, 'AWAITING_RESULT');
  if (state.chat.transport !== 'app-thread' || !state.in_flight.delivery) throw new Error('no app delivery is available to resume');
  const decision = resumeDelivery(state.in_flight.delivery);
  state.in_flight.delivery = decision.delivery;
  state.status = 'AWAITING_RESULT';
  await persist(paths, state, 'app_polling_resumed', { round: parsedRound });
  return decision;
}

export async function beginAppRepair({ directory, round }) {
  const paths = statePaths(directory);
  const state = await loadState(directory);
  const parsedRound = assertRound(state, round, 'AWAITING_RESULT');
  if (state.chat.transport !== 'app-thread' || !state.in_flight.delivery) throw new Error('no app delivery is available to repair');
  state.in_flight.delivery = prepareRepair(state.in_flight.delivery, now());
  state.status = 'AWAITING_RESULT';
  await persist(paths, state, 'app_result_repair_started', { round: parsedRound, repair_count: state.in_flight.delivery.repair_count });
  return { delivery: state.in_flight.delivery, action: 'poll_read', should_resend: false };
}

export async function recordRoundResult({ directory, round, resultPath }) {
  const paths = statePaths(directory);
  const state = await loadState(directory);
  const parsedRound = assertRound(state, round, 'AWAITING_RESULT');
  const request = JSON.parse(await readFile(state.in_flight.request_path, 'utf8'));
  const raw = await readFile(resolve(resultPath), 'utf8');
  const result = JSON.parse(raw);
  const errors = validatePair(request, result);
  if (errors.length) throw new Error(`invalid result: ${errors.join('; ')}`);
  const responseTokens = estimateTokens(result);
  state.in_flight.cost_estimate ??= {};
  state.in_flight.cost_estimate.response_tokens = responseTokens;
  state.in_flight.cost_estimate.total_tokens = (state.in_flight.cost_estimate.request_tokens ?? 0) + responseTokens;
  const costs = ensureCostState(state);
  costs.totals.response_tokens += responseTokens;
  costs.totals.total_tokens = costs.totals.request_tokens + costs.totals.response_tokens;
  Object.assign(state.in_flight, { phase: 'VALIDATING', result_path: resolve(resultPath), result_sha256: sha256(raw), result_received_at: now() });
  state.status = 'VALIDATING';
  return persist(paths, state, 'result_recorded', { round: parsedRound });
}

export async function recordAdoption({ directory, round, adoptionPath }) {
  const paths = statePaths(directory);
  const state = await loadState(directory);
  const parsedRound = assertRound(state, round, 'VALIDATING');
  const raw = await readFile(resolve(adoptionPath), 'utf8');
  const adoption = JSON.parse(raw);
  const errors = validateAdoptionDecision(adoption);
  if (adoption.bridge_id !== state.bridge_id || adoption.round !== parsedRound || adoption.idempotency_key !== state.in_flight.idempotency_key) errors.push('adoption identity does not match the in-flight round');
  if (errors.length) throw new Error(`invalid adoption: ${errors.join('; ')}`);
  state.in_flight.phase = 'ADOPTING';
  state.status = 'ADOPTING';
  await persist(paths, state, 'adoption_started', { round: parsedRound, status: adoption.status });
  Object.assign(state.in_flight, { phase: 'EXECUTING', adoption_path: resolve(adoptionPath), adoption_sha256: sha256(raw), adoption_status: adoption.status });
  state.status = 'EXECUTING';
  return persist(paths, state, 'adoption_recorded', { round: parsedRound, status: adoption.status });
}

export async function recordExecutionReceipt({ directory, round, receiptPath }) {
  const paths = statePaths(directory);
  const state = await loadState(directory);
  const parsedRound = assertRound(state, round, 'EXECUTING');
  const raw = await readFile(resolve(receiptPath), 'utf8');
  const receipt = JSON.parse(raw);
  const errors = validateExecutionReceipt(receipt);
  if (receipt.bridge_id !== state.bridge_id || receipt.round !== parsedRound || receipt.idempotency_key !== state.in_flight.idempotency_key) errors.push('receipt identity does not match the in-flight round');
  if (errors.length) throw new Error(`invalid receipt: ${errors.join('; ')}`);
  Object.assign(state.in_flight, { phase: 'REPORTING', receipt_path: resolve(receiptPath), receipt_sha256: sha256(raw), receipt_recorded_at: now() });
  state.pending_questions = receipt.open_questions;
  state.pending_artifacts = receipt.artifacts.filter((artifact) => artifact?.status === 'pending');
  state.status = 'REPORTING';
  await persist(paths, state, 'receipt_recorded', { round: parsedRound });
  return state;
}

export async function completeRound({ directory, round, checkpointPath = null }) {
  const paths = statePaths(directory);
  const state = await loadState(directory);
  const parsedRound = assertRound(state, round, 'REPORTING');
  let checkpointRecord = null;
  if (checkpointPath) {
    const raw = await readFile(resolve(checkpointPath), 'utf8');
    const checkpoint = JSON.parse(raw);
    const errors = validateCheckpoint(checkpoint);
    if (checkpoint.schema_version !== 2) errors.push('completed v2 rounds require a v2 checkpoint');
    if (checkpoint.bridge_id !== state.bridge_id || checkpoint.through_round !== parsedRound) errors.push('checkpoint identity does not match the completed round');
    if (errors.length) throw new Error(`invalid checkpoint: ${errors.join('; ')}`);
    checkpointRecord = { path: resolve(checkpointPath), sha256: sha256(raw), through_round: parsedRound, updated_at: now() };
  }
  state.in_flight.phase = 'CHECKPOINTING';
  state.status = 'CHECKPOINTING';
  if (checkpointRecord) state.checkpoint = checkpointRecord;
  await persist(paths, state, 'checkpointing_started', { round: parsedRound });
  const completed = {
    round: parsedRound,
    conversation_scope_id: state.conversation_scope.id,
    profile: state.in_flight.profile,
    idempotency_key: state.in_flight.idempotency_key,
    outcome: 'COMPLETED',
    request_path: state.in_flight.request_path,
    request_sha256: state.in_flight.request_sha256,
    result_path: state.in_flight.result_path,
    result_sha256: state.in_flight.result_sha256,
    adoption_path: state.in_flight.adoption_path,
    adoption_sha256: state.in_flight.adoption_sha256,
    receipt_path: state.in_flight.receipt_path,
    receipt_sha256: state.in_flight.receipt_sha256,
    checkpoint_sha256: state.checkpoint?.through_round === parsedRound ? state.checkpoint.sha256 : null,
    semantic_key: state.in_flight.semantic_key,
    workspace_fingerprint: state.in_flight.semantic_workspace_fingerprint,
    semantic_checkpoint_sha256: state.in_flight.semantic_checkpoint_sha256,
    completed_at: now(),
  };
  state.last_completed_round = parsedRound;
  finalizeRoundCost(state, 'COMPLETED');
  state.last_exchange = completed;
  state.chat.first_successful_round ??= parsedRound;
  state.chat.last_successful_round = parsedRound;
  state.in_flight = null;
  state.status = 'READY';
  return persist(paths, state, 'round_completed', { round: parsedRound, exchange: completed });
}

async function terminateRound({ directory, reason, outcome }) {
  if (!reason?.trim()) throw new Error(`${outcome.toLowerCase()} reason must be non-empty`);
  const paths = statePaths(directory);
  const state = await loadState(directory);
  if (!state.in_flight) throw new Error('no round is in flight');
  const round = state.in_flight.round;
  finalizeRoundCost(state, outcome);
  state.last_exchange = { round, conversation_scope_id: state.conversation_scope.id, profile: state.in_flight.profile, idempotency_key: state.in_flight.idempotency_key, outcome, reason, completed_at: now() };
  state.in_flight = null;
  state.status = 'READY';
  return persist(paths, state, outcome === 'ABORTED' ? 'round_aborted' : 'round_superseded', { round, reason });
}

export function abortRound(options) { return terminateRound({ ...options, outcome: 'ABORTED' }); }
export function supersedeRound(options) { return terminateRound({ ...options, outcome: 'SUPERSEDED' }); }

export async function invalidateCompletedRound({ directory, round, expectedRevision, priorCheckpointPath, priorCheckpointSha256, reason }) {
  if (!reason?.trim()) throw new Error('invalidation requires a reason');
  const paths = statePaths(directory);
  const state = await loadState(directory);
  const parsedRound = Number(round);
  if (!Number.isInteger(expectedRevision) || state.state_revision !== expectedRevision) throw new Error('STATE_CONFLICT: state changed since the invalidation review');
  if (!Number.isInteger(parsedRound) || state.status !== 'READY' || state.in_flight || state.current_round !== parsedRound || state.last_completed_round !== parsedRound || state.last_exchange?.round !== parsedRound || state.last_exchange?.outcome !== 'COMPLETED') {
    throw new Error('STATE_CONFLICT: only the latest completed round can be invalidated');
  }
  const candidate = resolve(priorCheckpointPath ?? '');
  const within = relative(paths.root, candidate);
  if (!within || within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(within)) throw new Error('prior checkpoint must be inside the bridge runtime');
  if (!/^[a-f0-9]{64}$/.test(priorCheckpointSha256 ?? '')) throw new Error('prior checkpoint SHA-256 is required');
  const currentRaw = await readFile(state.checkpoint?.path ?? '', 'utf8');
  if (state.checkpoint?.through_round !== parsedRound || sha256(currentRaw) !== state.checkpoint.sha256) throw new Error('STATE_CONFLICT: latest checkpoint integrity changed');
  const priorRaw = await readFile(candidate, 'utf8');
  if (sha256(priorRaw) !== priorCheckpointSha256) throw new Error('STATE_CONFLICT: prior checkpoint integrity changed');
  const prior = JSON.parse(priorRaw);
  const errors = validateCheckpoint(prior);
  if (prior.schema_version !== 2 || prior.bridge_id !== state.bridge_id || prior.through_round >= parsedRound || errors.length) throw new Error(`invalid prior checkpoint: ${errors.join('; ') || 'bridge or round mismatch'}`);
  const invalidatedAt = now();
  state.invalidated_exchanges ??= [];
  state.invalidated_exchanges.push({ round: parsedRound, reason, invalidated_at: invalidatedAt, original_result_sha256: state.last_exchange.result_sha256, original_checkpoint_sha256: state.checkpoint.sha256 });
  const costRound = state.cost?.rounds?.find((entry) => entry.round === parsedRound && entry.outcome === 'COMPLETED');
  if (costRound) costRound.outcome = 'INVALIDATED';
  state.last_exchange = { round: parsedRound, conversation_scope_id: state.conversation_scope.id, profile: state.last_exchange.profile, idempotency_key: state.last_exchange.idempotency_key, outcome: 'ABORTED', reason, completed_at: invalidatedAt };
  state.last_completed_round = prior.through_round;
  state.chat.last_successful_round = prior.through_round || null;
  state.checkpoint = { path: candidate, sha256: priorCheckpointSha256, through_round: prior.through_round, updated_at: invalidatedAt };
  state.pending_questions = [];
  state.pending_artifacts = [];
  state.status = 'PAUSED';
  state.automatic_routing = false;
  return persist(paths, state, 'completed_round_invalidated', { round: parsedRound, reason, prior_checkpoint_sha256: priorCheckpointSha256 });
}

export async function steerRound({ directory, instruction, compatibility }) {
  if (!instruction?.trim()) throw new Error('steering instruction must be non-empty');
  if (!['compatible', 'incompatible'].includes(compatibility)) throw new Error('compatibility must be compatible or incompatible');
  if (compatibility === 'incompatible') return supersedeRound({ directory, reason: instruction });
  const paths = statePaths(directory);
  const state = await loadState(directory);
  if (!state.in_flight) throw new Error('no round is in flight');
  state.in_flight.queued_deltas ??= [];
  state.in_flight.queued_deltas.push({ instruction, received_at: now() });
  return persist(paths, state, 'steering_queued', { round: state.in_flight.round, instruction });
}

export async function pauseBridge({ directory, reason = 'paused by user' }) {
  const paths = statePaths(directory);
  const state = await loadState(directory);
  if (state.in_flight) throw new Error('finish, abort, or supersede the in-flight round before pausing');
  state.status = 'PAUSED';
  state.automatic_routing = false;
  return persist(paths, state, 'bridge_paused', { reason });
}

export async function blockForUserAction({ directory, reason, action }) {
  if (!reason?.trim() || !action?.trim()) throw new Error('blocking requires a reason and user action');
  const paths = statePaths(directory);
  const state = await loadState(directory);
  if (state.in_flight) throw new Error('abort or supersede the in-flight round before blocking');
  state.status = 'BLOCKED_BY_USER_ACTION';
  state.blocker = { reason, action, blocked_at: now() };
  return persist(paths, state, 'blocked_by_user_action', state.blocker);
}

export async function resumeBridge({ directory, workspaceRoot = null }) {
  const paths = statePaths(directory);
  const state = await loadState(directory);
  if (!['PAUSED', 'BLOCKED_BY_USER_ACTION'].includes(state.status)) throw new Error('bridge is not paused or blocked by user action');
  if (state.chat.identity_status === 'unbound') throw new Error('cannot resume an unbound bridge');
  const workspaceCheck = await verifyBoundWorkspace(state, workspaceRoot);
  if (!workspaceCheck.ok) {
    state.status = 'RECOVERY_REQUIRED';
    await persist(paths, state, 'workspace_mismatch', { changed: workspaceCheck.comparison.changed });
    throw new Error('workspace does not match the bound bridge');
  }
  state.workspace = workspaceCheck.current;
  state.status = 'READY';
  state.automatic_routing = true;
  delete state.blocker;
  return persist(paths, state, 'bridge_resumed');
}

export async function switchTransport({ directory, transport, reason }) {
  if (!TRANSPORTS.has(transport)) throw new Error('transport must be app-thread or in-app-browser');
  if (!reason?.trim()) throw new Error('transport switch requires a reason');
  const paths = statePaths(directory);
  const state = await loadState(directory);
  if (state.in_flight) throw new Error('cannot switch transport while a round is in flight');
  if (state.chat.transport === transport) return state;
  state.chat.transport_history ??= [];
  state.chat.transport_history.push({ transport: state.chat.transport, capabilities: state.chat.capabilities, replaced_at: now(), reason });
  state.chat.transport = transport;
  state.chat.capabilities = defaultCapabilities(transport);
  state.chat.capability_observations = [];
  return persist(paths, state, 'transport_switched', { transport, reason });
}

export async function unbindChat({ directory, reason = 'unbound by user' }) {
  const paths = statePaths(directory);
  const state = await loadState(directory);
  if (state.in_flight) throw new Error('cannot unbind while a round is in flight');
  state.chat.identity_status = 'unbound';
  state.status = 'PAUSED';
  state.automatic_routing = false;
  return persist(paths, state, 'chat_unbound', { reason });
}

export async function recordTransportObservation({ directory, capability, available, evidence }) {
  if (!CAPABILITIES.has(capability)) throw new Error('unknown transport capability');
  if (typeof available !== 'boolean') throw new Error('available must be boolean');
  if (!evidence?.trim()) throw new Error('transport observation requires evidence');
  const paths = statePaths(directory);
  const state = await loadState(directory);
  state.chat.capabilities[capability] = available;
  state.chat.capability_observations ??= [];
  state.chat.capability_observations.push({ capability, available, evidence, observed_at: now() });
  return persist(paths, state, 'transport_capability_observed', { capability, available, evidence });
}

export async function recordProtocolBootstrap({ directory, protocol, evidence }) {
  if (protocol !== COMPACT_PROTOCOL) throw new Error(`protocol must be ${COMPACT_PROTOCOL}`);
  if (!evidence?.trim()) throw new Error('protocol bootstrap requires acknowledgement evidence');
  const paths = statePaths(directory);
  const state = await loadState(directory);
  if (state.in_flight) throw new Error('record protocol bootstrap before beginning a round');
  state.chat.protocol = { version: protocol, status: 'ready', acknowledged_at: now(), evidence };
  return persist(paths, state, 'protocol_bootstrap_acknowledged', { protocol, evidence });
}

export async function previewChatMigration({ directory, chatRef, chatTitle = null, transport, reason, outputPath = null, ttlMs = 30 * 60 * 1000 }) {
  if (!chatRef?.trim() || !reason?.trim()) throw new Error('migration preview requires chat reference and reason');
  if (!TRANSPORTS.has(transport)) throw new Error('transport must be app-thread or in-app-browser');
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60 * 1000) throw new Error('migration preview ttl must be between one minute and 24 hours');
  const paths = statePaths(directory);
  const state = await loadState(directory);
  if (state.in_flight) throw new Error('cannot preview migration while a round is in flight');
  if (!state.checkpoint) throw new Error('cannot preview migration without a durable checkpoint');
  const normalizedChatRef = normalizeChatReference(chatRef);
  const createdAt = now();
  const preview = {
    schema_version: 1,
    kind: 'chat_migration_preview',
    preview_id: randomUUID(),
    bridge_id: state.bridge_id,
    expected_state_revision: state.state_revision,
    source_conversation_scope_id: state.conversation_scope.id,
    workspace_fingerprint_id: state.workspace.fingerprint_id,
    checkpoint_sha256: state.checkpoint.sha256,
    target: {
      chat_ref: normalizedChatRef,
      chat_ref_sha256: sha256(normalizedChatRef),
      title: chatTitle,
      transport,
    },
    reason,
    created_at: createdAt,
    expires_at: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
  };
  preview.preview_sha256 = sha256(JSON.stringify(preview));
  const destination = outputPath ? resolve(outputPath) : join(paths.root, 'previews', `chat-migration.${preview.preview_id}.json`);
  await atomicJson(destination, preview);
  return { action: 'review_chat_migration', preview_path: destination, preview };
}

export async function applyChatMigration({ directory, previewPath }) {
  if (!previewPath) throw new Error('chat migration apply requires a preview path');
  const preview = JSON.parse(await readFile(resolve(previewPath), 'utf8'));
  const suppliedHash = preview.preview_sha256;
  const unsigned = structuredClone(preview);
  delete unsigned.preview_sha256;
  if (preview.schema_version !== 1 || preview.kind !== 'chat_migration_preview' || !suppliedHash || sha256(JSON.stringify(unsigned)) !== suppliedHash) {
    throw new Error('MIGRATION_REQUIRED: chat migration preview is invalid or changed');
  }
  if (!Number.isFinite(Date.parse(preview.expires_at)) || Date.parse(preview.expires_at) < Date.now()) throw new Error('MIGRATION_REQUIRED: chat migration preview expired');
  return migrateChat({
    directory,
    chatRef: preview.target?.chat_ref,
    chatTitle: preview.target?.title ?? null,
    transport: preview.target?.transport,
    reason: preview.reason,
    expectedStateRevision: preview.expected_state_revision,
    expectedScopeId: preview.source_conversation_scope_id,
    expectedBridgeId: preview.bridge_id,
    expectedWorkspaceFingerprintId: preview.workspace_fingerprint_id,
    expectedCheckpointSha256: preview.checkpoint_sha256,
    previewSha256: suppliedHash,
  });
}

export async function migrateChat({ directory, chatRef, chatTitle = null, transport, reason, capabilities = null, accountEvidence = null, expectedStateRevision = null, expectedScopeId = null, expectedBridgeId = null, expectedWorkspaceFingerprintId = null, expectedCheckpointSha256 = null, previewSha256 = null }) {
  if (!chatRef?.trim() || !reason?.trim()) throw new Error('migration requires chat reference and reason');
  if (!TRANSPORTS.has(transport)) throw new Error('transport must be app-thread or in-app-browser');
  const paths = statePaths(directory);
  const state = await loadState(directory);
  if (state.in_flight) throw new Error('cannot migrate while a round is in flight');
  if (!state.checkpoint) throw new Error('cannot migrate without a durable checkpoint');
  if (expectedStateRevision !== null && state.state_revision !== expectedStateRevision) throw new Error(`STATE_CONFLICT: migration preview expected revision ${expectedStateRevision}, found ${state.state_revision}`);
  if (expectedScopeId !== null && state.conversation_scope.id !== expectedScopeId) throw new Error('SCOPE_MISMATCH: source Chat changed after migration preview');
  if (expectedBridgeId !== null && state.bridge_id !== expectedBridgeId) throw new Error('SCOPE_MISMATCH: bridge changed after migration preview');
  if (expectedWorkspaceFingerprintId !== null && state.workspace.fingerprint_id !== expectedWorkspaceFingerprintId) throw new Error('SCOPE_MISMATCH: workspace changed after migration preview');
  if (expectedCheckpointSha256 !== null && state.checkpoint.sha256 !== expectedCheckpointSha256) throw new Error('STATE_CONFLICT: checkpoint changed after migration preview');
  const normalizedChatRef = normalizeChatReference(chatRef);
  const previous = { ...state.chat, history: undefined, conversation_scope_id: state.conversation_scope.id, replaced_at: now(), reason };
  state.chat = {
    ref: normalizedChatRef, title: chatTitle, transport, identity_status: 'verified', account_evidence: accountEvidence,
    capabilities: capabilities ?? defaultCapabilities(transport), first_successful_round: null, last_successful_round: null,
    history: [...state.chat.history, previous],
    protocol: { version: COMPACT_PROTOCOL, status: 'required', acknowledged_at: null, evidence: null },
  };
  state.conversation_scope = createConversationScope({ bridgeId: state.bridge_id, chatRef: normalizedChatRef, workspaceFingerprintId: workspaceScopeFingerprint(state.workspace) });
  state.status = 'READY';
  state.automatic_routing = true;
  return persist(paths, state, 'chat_migrated', { conversation_scope_id: state.conversation_scope.id, transport, reason, preview_sha256: previewSha256 });
}

export async function migrateState({ directory, workspaceRoot = process.cwd() }) {
  const paths = statePaths(directory);
  return withBridgeLease({ directory: paths.root, operation: 'state_migration' }, async () => {
    const raw = await readFile(paths.state, 'utf8');
    let legacy;
    try { legacy = JSON.parse(raw); } catch { throw new Error('MIGRATION_REQUIRED: state preflight failed because state.json is not valid JSON'); }
    if (legacy.schema_version === STATE_SCHEMA_VERSION) {
      if (!validateStateShape(legacy)) throw new Error('MIGRATION_REQUIRED: current state failed integrity validation');
      return legacy;
    }
    if (![1, 2].includes(legacy.schema_version) || !legacy.bridge_id || !legacy.chat?.ref) throw new Error('MIGRATION_REQUIRED: state is not a recognized v1 or v2 bridge');

    let state;
    if (legacy.schema_version === 1) {
      const workspace = await workspaceFingerprint(workspaceRoot);
      state = {
        ...legacy,
        goal: { name: 'Migrated persistent Chat collaboration', authorization_scope: 'Migrated persistent Chat collaboration' },
        workspace,
        chat: {
          ref: normalizeChatReference(legacy.chat.ref), title: legacy.chat.title ?? null, transport: legacy.chat.transport,
          identity_status: 'verified', account_evidence: null, capabilities: defaultCapabilities(legacy.chat.transport),
          first_successful_round: legacy.last_completed_round || null, last_successful_round: legacy.last_completed_round || null,
          history: legacy.chat.history ?? [],
          protocol: { version: COMPACT_PROTOCOL, status: 'required', acknowledged_at: null, evidence: null },
        },
        status: legacy.in_flight ? 'RECOVERY_REQUIRED' : 'READY',
        automatic_routing: !legacy.in_flight,
        in_flight: null,
        pending_artifacts: [], pending_questions: [],
        cost: {
          estimator: 'local-heuristic-v1', rounds: [],
          totals: { request_tokens: 0, response_tokens: 0, total_tokens: 0, protocol_tokens: 0, duplicate_tokens: 0, avoided_history_tokens: 0 },
        },
      };
    } else {
      state = structuredClone(legacy);
      state.chat.ref = normalizeChatReference(state.chat.ref);
    }

    const migratedAt = now();
    state.schema_version = STATE_SCHEMA_VERSION;
    state.state_revision = (legacy.state_revision ?? 0) + 1;
    state.conversation_scope = createConversationScope({
      bridgeId: state.bridge_id,
      chatRef: state.chat.ref,
      workspaceFingerprintId: workspaceScopeFingerprint(state.workspace),
      boundAt: migratedAt,
    });
    const priorHistory = Array.isArray(legacy.migration?.history) ? legacy.migration.history : [];
    const backupSha256 = sha256(raw);
    const backupName = `state.schema-${legacy.schema_version}.${backupSha256.slice(0, 12)}.json`;
    state.migration = {
      current_schema: STATE_SCHEMA_VERSION,
      history: [...priorHistory, {
        from_schema: legacy.schema_version,
        to_schema: STATE_SCHEMA_VERSION,
        migrated_at: migratedAt,
        source_sha256: backupSha256,
        backup: `backups/${backupName}`,
        abandoned_in_flight_round: legacy.in_flight?.round ?? null,
      }],
    };
    state.updated_at = migratedAt;
    if (!validateStateShape(state)) throw new Error('MIGRATION_REQUIRED: migrated state failed integrity validation');

    const backupDirectory = join(paths.root, 'backups');
    const backupPath = join(backupDirectory, backupName);
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    try { await writeFile(backupPath, raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const savedBackup = await readFile(backupPath, 'utf8');
    if (sha256(savedBackup) !== backupSha256) throw new Error('MIGRATION_REQUIRED: state backup integrity check failed');

    await appendJournal(paths, 'state_migrated', state, {
      from_schema: legacy.schema_version,
      to_schema: STATE_SCHEMA_VERSION,
      backup: `backups/${backupName}`,
      source_sha256: backupSha256,
      state_revision: state.state_revision,
    });
    await atomicJson(paths.state, state);
    const published = JSON.parse(await readFile(paths.state, 'utf8'));
    if (!validateStateShape(published)) throw new Error('MIGRATION_REQUIRED: published state failed integrity validation');
    return published;
  });
}

export async function recoverState({ directory }) {
  const paths = statePaths(directory);
  return withBridgeLease({ directory: paths.root, operation: 'state_recovery' }, async () => {
    const lines = (await readFile(paths.journal, 'utf8')).split(/\r?\n/).filter(Boolean);
    let selected = null;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const record = JSON.parse(lines[index]);
        if (validateStateShape(record.state_snapshot)) { selected = record; break; }
      } catch { /* try the previous immutable record */ }
    }
    if (!selected) throw new Error('no valid state snapshot exists in the journal');
    const recovered = structuredClone(selected.state_snapshot);
    if (recovered.in_flight) {
      recovered.last_exchange = { round: recovered.in_flight.round, conversation_scope_id: recovered.conversation_scope.id, profile: recovered.in_flight.profile, idempotency_key: recovered.in_flight.idempotency_key, outcome: 'ABORTED', reason: 'state recovered from journal', completed_at: now() };
      recovered.in_flight = null;
    }
    recovered.state_revision = (recovered.state_revision ?? 0) + 1;
    recovered.status = recovered.chat.identity_status === 'unbound' ? 'PAUSED' : 'READY';
    await appendJournal(paths, 'state_recovered', recovered, { source_event: selected.event, state_revision: recovered.state_revision });
    await atomicJson(paths.state, recovered);
    return recovered;
  });
}

async function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    const directory = options.dir ?? DEFAULT_STATE_DIRECTORY;
    let result;
    if (command === 'init') result = await initializeState({ directory, chatRef: options['chat-ref'], chatTitle: options['chat-title'] ?? null, transport: options.transport, goal: options.goal ?? 'Persistent Chat collaboration', workspaceRoot: options.workspace ?? process.cwd() });
    else if (command === 'status') result = await loadState(directory);
    else if (command === 'begin') result = await beginRound({ directory, profile: options.profile, mode: options.mode, workspaceRoot: options.workspace ?? null });
    else if (command === 'prepare') result = await prepareRound({ directory, round: options.round, requestPath: options.request });
    else if (command === 'sent') result = await markRoundSent({ directory, round: options.round, baselinePath: options.baseline ?? null });
    else if (command === 'app-observe') result = await recordAppSnapshot({ directory, round: options.round, snapshotPath: options.snapshot, observedAt: options['observed-at'] ?? null });
    else if (command === 'app-resume') result = await resumeAppPolling({ directory, round: options.round });
    else if (command === 'app-repair') result = await beginAppRepair({ directory, round: options.round });
    else if (command === 'result') result = await recordRoundResult({ directory, round: options.round, resultPath: options.result });
    else if (command === 'adopt') result = await recordAdoption({ directory, round: options.round, adoptionPath: options.adoption });
    else if (command === 'receipt') result = await recordExecutionReceipt({ directory, round: options.round, receiptPath: options.receipt });
    else if (command === 'complete') result = await completeRound({ directory, round: options.round, checkpointPath: options.checkpoint ?? null });
    else if (command === 'abort') result = await abortRound({ directory, reason: options.reason });
    else if (command === 'invalidate-completed') result = await invalidateCompletedRound({ directory, round: options.round, expectedRevision: Number(options.revision), priorCheckpointPath: options['prior-checkpoint'], priorCheckpointSha256: options['prior-sha256'], reason: options.reason });
    else if (command === 'supersede') result = await supersedeRound({ directory, reason: options.reason });
    else if (command === 'steer') result = await steerRound({ directory, instruction: options.instruction, compatibility: options.compatibility });
    else if (command === 'pause') result = await pauseBridge({ directory, reason: options.reason });
    else if (command === 'block') result = await blockForUserAction({ directory, reason: options.reason, action: options.action });
    else if (command === 'resume') result = await resumeBridge({ directory, workspaceRoot: options.workspace ?? null });
    else if (command === 'switch-transport') result = await switchTransport({ directory, transport: options.transport, reason: options.reason });
    else if (command === 'unbind') result = await unbindChat({ directory, reason: options.reason });
    else if (command === 'observe-transport') result = await recordTransportObservation({ directory, capability: options.capability, available: options.available === 'true', evidence: options.evidence });
    else if (command === 'protocol-ready') result = await recordProtocolBootstrap({ directory, protocol: options.protocol, evidence: options.evidence });
    else if (command === 'preview-chat-migration') result = await previewChatMigration({ directory, chatRef: options['chat-ref'], chatTitle: options['chat-title'] ?? null, transport: options.transport, reason: options.reason, outputPath: options.output ?? null });
    else if (command === 'apply-chat-migration') result = await applyChatMigration({ directory, previewPath: options.preview });
    else if (command === 'migrate-chat') result = await migrateChat({ directory, chatRef: options['chat-ref'], chatTitle: options['chat-title'] ?? null, transport: options.transport, reason: options.reason });
    else if (command === 'migrate-state') result = await migrateState({ directory, workspaceRoot: options.workspace ?? process.cwd() });
    else if (command === 'recover') result = await recoverState({ directory });
    else throw new Error('expected command: init, status, begin, prepare, sent, app-observe, app-resume, app-repair, result, adopt, receipt, complete, abort, supersede, steer, pause, block, resume, switch-transport, unbind, observe-transport, protocol-ready, preview-chat-migration, apply-chat-migration, migrate-chat, migrate-state, or recover');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (isDirectExecution(import.meta.url)) await main();
