#!/usr/bin/env node

import { isDirectExecution } from './cli-entry.mjs';
import { readFile } from 'node:fs/promises';

const LEVELS = new Set(['low', 'medium', 'high']);
const SENSITIVITY = new Set(['public', 'project', 'sensitive', 'secret']);
const OVERRIDES = new Set(['auto', 'chat', 'codex', 'hybrid']);

export function routeTask(input) {
  const errors = [];
  for (const field of ['computer_dependency', 'context_value', 'output_weight', 'verification_need']) {
    if (!LEVELS.has(input?.[field])) errors.push(`${field} must be low, medium, or high`);
  }
  if (!SENSITIVITY.has(input?.sensitivity)) errors.push('sensitivity is invalid');
  if (!OVERRIDES.has(input?.override ?? 'auto')) errors.push('override is invalid');
  if (errors.length) return { status: 'invalid', errors };

  const override = input.override ?? 'auto';
  const allowedToSend = input.sensitivity !== 'secret'
    && (input.sensitivity !== 'sensitive' || input.sensitive_transmission_authorized === true);
  if (!allowedToSend) {
    return {
      status: 'routed',
      route: 'codex',
      reason_codes: [input.sensitivity === 'secret' ? 'secret_never_sent' : 'sensitive_authorization_required'],
      verification_tier: 'local_authority',
    };
  }
  if (override !== 'auto') {
    return {
      status: 'routed',
      route: override,
      reason_codes: ['user_override'],
      verification_tier: override === 'chat' ? 'contract_only' : 'targeted',
    };
  }

  const reasons = [];
  let route;
  if (input.computer_dependency === 'high') {
    route = input.output_weight === 'high' && input.verification_need !== 'high' ? 'hybrid' : 'codex';
    reasons.push('computer_dependency_high');
  } else if (input.context_value === 'high' && input.computer_dependency === 'low') {
    route = input.verification_need === 'high' ? 'hybrid' : 'chat';
    reasons.push('persistent_context_high_value');
  } else if (input.output_weight === 'high' && input.verification_need !== 'high') {
    route = 'hybrid';
    reasons.push('large_output_cheap_to_verify');
  } else if (input.verification_need === 'high') {
    route = 'codex';
    reasons.push('verification_cost_high');
  } else {
    route = 'codex';
    reasons.push('local_execution_cheaper');
  }
  return {
    status: 'routed',
    route,
    reason_codes: reasons,
    verification_tier: route === 'chat' ? 'contract_only' : route === 'hybrid' ? 'targeted' : 'local_authority',
  };
}

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('usage: route-task.mjs <routing-input.json>');
  const result = routeTask(JSON.parse(await readFile(path, 'utf8')));
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'invalid') process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
