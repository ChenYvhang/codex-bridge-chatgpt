#!/usr/bin/env node

import { isDirectExecution } from './cli-entry.mjs';
import { readFile } from 'node:fs/promises';

const RESPONSE_BUDGETS = {
  plan: 1200,
  artifact: 4000,
  review: 900,
  diagnosis: 1600,
  checkpoint: 1200,
};

function text(value) { return typeof value === 'string' ? value : JSON.stringify(value ?? null); }

export function estimateTokens(value) {
  const source = text(value);
  let units = 0;
  for (const character of source) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) units += 1;
    else if (/\s/u.test(character)) units += 0.08;
    else units += 0.25;
  }
  return Math.max(source.length ? 1 : 0, Math.ceil(units));
}

function lexicalUnits(value) {
  return text(value).toLowerCase().match(/[\p{L}\p{N}_-]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? [];
}

export function duplicateEstimate(current, previous = null) {
  if (previous === null || previous === undefined) return { duplicate_tokens: 0, duplicate_rate: 0 };
  const currentUnits = lexicalUnits(current);
  const counts = new Map();
  for (const unit of lexicalUnits(previous)) counts.set(unit, (counts.get(unit) ?? 0) + 1);
  let overlap = 0;
  for (const unit of currentUnits) {
    const remaining = counts.get(unit) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      counts.set(unit, remaining - 1);
    }
  }
  const rate = currentUnits.length === 0 ? 0 : overlap / currentUnits.length;
  return { duplicate_tokens: overlap, duplicate_rate: Number(rate.toFixed(4)) };
}

function contentProjection(request) {
  if (request?.protocol === 'compact-v1') {
    return {
      objective: request.objective,
      context_delta: request.context_delta,
    };
  }
  return {
    objective: request?.objective,
    context_delta: request?.context_delta,
    local_evidence: request?.local_evidence,
    constraints: request?.constraints,
    expected_outputs: request?.expected_outputs,
  };
}

export function analyzePayload({ request, previousRequest = null, historyTokenEstimate = 0, maxInputTokens = 6000, responseBudget = null }) {
  const requestTokens = estimateTokens(request);
  const contentTokens = estimateTokens(contentProjection(request));
  const protocolTokens = Math.max(0, requestTokens - contentTokens);
  const duplicate = duplicateEstimate(request, previousRequest);
  const suggestedResponseTokens = responseBudget ?? RESPONSE_BUDGETS[request?.profile] ?? 1200;
  return {
    estimator: 'local-heuristic-v1',
    request_tokens: requestTokens,
    content_tokens: contentTokens,
    protocol_tokens: protocolTokens,
    protocol_share: requestTokens === 0 ? 0 : Number((protocolTokens / requestTokens).toFixed(4)),
    duplicate_tokens: duplicate.duplicate_tokens,
    duplicate_rate: duplicate.duplicate_rate,
    avoided_history_tokens: Math.max(0, Number(historyTokenEstimate) || 0),
    suggested_response_tokens: suggestedResponseTokens,
    projected_round_tokens: requestTokens + suggestedResponseTokens,
    max_input_tokens: maxInputTokens,
    budget_status: requestTokens <= maxInputTokens ? 'within_budget' : 'over_budget',
  };
}

export function summarizeCosts(rounds = []) {
  const totals = rounds.reduce((sum, round) => {
    sum.request_tokens += round.request_tokens ?? 0;
    sum.response_tokens += round.response_tokens ?? 0;
    sum.wasted_response_tokens += round.wasted_response_tokens ?? 0;
    sum.protocol_tokens += round.protocol_tokens ?? 0;
    sum.duplicate_tokens += round.duplicate_tokens ?? 0;
    sum.avoided_history_tokens += round.avoided_history_tokens ?? 0;
    return sum;
  }, { request_tokens: 0, response_tokens: 0, wasted_response_tokens: 0, protocol_tokens: 0, duplicate_tokens: 0, avoided_history_tokens: 0 });
  totals.total_tokens = totals.request_tokens + totals.response_tokens + totals.wasted_response_tokens;
  totals.protocol_share = totals.request_tokens === 0 ? 0 : Number((totals.protocol_tokens / totals.request_tokens).toFixed(4));
  return totals;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('usage: token-budget.mjs <input.json>');
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  console.log(JSON.stringify(analyzePayload(input), null, 2));
}

if (isDirectExecution(import.meta.url)) main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
