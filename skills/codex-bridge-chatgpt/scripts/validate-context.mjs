#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTEXT_SCHEMA_VERSION = 2;
export const COMPACT_PROTOCOL = 'compact-v1';
const LEGACY_MODES = new Set(['planning', 'draft_files', 'review', 'reasoning', 'checkpoint']);
const PROFILES = new Set(['plan', 'artifact', 'review', 'diagnosis', 'checkpoint']);
const ROUTES = new Set(['chat', 'codex', 'hybrid']);
const VERIFICATION_TIERS = new Set(['contract_only', 'targeted', 'local_authority', 'full']);
const OPERATIONS = new Set(['create', 'replace', 'merge', 'suggest']);
const DELIVERIES = new Set(['inline', 'attachment']);
const CONFIDENCE = new Set(['high', 'medium', 'low']);
const ENTRY_KINDS = new Set(['goal', 'acceptance', 'decision', 'invariant', 'preference', 'term', 'local_fact', 'artifact', 'open_question']);
const ENTRY_STATUSES = new Set(['accepted', 'open', 'stale', 'rejected', 'resolved']);
const ADOPTION_STATUSES = new Set(['accepted', 'partial', 'rejected']);
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*(?!\[REDACTED\])\S+/i,
];

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hasText(value) { return typeof value === 'string' && value.trim().length > 0; }
function isStringArray(value) { return Array.isArray(value) && value.every((item) => typeof item === 'string'); }
function isSha(value) { return /^[a-f0-9]{64}$/.test(value ?? ''); }
function containsSecret(value) { return SECRET_PATTERNS.some((pattern) => pattern.test(JSON.stringify(value))); }
export function containsLikelySecret(value) { return containsSecret(value); }

function validateIdentity(value, errors, { allowLegacy = true } = {}) {
  if (!isObject(value)) {
    errors.push('envelope must be a JSON object');
    return;
  }
  if (value.schema_version !== CONTEXT_SCHEMA_VERSION && !(allowLegacy && value.schema_version === 1)) {
    errors.push(`schema_version must be ${allowLegacy ? '1 or 2' : CONTEXT_SCHEMA_VERSION}`);
  }
  if (!hasText(value.bridge_id)) errors.push('bridge_id must be non-empty');
  if (value.conversation_scope_id !== undefined && !isSha(value.conversation_scope_id)) errors.push('conversation_scope_id must be a lowercase SHA-256 value');
  if (!Number.isInteger(value.round) || value.round < 1) errors.push('round must be a positive integer');
  if (value.schema_version === 2 && !hasText(value.idempotency_key)) errors.push('idempotency_key must be non-empty');
}

export function safeWorkspacePath(path) {
  if (!hasText(path) || isAbsolute(path)) return false;
  const candidate = normalize(path).replaceAll('\\', '/');
  if (candidate === '.' || candidate === '..' || candidate.startsWith('../')) return false;
  if (/^[a-z]:/i.test(candidate) || candidate.includes('\0')) return false;
  return !['.git', '.codex', 'node_modules'].includes(candidate.split('/')[0].toLowerCase());
}

function validateWorkspace(workspace, errors, prefix = 'workspace', requireRoot = true) {
  if (!isObject(workspace)) return errors.push(`${prefix} must be an object`);
  if (!hasText(workspace.fingerprint_id)) errors.push(`${prefix}.fingerprint_id must be non-empty`);
  if (requireRoot && !hasText(workspace.canonical_root)) errors.push(`${prefix}.canonical_root must be non-empty`);
}

function validateRouting(routing, errors) {
  if (!isObject(routing)) return errors.push('routing must be an object');
  if (!ROUTES.has(routing.route)) errors.push('routing.route is invalid');
  if (!isStringArray(routing.reason_codes) || routing.reason_codes.length === 0) errors.push('routing.reason_codes must be a non-empty array of strings');
  if (!VERIFICATION_TIERS.has(routing.verification_tier)) errors.push('routing.verification_tier is invalid');
}

