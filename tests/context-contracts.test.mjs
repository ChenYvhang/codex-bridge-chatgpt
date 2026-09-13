import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  validateAdoptionDecision,
  validateCheckpoint,
  validateContextRequest,
  validateContextResult,
  validateExecutionReceipt,
  validatePair,
} from '../skills/codex-bridge-chatgpt/scripts/validate-context.mjs';

const sha = createHash('sha256').update('content').digest('hex');
const workspace = { fingerprint_id: 'workspace-123', canonical_root: '/workspace' };
const request = {
  schema_version: 2,
  bridge_id: 'bridge-123',
  round: 2,
  idempotency_key: 'idem-123',
  profile: 'artifact',
  objective: 'Draft the design document',
  routing: { route: 'hybrid', reason_codes: ['large_output_cheap_to_verify'], verification_tier: 'targeted' },
  workspace,
  context_delta: 'The user accepted option A.',
  local_evidence: ['src/app.js:start — current entry point'],
  constraints: ['Keep compatibility with Node 18'],
  expected_outputs: ['Complete docs/design.md'],
  checkpoint: null,
};

const result = {
  schema_version: 2,
  bridge_id: 'bridge-123',
  round: 2,
  idempotency_key: 'idem-123',
  profile: 'artifact',
  summary: 'Drafted the requested design.',
  decisions: [{ decision: 'Use JSONL receipts', basis: 'Append-only recovery', confidence: 'high' }],
  artifacts: [{ artifact_id: 'artifact-1', path: 'docs/design.md', media_type: 'text/markdown', encoding: 'utf8', operation: 'create', delivery: 'inline', content: 'content', base_sha256: null, declared_sha256: sha, size: 7 }],
  instructions_for_codex: ['Verify the documented commands locally'],
  questions: [],
  context_update: { proposed_entries: [] },
};

test('accepts a paired schema v2 request and result', () => {
  assert.deepEqual(validateContextRequest(request), []);
  assert.deepEqual(validateContextResult(result), []);
  assert.deepEqual(validatePair(request, result), []);
});

test('rejects mismatched idempotency keys and response profiles', () => {
  const candidate = structuredClone(result);
  candidate.idempotency_key = 'wrong';
  candidate.profile = 'review';
  assert.match(validatePair(request, candidate).join('\n'), /idempotency_key mismatch/);
  assert.match(validatePair(request, candidate).join('\n'), /profile mismatch/);
});

test('requires a result to echo the request conversation scope', () => {
  const scopedRequest = { ...request, conversation_scope_id: sha };
  assert.match(validatePair(scopedRequest, result).join('\n'), /conversation_scope_id mismatch/);
  assert.deepEqual(validatePair(scopedRequest, { ...result, conversation_scope_id: sha }), []);
});

test('rejects traversal, drive-relative, and protected artifact paths', () => {
  for (const path of ['../outside.txt', 'C:outside.txt', '.git/config', '.codex/bridge.json', 'node_modules/x', '.']) {
    const candidate = structuredClone(result);
    candidate.artifacts[0].path = path;
    assert.match(validateContextResult(candidate).join('\n'), /path is unsafe/);
  }
});

test('rejects likely credentials in persistent context', () => {
  const candidate = structuredClone(request);
  candidate.context_delta = 'api_key=sk-abcdefghijklmnopqrstuvwxyz123456';
  assert.match(validateContextRequest(candidate).join('\n'), /likely secret/);
});

test('accepts a structured checkpoint, adoption decision, and receipt', () => {
  const checkpoint = {
    schema_version: 2, bridge_id: 'bridge-123', through_round: 2, objective: 'Ship the bridge', workspace,
    entries: [{ id: 'decision-1', kind: 'decision', value: 'Use JSONL receipts', status: 'accepted', source_round: 2 }],
  };
  const adoption = {
    schema_version: 2, bridge_id: 'bridge-123', round: 2, idempotency_key: 'idem-123', status: 'accepted',
    accepted_artifact_ids: ['artifact-1'], rejected_artifact_ids: [], notes: [], verification_tier: 'targeted',
  };
  const receipt = {
    schema_version: 2, bridge_id: 'bridge-123', round: 2, idempotency_key: 'idem-123', accepted: ['artifact-1'],
    rejected: [], deferred: [], artifacts: [{ artifact_id: 'artifact-1', path: 'docs/design.md', status: 'applied', sha256: sha }],
    checks: ['npm test passed'], implementation_summary: 'Applied and verified the draft.', new_facts: [], open_questions: [],
  };
  assert.deepEqual(validateCheckpoint(checkpoint), []);
  assert.deepEqual(validateAdoptionDecision(adoption), []);
  assert.deepEqual(validateExecutionReceipt(receipt), []);
});

test('keeps legacy schema v1 exchange validation compatible', () => {
  const legacy = {
    schema_version: 1, bridge_id: 'bridge-123', round: 1, mode: 'planning', objective: 'Plan', context_delta: '',
    local_evidence: [], constraints: [], expected_outputs: [], checkpoint: null,
  };
  assert.deepEqual(validateContextRequest(legacy), []);
});
