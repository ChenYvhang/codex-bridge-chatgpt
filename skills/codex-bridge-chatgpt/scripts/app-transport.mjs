#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DELIVERY_STATES = new Set(['QUEUED', 'DELIVERED', 'GENERATING', 'RETRIEVED', 'RECOVERY_REQUIRED']);

function messageText(item) {
  if (typeof item?.text === 'string') return item.text;
  if (!Array.isArray(item?.content)) return '';
  return item.content.map((part) => typeof part?.text === 'string' ? part.text : '').join('');
}

function matchingTurn(snapshot, idempotencyKey, baselineTurnIds = []) {
  const baseline = new Set(baselineTurnIds);
  return (snapshot?.turns ?? []).find((turn) => {
    if (baseline.has(turn?.id)) return false;
    return (turn?.items ?? []).some((item) => item?.type === 'userMessage' && messageText(item).includes(idempotencyKey));
  });
}

export function createDelivery({ idempotencyKey, baselineTurnIds = [], queuedAt = new Date().toISOString(), pollIntervalMs = 15000, timeoutMs = 180000 }) {
  if (!idempotencyKey?.trim()) throw new Error('idempotency key must be non-empty');
  return {
    status: 'QUEUED',
    idempotency_key: idempotencyKey,
    baseline_turn_ids: [...baselineTurnIds],
    queued_at: queuedAt,
    poll_interval_ms: pollIntervalMs,
    timeout_ms: timeoutMs,
    poll_count: 0,
    last_polled_at: null,
    turn_id: null,
    agent_message_id: null,
  };
}

export function inspectSnapshot(delivery, snapshot, observedAt = new Date().toISOString()) {
  if (!DELIVERY_STATES.has(delivery?.status)) throw new Error('invalid delivery state');
  if (delivery.status === 'RETRIEVED') return { delivery, action: 'persist_result', result_text: null, should_resend: false };
  const next = structuredClone(delivery);
  next.poll_count += 1;
  next.last_polled_at = observedAt;
  const turn = matchingTurn(snapshot, delivery.idempotency_key, delivery.baseline_turn_ids);
  const elapsed = Math.max(0, Date.parse(observedAt) - Date.parse(delivery.queued_at));

  if (!turn) {
    if (elapsed >= delivery.timeout_ms) {
      next.status = 'RECOVERY_REQUIRED';
      next.recovery_reason = 'delivery_not_observed_before_timeout';
      return { delivery: next, action: 'resume_read_later', should_resend: false };
    }
    return { delivery: next, action: 'poll_read', retry_after_ms: delivery.poll_interval_ms, should_resend: false };
  }

  next.turn_id = turn.id ?? null;
  if (turn.error) {
    next.status = 'RECOVERY_REQUIRED';
    next.recovery_reason = 'matching_turn_failed';
    return { delivery: next, action: 'inspect_failure', should_resend: false };
  }

  const response = (turn.items ?? []).find((item) => item?.type === 'agentMessage');
  if (!response || turn.status !== 'completed') {
    next.status = response ? 'GENERATING' : 'DELIVERED';
    return { delivery: next, action: 'poll_read', retry_after_ms: delivery.poll_interval_ms, should_resend: false };
  }

  const resultText = messageText(response);
  if (!resultText.trim()) {
    next.status = 'RECOVERY_REQUIRED';
    next.recovery_reason = 'completed_response_is_empty';
    return { delivery: next, action: 'inspect_failure', should_resend: false };
  }
  next.status = 'RETRIEVED';
  next.agent_message_id = response.id ?? null;
  next.retrieved_at = observedAt;
  return { delivery: next, action: 'persist_result', result_text: resultText, should_resend: false };
}

export function resumeDelivery(delivery) {
  if (delivery?.status !== 'RECOVERY_REQUIRED') return { delivery, action: delivery?.status === 'RETRIEVED' ? 'persist_result' : 'poll_read', should_resend: false };
  const next = structuredClone(delivery);
  next.status = next.turn_id ? 'DELIVERED' : 'QUEUED';
  delete next.recovery_reason;
  return { delivery: next, action: 'poll_read', retry_after_ms: next.poll_interval_ms, should_resend: false };
}

export function prepareRepair(delivery, queuedAt = new Date().toISOString()) {
  if (delivery?.status !== 'RETRIEVED') throw new Error('repair requires a retrieved invalid response');
  if ((delivery.repair_count ?? 0) >= 1) throw new Error('only one app result repair is allowed');
  const baselineTurnIds = new Set(delivery.baseline_turn_ids ?? []);
  if (delivery.turn_id) baselineTurnIds.add(delivery.turn_id);
  const next = {
    ...delivery,
    status: 'QUEUED',
    baseline_turn_ids: [...baselineTurnIds],
    queued_at: queuedAt,
    poll_count: 0,
    last_polled_at: null,
    turn_id: null,
    agent_message_id: null,
    repair_count: (delivery.repair_count ?? 0) + 1,
    repair_of_turn_id: delivery.turn_id ?? null,
  };
  delete next.retrieved_at;
  delete next.recovery_reason;
  return next;
}

async function main() {
  const [command, inputPath] = process.argv.slice(2);
  if (!['create', 'inspect', 'resume', 'repair'].includes(command) || !inputPath) throw new Error('usage: app-transport.mjs <create|inspect|resume|repair> <input.json>');
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const result = command === 'create' ? createDelivery(input)
    : command === 'inspect' ? inspectSnapshot(input.delivery, input.snapshot, input.observed_at)
      : command === 'repair' ? prepareRepair(input.delivery, input.queued_at)
        : resumeDelivery(input.delivery);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