function validateContextDelta(delta, errors) {
  if (!isObject(delta)) return errors.push('context_delta must be an object for compact-v1');
  for (const field of ['user_intent', 'newly_verified_facts', 'invalidated_facts', 'evidence', 'constraints', 'expected_outputs', 'questions']) {
    if (delta[field] !== undefined && !isStringArray(delta[field])) errors.push(`context_delta.${field} must be an array of strings`);
  }
  if (delta.history_token_estimate !== undefined && (!Number.isInteger(delta.history_token_estimate) || delta.history_token_estimate < 0)) errors.push('context_delta.history_token_estimate must be a non-negative integer');
  for (const [field, roundField] of [['previous_receipt', 'round'], ['checkpoint', 'through_round']]) {
    const anchor = delta[field];
    if (anchor === null || anchor === undefined) continue;
    if (!isObject(anchor)) errors.push(`context_delta.${field} must be null or an object`);
    else {
      if (!Number.isInteger(anchor[roundField]) || anchor[roundField] < 0) errors.push(`context_delta.${field}.${roundField} is invalid`);
      if (!isSha(anchor.sha256)) errors.push(`context_delta.${field}.sha256 is invalid`);
    }
  }
}

export function validateContextRequest(value) {
  const errors = [];
  validateIdentity(value, errors);
  if (value?.schema_version === 1) {
    if (!LEGACY_MODES.has(value.mode)) errors.push('mode is invalid');
  } else {
    if (!PROFILES.has(value?.profile)) errors.push('profile is invalid');
    if (value.protocol === COMPACT_PROTOCOL) {
      if (value.routing !== undefined) validateRouting(value.routing, errors);
      if (value.workspace !== undefined) validateWorkspace(value.workspace, errors, 'workspace', false);
      validateContextDelta(value.context_delta, errors);
    } else {
      validateRouting(value?.routing, errors);
      validateWorkspace(value?.workspace, errors, 'workspace', false);
    }
  }
  if (!hasText(value?.objective)) errors.push('objective must be non-empty');
  if (value?.protocol !== COMPACT_PROTOCOL) {
    if (typeof value?.context_delta !== 'string') errors.push('context_delta must be a string');
    for (const field of ['local_evidence', 'constraints', 'expected_outputs']) {
      if (!isStringArray(value?.[field])) errors.push(`${field} must be an array of strings`);
    }
  }
  if (value?.checkpoint !== null && value?.checkpoint !== undefined) {
    if (!isObject(value.checkpoint)) errors.push('checkpoint must be null or an object');
    else {
      if (!Number.isInteger(value.checkpoint.through_round) || value.checkpoint.through_round < 0) errors.push('checkpoint.through_round is invalid');
      if (!isSha(value.checkpoint.sha256)) errors.push('checkpoint.sha256 is invalid');
    }
  }
  if (containsSecret(value)) errors.push('request contains a likely secret');
  return errors;
}

function validateCompactResult(value, errors) {
  if (value.protocol !== COMPACT_PROTOCOL) errors.push(`protocol must be ${COMPACT_PROTOCOL}`);
  if (!isStringArray(value.questions)) errors.push('questions must be an array of strings');
  const update = value.context_update;
  if (!isObject(update) || !Array.isArray(update.proposed_entries)) errors.push('context_update.proposed_entries must be an array');

  if (['plan', 'review', 'diagnosis'].includes(value.profile)) {
    if (!Array.isArray(value.decisions)) errors.push('decisions must be an array');
    else value.decisions.forEach((entry, index) => validateDecision(entry, errors, index));
  } else if (value.decisions !== undefined) {
    if (!Array.isArray(value.decisions)) errors.push('decisions must be an array');
    else value.decisions.forEach((entry, index) => validateDecision(entry, errors, index));
  }

  if (value.profile === 'review' && !isStringArray(value.findings)) errors.push('findings must be an array of strings for review');
  if (value.profile === 'diagnosis' && !isStringArray(value.hypotheses)) errors.push('hypotheses must be an array of strings for diagnosis');
  if (value.profile === 'artifact') {
    if (!Array.isArray(value.artifacts)) errors.push('artifacts must be an array for artifact');
    else value.artifacts.forEach((entry, index) => validateArtifact(entry, errors, index));
    if (!isStringArray(value.instructions_for_codex)) errors.push('instructions_for_codex must be an array of strings for artifact');
  }
}

function validateDecision(entry, errors, index) {
  if (!isObject(entry) || !hasText(entry.decision) || !hasText(entry.basis)) errors.push(`decisions[${index}] is invalid`);
  if (!CONFIDENCE.has(entry?.confidence)) errors.push(`decisions[${index}].confidence is invalid`);
}

