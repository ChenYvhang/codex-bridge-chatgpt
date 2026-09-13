#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const CAPABILITY_NAMES = [
  'persistent_chat_id', 'read', 'send', 'read_after_write', 'wait', 'structured_result_retrieval',
  'attachment_acquisition', 'model_label_observation', 'user_takeover',
];

const BASELINES = {
  'app-thread': { persistent_chat_id: true, read: false, send: false, read_after_write: false, wait: false, structured_result_retrieval: false, attachment_acquisition: false, model_label_observation: false, user_takeover: false },
  'in-app-browser': { persistent_chat_id: false, read: false, send: false, read_after_write: false, wait: false, structured_result_retrieval: false, attachment_acquisition: false, model_label_observation: true, user_takeover: true },
};

export function negotiateCapabilities(transport, observed = {}) {
  if (!BASELINES[transport]) return { status: 'invalid', errors: ['unknown transport'] };
  const capabilities = {};
  for (const name of CAPABILITY_NAMES) capabilities[name] = typeof observed[name] === 'boolean' ? observed[name] : BASELINES[transport][name];
  return { status: 'ready', transport, capabilities };
}

export function requireCapabilities(negotiated, required) {
  if (negotiated?.status !== 'ready') return { status: 'blocked', missing: required ?? [], reason: 'transport_not_ready' };
  const missing = (required ?? []).filter((name) => !CAPABILITY_NAMES.includes(name) || negotiated.capabilities[name] !== true);
  return missing.length ? { status: 'blocked', missing, reason: 'required_capability_unavailable' } : { status: 'ready', missing: [] };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('usage: transport-capabilities.mjs <input.json>');
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const negotiated = negotiateCapabilities(input.transport, input.observed);
  console.log(JSON.stringify({ negotiated, requirement: requireCapabilities(negotiated, input.required) }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