function validateArtifact(entry, errors, index, legacy = false) {
  const prefix = legacy ? `files[${index}]` : `artifacts[${index}]`;
  if (!isObject(entry)) return errors.push(`${prefix} is invalid`);
  if (!legacy && !hasText(entry.artifact_id)) errors.push(`${prefix}.artifact_id must be non-empty`);
  if (!safeWorkspacePath(entry.path)) errors.push(`${prefix}.path is unsafe`);
  const operation = legacy ? entry.action : entry.operation;
  if (!OPERATIONS.has(operation) || (legacy && operation === 'merge')) errors.push(`${prefix}.${legacy ? 'action' : 'operation'} is invalid`);
  if (!DELIVERIES.has(entry.delivery)) errors.push(`${prefix}.delivery is invalid`);
  if (entry.delivery === 'inline' && typeof entry.content !== 'string') errors.push(`${prefix}.content is required for inline delivery`);
  if (entry.delivery === 'attachment' && !hasText(entry.attachment_name)) errors.push(`${prefix}.attachment_name is required for attachment delivery`);
  if (!legacy) {
    if (!hasText(entry.media_type)) errors.push(`${prefix}.media_type must be non-empty`);
    if (!hasText(entry.encoding)) errors.push(`${prefix}.encoding must be non-empty`);
    if (['replace', 'merge'].includes(operation) && entry.base_sha256 !== null && !isSha(entry.base_sha256)) errors.push(`${prefix}.base_sha256 is invalid`);
    if (entry.declared_sha256 !== null && entry.declared_sha256 !== undefined && !isSha(entry.declared_sha256)) errors.push(`${prefix}.declared_sha256 is invalid`);
    if (!Number.isInteger(entry.size) || entry.size < 0) errors.push(`${prefix}.size is invalid`);
  }
}

export function validateContextResult(value) {
  const errors = [];
  validateIdentity(value, errors);
  if (value?.schema_version === 2 && !PROFILES.has(value.profile)) errors.push('profile is invalid');
  if (!hasText(value?.summary)) errors.push('summary must be non-empty');
  if (value?.schema_version === 2 && value?.protocol === COMPACT_PROTOCOL) {
    validateCompactResult(value, errors);
    if (containsSecret(value)) errors.push('result contains a likely secret');
    return errors;
  }
  if (!Array.isArray(value?.decisions)) errors.push('decisions must be an array');
  else value.decisions.forEach((entry, index) => validateDecision(entry, errors, index));
  const artifacts = value?.schema_version === 1 ? value?.files : value?.artifacts;
  const field = value?.schema_version === 1 ? 'files' : 'artifacts';
  if (!Array.isArray(artifacts)) errors.push(`${field} must be an array`);
  else artifacts.forEach((entry, index) => validateArtifact(entry, errors, index, value.schema_version === 1));
  for (const name of ['instructions_for_codex', 'questions']) if (!isStringArray(value?.[name])) errors.push(`${name} must be an array of strings`);
  const update = value?.context_update;
  if (!isObject(update)) errors.push('context_update must be an object');
  else if (value?.schema_version === 1) {
    for (const name of ['durable_decisions', 'invariants', 'open_questions', 'artifact_notes']) if (!isStringArray(update[name])) errors.push(`context_update.${name} must be an array of strings`);
  } else if (!Array.isArray(update.proposed_entries)) errors.push('context_update.proposed_entries must be an array');
  if (containsSecret(value)) errors.push('result contains a likely secret');
  return errors;
}

function validateLedgerEntry(entry, errors, index) {
  const prefix = `entries[${index}]`;
  if (!isObject(entry)) return errors.push(`${prefix} must be an object`);
  if (!hasText(entry.id)) errors.push(`${prefix}.id must be non-empty`);
  if (!ENTRY_KINDS.has(entry.kind)) errors.push(`${prefix}.kind is invalid`);
  if (!hasText(entry.value)) errors.push(`${prefix}.value must be non-empty`);
  if (!ENTRY_STATUSES.has(entry.status)) errors.push(`${prefix}.status is invalid`);
  if (!Number.isInteger(entry.source_round) || entry.source_round < 0) errors.push(`${prefix}.source_round is invalid`);
  if (entry.kind === 'local_fact' && entry.status !== 'stale' && (!isObject(entry.freshness) || !hasText(entry.freshness.workspace_fingerprint))) {
    errors.push(`${prefix}.freshness is required for a current local_fact`);
  }
}

export function validateCheckpoint(value) {
  const errors = [];
  if (!isObject(value)) return ['checkpoint must be a JSON object'];
  if (![1, 2].includes(value.schema_version)) errors.push('schema_version must be 1 or 2');
  if (!hasText(value.bridge_id)) errors.push('bridge_id must be non-empty');
  if (!Number.isInteger(value.through_round) || value.through_round < 0) errors.push('through_round is invalid');
  if (!hasText(value.objective)) errors.push('objective must be non-empty');
  if (value.schema_version === 1) {
    for (const field of ['acceptance', 'decisions', 'invariants', 'open_questions', 'artifacts']) if (!Array.isArray(value[field])) errors.push(`${field} must be an array`);
    if (typeof value.last_verified_local_state !== 'string') errors.push('last_verified_local_state must be a string');
  } else {
    validateWorkspace(value.workspace, errors);
    if (!Array.isArray(value.entries)) errors.push('entries must be an array');
    else value.entries.forEach((entry, index) => validateLedgerEntry(entry, errors, index));
  }
  if (containsSecret(value)) errors.push('checkpoint contains a likely secret');
  return errors;
}

export function validateAdoptionDecision(value) {
  const errors = [];
  validateIdentity(value, errors, { allowLegacy: false });
  if (!ADOPTION_STATUSES.has(value?.status)) errors.push('status is invalid');
  for (const field of ['accepted_artifact_ids', 'rejected_artifact_ids', 'notes']) if (!isStringArray(value?.[field])) errors.push(`${field} must be an array of strings`);
  if (!VERIFICATION_TIERS.has(value?.verification_tier)) errors.push('verification_tier is invalid');
  if (containsSecret(value)) errors.push('adoption contains a likely secret');
  return errors;
}

export function validateExecutionReceipt(value) {
  const errors = [];
  validateIdentity(value, errors);
  const fields = value?.schema_version === 1
    ? ['accepted', 'rejected', 'deferred', 'changed_files', 'checks', 'new_facts', 'open_questions']
    : ['accepted', 'rejected', 'deferred', 'artifacts', 'checks', 'new_facts', 'open_questions'];
  for (const field of fields) if (!Array.isArray(value?.[field])) errors.push(`${field} must be an array`);
  if (!hasText(value?.implementation_summary)) errors.push('implementation_summary must be non-empty');
  if (containsSecret(value)) errors.push('receipt contains a likely secret');
  return errors;
}

export function validatePair(request, result) {
  const errors = [
    ...validateContextRequest(request).map((error) => `request: ${error}`),
    ...validateContextResult(result).map((error) => `result: ${error}`),
  ];
  if (request?.bridge_id !== result?.bridge_id) errors.push('bridge_id mismatch');
  if (request?.conversation_scope_id !== undefined && request.conversation_scope_id !== result?.conversation_scope_id) errors.push('conversation_scope_id mismatch');
  if (request?.round !== result?.round) errors.push('round mismatch');
  if (request?.schema_version === 2 && request.idempotency_key !== result?.idempotency_key) errors.push('idempotency_key mismatch');
  if (request?.schema_version === 2 && request.profile !== result?.profile) errors.push('profile mismatch');
  if (request?.protocol === COMPACT_PROTOCOL && result?.protocol !== COMPACT_PROTOCOL) errors.push('protocol mismatch');
  return errors;
}

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }

async function main() {
  const [mode, firstPath, secondPath] = process.argv.slice(2);
  try {
    if (!['request', 'result', 'pair', 'checkpoint', 'receipt', 'adoption'].includes(mode) || !firstPath) throw new Error('usage: validate-context.mjs <request|result|checkpoint|receipt|adoption> <file> | pair <request> <result>');
    const first = await readJson(firstPath);
    let errors;
    if (mode === 'request') errors = validateContextRequest(first);
    else if (mode === 'result') errors = validateContextResult(first);
    else if (mode === 'checkpoint') errors = validateCheckpoint(first);
    else if (mode === 'receipt') errors = validateExecutionReceipt(first);
    else if (mode === 'adoption') errors = validateAdoptionDecision(first);
    else {
      if (!secondPath) throw new Error('pair requires request and result files');
      errors = validatePair(first, await readJson(secondPath));
    }
    if (errors.length) {
      errors.forEach((error) => console.error(`ERROR: ${error}`));
      process.exitCode = 1;
    } else console.log(`OK: valid ${mode}`);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
